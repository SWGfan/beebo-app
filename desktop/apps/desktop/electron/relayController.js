'use strict';
// ============================================================================
// relayController.js — ties relay metering, prices and the switch-over together.
// ----------------------------------------------------------------------------
//   host agent --relayUsage/relayStatus--> this --relayPlan--> host agent
//                                           |
//                                           +-- app store: relayUsage (this month),
//                                           |   relayMode, relayResetDay, relayLog
//                                           +-- Settings (getModel), notifications
//
// Store keys:
//   relayMode            'off' | 'own' | 'cloudflare_then_beebo' | 'beebo_only'
//   relayResetDay        1-28, the day the billing month starts (UTC); default 1
//   relayUsage           relayMeter.js state for the current month
//   relayLog             newest-first switch notices shown in Settings (max 50)
//   cloudflareAnalytics  { accountId } for the optional reconciliation; its API
//                        token is the OS-encrypted secret 'cloudflareAnalyticsToken'
// ============================================================================

const meter = require('./relayMeter');
const policy = require('./relayPolicy');
const walletModel = require('./walletModel');

const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const RECONCILE_MS = 6 * 3600 * 1000;
const TICK_MS = 5 * 60 * 1000;
const LOG_MAX = 50;

// Cloudflare's own count of TURN egress for one key over a date range, from its
// GraphQL Analytics API (dataset callsTurnUsageAdaptiveGroups, sum.egressBytes,
// per https://developers.cloudflare.com/realtime/turn/analytics/). Needs the
// account ID and an API token with Account Analytics Read: the TURN key's own
// token can't read analytics. -> bytes (number) or throws.
async function fetchCloudflareTurnEgress({ accountId, apiToken, keyId, from, to }, fetchImpl) {
  const query = 'query TurnEgress($accountTag: string!, $keyId: string!, $from: Date!, $to: Date!) {' +
    ' viewer { accounts(filter: { accountTag: $accountTag }) {' +
    ' callsTurnUsageAdaptiveGroups(limit: 10000, filter: { date_geq: $from, date_leq: $to, keyId: $keyId }) { sum { egressBytes } } } } }';
  const res = await (fetchImpl || fetch)(CF_GRAPHQL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiToken, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { accountTag: accountId, keyId, from, to } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('cloudflare_analytics_http_' + res.status);
  const j = await res.json();
  if (j && Array.isArray(j.errors) && j.errors.length) throw new Error('cloudflare_analytics_error');
  const accounts = j && j.data && j.data.viewer && j.data.viewer.accounts;
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('cloudflare_analytics_no_account');
  let total = 0;
  for (const g of accounts[0].callsTurnUsageAdaptiveGroups || []) {
    const v = Number(g && g.sum && g.sum.egressBytes);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.pricing          createPricingSource()
 * @param {function} deps.getOwnRelay    () => { kind: 'cloudflare'|'turn', keyId? } | null   (no secrets needed)
 * @param {function} deps.getRemoteHost  () => remoteHost (setRelayPlan)
 * @param {function} [deps.notify]       ({ title, body }) => void
 * @param {object} [deps.wallet]         walletClient.js (Beebo Relay balance), optional
 * @param {function} [deps.fetch]
 * @param {function} [deps.now]
 */
function createRelayController(deps) {
  const { store, pricing, getOwnRelay, getRemoteHost, notify, fetch: fetchImpl, now = Date.now, log, wallet } = deps;
  let beebo = { available: null, error: '', at: 0 };
  let lastStatus = null;
  let analytics = { at: 0, error: '' };
  let timers = [];
  const say = (m) => { try { if (typeof log === 'function') log(m); } catch (_) {} };

  const ownRelay = () => { try { return getOwnRelay() || null; } catch (_) { return null; } };
  const ownKind = () => { const r = ownRelay(); return r && (r.kind === 'cloudflare' || r.kind === 'turn') ? r.kind : null; };
  const resetDay = () => meter.clampResetDay(store.get('relayResetDay') || 1);
  // Never picked a relay mode, and no relay of their own: follow the account.
  // The agent asks Beebo Relay for credentials when a viewer connects; Beebo
  // only hands them out when Beebo Relay is switched on AND turned on for this
  // account (and the wallet allows it), so for everyone else nothing changes:
  // the Worker says no and connections stay direct. Once it says yes, Settings
  // shows "Beebo Relay only" (the truth), and picking "Off" opts out for good.
  const followsAccount = () => !policy.MODES.includes(store.get('relayMode')) && !ownKind();
  const mode = () => {
    const m = policy.normalizeMode(store.get('relayMode'), !!ownKind());
    return m === 'off' && followsAccount() && beebo.available === true ? 'beebo_only' : m;
  };
  const usageNow = () => meter.normalize(store.get(meter.STORE_KEY), now(), resetDay());
  const saveUsage = (u) => store.set(meter.STORE_KEY, u);

  function appendLog(entry) {
    const list = Array.isArray(store.get('relayLog')) ? store.get('relayLog') : [];
    list.unshift(entry);
    store.set('relayLog', list.slice(0, LOG_MAX));
  }

  function evaluate() {
    const p = pricing.current().pricing;
    const u = usageNow();
    const m = mode();
    const allowed = m === 'off' || m === 'own' ? { allowed: false, reason: '' } : policy.beeboRelayAllowed({ mode: m, usage: u, pricing: p });
    const d = policy.decide({ mode: m, ownKind: ownKind(), usage: u, pricing: p, beebo, allowed, now: now() });
    if (m === 'off' && followsAccount()) {
      // Keep asking (the agent paces refusals) so the account being turned on is noticed.
      const a = policy.beeboRelayAllowed({ mode: 'beebo_only', usage: u, pricing: p });
      if (a.allowed) d.order = ['beebo'];
    }
    u.policy = d.policy;
    saveUsage(u);
    lastStatus = d.status;
    for (const e of d.events) {
      const t = policy.eventText(e, p);
      appendLog({ at: now(), type: e.type, title: t.title, body: t.body, mentions: t.mentions });
      say('[relay] ' + t.title);
      if (typeof notify === 'function') { try { notify({ title: t.title, body: t.body }); } catch (_) {} }
    }
    try {
      const rh = getRemoteHost && getRemoteHost();
      if (rh && typeof rh.setRelayPlan === 'function') rh.setRelayPlan({ order: d.order });
    } catch (_) {}
    return d;
  }

  function onAgentMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'relayUsage' && msg.deltas && typeof msg.deltas === 'object') {
      saveUsage(meter.addUsage(store.get(meter.STORE_KEY), msg.deltas, now(), resetDay()));
      evaluate();
      return;
    }
    if (msg.type === 'relayStatus') {
      if (msg.beebo && typeof msg.beebo === 'object') {
        beebo = { available: !!msg.beebo.available, error: String(msg.beebo.error || '').slice(0, 40), at: now() };
        // Refused for a wallet reason (balance used up, or a choice changed elsewhere): look at the balance again.
        if (wallet && policy.isWalletReason(beebo.error)) { try { wallet.refreshSoon(); } catch (_) {} }
      }
      // Beebo Relay's own meter runs by calendar month (UTC); it only lines up
      // with ours when the reset day is the 1st.
      if (msg.beeboUsage && /^\d{4}-\d{2}$/.test(String(msg.beeboUsage.month)) && resetDay() === 1) {
        saveUsage(meter.setReported(store.get(meter.STORE_KEY), 'beebo', msg.beeboUsage.bytes, msg.beeboUsage.month + '-01', now(), 1));
      }
      evaluate();
    }
  }

  async function reconcileCloudflare(force = false) {
    const r = ownRelay();
    const cfg = store.get('cloudflareAnalytics') || {};
    const token = store.get('cloudflareAnalyticsToken');
    if (!r || r.kind !== 'cloudflare' || !r.keyId || !cfg.accountId || !token) return null;
    if (!force && now() - analytics.at < RECONCILE_MS) return null;
    analytics.at = now();
    const u = usageNow();
    const today = new Date(now()).toISOString().slice(0, 10);
    try {
      const bytes = await fetchCloudflareTurnEgress({ accountId: cfg.accountId, apiToken: token, keyId: r.keyId, from: u.periodKey, to: today }, fetchImpl);
      saveUsage(meter.setReported(store.get(meter.STORE_KEY), 'cloudflare', bytes, u.periodKey, now(), resetDay()));
      analytics.error = '';
      evaluate();
      return bytes;
    } catch (e) {
      analytics.error = String((e && e.message) || 'error').replace(/[^a-z0-9_]/gi, '_').slice(0, 60);
      return null;
    }
  }

  function getModel() {
    const src = pricing.current();
    if (!lastStatus) evaluate();
    const u = usageNow();
    const m = mode();
    const model = policy.settingsModel({
      mode: m, ownKind: ownKind(), usage: u, pricing: src.pricing, pricingSource: src.source,
      status: lastStatus, beebo, log: store.get('relayLog') || [], now: now(),
    });
    model.ownKind = ownKind() || 'off';
    if (wallet) {
      try { model.wallet = walletModel.walletSettingsModel({ state: wallet.getState(), pricing: src.pricing, usage: u, mode: m, ownKind: ownKind(), now: now() }); } catch (_) { model.wallet = null; }
    }
    if (m === 'own' || m === 'cloudflare_then_beebo') {
      const cfg = store.get('cloudflareAnalytics') || {};
      model.analytics = { accountId: String(cfg.accountId || ''), hasToken: !!store.get('cloudflareAnalyticsToken'), error: analytics.error, checkedAt: analytics.at };
    }
    return model;
  }

  function setMode(next) {
    if (!policy.MODES.includes(next)) return { ok: false, error: 'Pick one of the relay options.' };
    store.set('relayMode', next);
    evaluate();
    return { ok: true };
  }

  function setResetDay(day) {
    const d = Math.floor(Number(day));
    if (!(d >= 1 && d <= 28)) return { ok: false, error: 'Choose a day from 1 to 28.' };
    store.set('relayResetDay', d);
    evaluate();
    return { ok: true };
  }

  function setAnalytics({ accountId, apiToken } = {}) {
    const id = String(accountId || '').trim();
    if (id && !/^[a-f0-9]{32}$/i.test(id)) return { ok: false, error: 'The account ID is the 32-character ID on your Cloudflare dashboard.' };
    if (!id) { store.delete('cloudflareAnalytics'); store.delete('cloudflareAnalyticsToken'); return { ok: true }; }
    store.set('cloudflareAnalytics', { accountId: id });
    const tok = String(apiToken || '').trim();
    if (tok) {
      if (tok.length > 512) return { ok: false, error: 'That token does not look right.' };
      store.set('cloudflareAnalyticsToken', tok);
    }
    analytics = { at: 0, error: '' };
    reconcileCloudflare(true).catch(() => {});
    return { ok: true };
  }

  function start() {
    stop();
    pricing.refresh().then(() => evaluate()).catch(() => {});
    evaluate();
    const tick = setInterval(() => {
      try { evaluate(); } catch (_) {}
      pricing.refresh().catch(() => {});
      reconcileCloudflare().catch(() => {});
    }, TICK_MS);
    if (tick.unref) tick.unref();
    timers.push(tick);
    const first = setTimeout(() => { reconcileCloudflare().catch(() => {}); }, 60 * 1000);
    if (first.unref) first.unref();
    timers.push(first);
  }
  function stop() { for (const t of timers) { clearInterval(t); clearTimeout(t); } timers = []; }

  return { evaluate, onAgentMessage, reconcileCloudflare, getModel, setMode, setResetDay, setAnalytics, start, stop };
}

module.exports = { createRelayController, fetchCloudflareTurnEgress };
