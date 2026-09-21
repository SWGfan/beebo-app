'use strict';
// ============================================================================
// walletClient.js — the Beebo Relay prepaid wallet, seen from this computer.
// ----------------------------------------------------------------------------
// Asks the Worker's GET /wallet/me (with this computer's licence token) every
// ten minutes, and sooner when the host agent reports a wallet refusal. Fills
// relayPolicy's beeboRelayAllowed() hook from the answer, synchronously, from
// the last answer it has.
//
// Fail-safe, never a surprise charge:
//   /wallet/me 404            the wallet isn't switched on at Beebo: Beebo Relay
//                             is offered as before (nothing is billed per GB)
//   answer: allowed           allowed (prepaid balance, or the owner's own
//                             pay-as-you-go consent)
//   answer: not allowed       not allowed, with the Worker's reason
//   unreachable / error       allowed ONLY if the last good answer (under an
//                             hour old) had a prepaid balance. Pay-as-you-go
//                             consent is never assumed from a stale answer.
//                             Otherwise: not allowed, 'wallet_unreachable'.
//                             Beebo Relay pauses exactly as if nobody had chosen
//                             at $0: the owner's Cloudflare if set up, or direct.
//
// Desktop notifications at 25%, 10% and $0: once per crossing. The Worker
// numbers each downward crossing (warning.seq); the last one notified is kept
// in the store under 'walletNotified'.
//
// Store keys: walletCache { at, me } (balances and ledger, no secrets),
//             walletNotified { key }
// ============================================================================

const REFRESH_MS = 10 * 60 * 1000;
const CACHE_TRUST_MS = 60 * 60 * 1000;
const SOON_MS = 5000;
const CACHE_KEY = 'walletCache';
const NOTIFIED_KEY = 'walletNotified';

const money = (n) => '$' + Number(n || 0).toFixed(2);
const rate = (n) => '$' + Number(n || 0).toFixed(4);

// state: { kind: 'unknown' | 'off' | 'ok' | 'error', me?, error?, at }
// cached: { at, me } | null
function decideAllowed(state, cached, nowMs) {
  if (state && state.kind === 'off') return { allowed: true, reason: '' };
  if (state && state.kind === 'ok' && state.me && state.me.relay) {
    return state.me.relay.allowed ? { allowed: true, reason: '' } : { allowed: false, reason: String(state.me.relay.reason || 'wallet_empty') };
  }
  if (state && state.kind === 'error' && state.error === 'unauthorized') return { allowed: false, reason: 'unauthorized' };
  const me = cached && cached.me;
  const fresh = cached && nowMs - Number(cached.at || 0) <= CACHE_TRUST_MS && Number(cached.at || 0) <= nowMs;
  if (fresh && me && me.relay && me.relay.allowed && me.relay.paying === 'prepaid') return { allowed: true, reason: '' };
  return { allowed: false, reason: 'wallet_unreachable' };
}

function notificationFor(me) {
  if (!me || me.role !== 'owner' || !me.warning || !me.relay || !me.relay.usesBeeboRelay) return null;
  const level = me.warning.level;
  const seq = Number(me.warning.seq) || 0;
  if (!seq || !(level === 'empty' || /^low\d+$/.test(level))) return null;
  const bal = me.balance ? money(me.balance.amount) : '';
  const hours = me.estimate ? me.estimate.hoursHDLeft : 0;
  const hoursText = `about ${hours} hour${hours === 1 ? '' : 's'} of HD`;
  const percents = (me.pricing && me.pricing.lowBalanceWarnPercents) || [25, 10];
  const lowest = 'low' + Math.min(...percents);
  let title, body;
  if (level === 'empty') {
    if (me.relay.paying === 'payg') {
      title = 'Beebo Relay: pay as you go is on';
      body = `Your balance is used up. As you chose, Beebo Relay carries on at ${rate(me.pricing && me.pricing.payAsYouGoPricePerGB)}/GB on your monthly bill.`;
    } else if (me.relay.reason === 'wallet_cloudflare_only') {
      title = 'Beebo Relay balance used up';
      body = 'As you chose, relayed viewing now uses your own Cloudflare only.';
    } else {
      title = 'Beebo Relay paused';
      body = 'Your Beebo Relay balance is used up, so it’s paused and nothing is charged. Open Settings to top up or choose what happens next.';
    }
  } else if (level === lowest) {
    title = `Beebo Relay: ${hoursText} left`;
    body = `Your balance is ${bal}. When it runs out Beebo Relay pauses, unless you top up or choose pay as you go in Settings.`;
  } else {
    title = 'Beebo Relay balance low';
    body = `${bal} left, ${hoursText}. Top up in Settings whenever suits you.`;
  }
  return { key: level + ':' + seq, title, body };
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {function} deps.getToken      () => licence token
 * @param {function|string} deps.backendUrl
 * @param {function} [deps.fetch]
 * @param {function} [deps.now]
 * @param {function} [deps.notify]      ({ title, body }) => void
 * @param {function} [deps.onChange]    called when allowed/reason changes
 * @param {function} [deps.log]
 */
function createWalletClient(deps) {
  const { store, getToken, fetch: fetchImpl, now = Date.now, notify, onChange, log } = deps;
  const base = () => String((typeof deps.backendUrl === 'function' ? deps.backendUrl() : deps.backendUrl) || '').replace(/\/+$/, '');
  let state = { kind: 'unknown', at: 0 };
  let timer = null;
  let soon = null;
  let inflight = null;
  let lastDecision = '';
  const say = (m) => { try { if (typeof log === 'function') log(m); } catch (_) {} };

  const cached = () => { try { const c = store.get(CACHE_KEY); return c && c.me ? c : null; } catch (_) { return null; } };

  function allowed() {
    try { return decideAllowed(state, cached(), now()); } catch (_) { return { allowed: false, reason: 'check_failed' }; }
  }

  async function request(path, init = {}) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const token = getToken && getToken();
    if (!token) return { status: 401, body: null };
    if (!base() || !f) return { status: 0, body: null };
    const headers = Object.assign({ authorization: 'Bearer ' + token, accept: 'application/json' }, init.body ? { 'content-type': 'application/json' } : {});
    const res = await f(base() + path, Object.assign({}, init, { headers, signal: AbortSignal.timeout(15000) }));
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    return { status: res.status, body };
  }

  function afterUpdate() {
    const d = allowed();
    const key = d.allowed + ':' + d.reason;
    if (key !== lastDecision) {
      lastDecision = key;
      say('[wallet] Beebo Relay ' + (d.allowed ? 'allowed' : 'not allowed (' + d.reason + ')'));
      if (typeof onChange === 'function') { try { onChange(d); } catch (_) {} }
    }
    if (state.kind === 'ok') maybeNotify(state.me);
  }

  function maybeNotify(me) {
    const n = notificationFor(me);
    if (!n) return false;
    const prev = (store.get(NOTIFIED_KEY) || {}).key;
    if (prev === n.key) return false;
    store.set(NOTIFIED_KEY, { key: n.key, at: now() });
    if (typeof notify === 'function') { try { notify({ title: n.title, body: n.body }); } catch (_) {} }
    return true;
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await request('/wallet/me');
        if (r.status === 200 && r.body && r.body.enabled && r.body.relay) {
          state = { kind: 'ok', me: r.body, at: now() };
          store.set(CACHE_KEY, { at: now(), me: r.body });
        } else if (r.status === 404) {
          state = { kind: 'off', at: now() };
        } else if (r.status === 401) {
          state = { kind: 'error', error: 'unauthorized', at: now() };
        } else {
          state = { kind: 'error', error: r.status ? 'http_' + r.status : 'not_configured', at: now() };
        }
      } catch (_) {
        state = { kind: 'error', error: 'unreachable', at: now() };
      }
      afterUpdate();
      return state;
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  // The host agent was refused Beebo Relay for a wallet reason: look again soon.
  function refreshSoon() {
    if (soon) return;
    soon = setTimeout(() => { soon = null; refresh().catch(() => {}); }, SOON_MS);
    if (soon.unref) soon.unref();
  }

  async function topUp(amount) {
    const r = await request('/wallet/topup', { method: 'POST', body: JSON.stringify({ amount: Number(amount) }) }).catch(() => ({ status: 0 }));
    if (r.status === 200 && r.body && typeof r.body.url === 'string' && /^https:\/\/checkout\.stripe\.com\//.test(r.body.url)) return { ok: true, url: r.body.url };
    if (r.status === 402) return { ok: false, error: 'Top-ups need an active Beebo subscription.' };
    if (r.status === 404) return { ok: false, error: 'Top-ups aren’t available yet.' };
    return { ok: false, error: 'Couldn’t start the payment. Check your connection and try again.' };
  }

  async function setChoice(choice, remember) {
    const r = await request('/wallet/choice', { method: 'POST', body: JSON.stringify({ choice: choice || null, remember: !!remember }) }).catch(() => ({ status: 0 }));
    if (r.status === 200 && r.body && r.body.state) {
      state = { kind: 'ok', me: r.body.state, at: now() };
      store.set(CACHE_KEY, { at: now(), me: r.body.state });
      afterUpdate();
      return { ok: true };
    }
    if (r.status === 409) return { ok: false, error: 'Pay as you go is added to your monthly Beebo subscription, and this account doesn’t have one.' };
    return { ok: false, error: 'Couldn’t save your choice. Check your connection and try again.' };
  }

  function getState() {
    const c = cached();
    return { kind: state.kind, error: state.error || '', at: state.at, me: state.kind === 'ok' ? state.me : null, cached: c, allowed: allowed() };
  }

  function start() {
    stop();
    refresh().catch(() => {});
    timer = setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; if (soon) clearTimeout(soon); soon = null; }

  return { allowed, refresh, refreshSoon, topUp, setChoice, getState, maybeNotify, start, stop };
}

module.exports = { createWalletClient, decideAllowed, notificationFor, CACHE_TRUST_MS, REFRESH_MS };
