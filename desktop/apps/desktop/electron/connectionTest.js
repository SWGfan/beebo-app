'use strict';
// ============================================================================
// connectionTest.js — the PC side of the Connection wizard and Settings > Connection.
// ----------------------------------------------------------------------------
//   A. Watch at home: streamServer tells us about every request (onLanRequest);
//      while a home test is running, the first one from ANOTHER device on the
//      local network counts. Nothing is kept but the time and a device word
//      ("phone", "iPhone"...): no address is stored, in memory or on disk.
//   B. Watch away from home: the host agent reports each viewer connection
//      (open: direct or relay, and which relay; failed: never got through).
//      The last 20 are kept in memory, with no viewer id.
//   C. The owner's choice, and Beebo Relay on or off for the account:
//      POST /relay/opt-in | /relay/opt-out on the Beebo service with this PC's
//      licence token (worker/relay.js), then the local relay mode to match.
//
// Store key 'connectionSetup' (shape: src/lib/connectionModel.js normalizeSetup).
// ============================================================================

const SETUP_KEY = 'connectionSetup';
const EVENTS_MAX = 20;
const TEST_KINDS = ['home', 'away'];

// 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, IPv6 ULA fc00::/7 and link-local fe80::/10.
function isPrivateLan(ip) {
  const a = String(ip || '').replace(/^::ffff:/i, '').toLowerCase();
  if (!a) return false;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a)) return true;
  return false;
}

// A device word from the User-Agent, for "Your iPhone connected".
function deviceWord(ua) {
  const u = String(ua || '');
  if (/okhttp|BeeboEntertainment|Beebo\//i.test(u)) return 'phone';
  if (/iPhone/i.test(u)) return 'iPhone';
  if (/iPad/i.test(u)) return 'iPad';
  if (/Android/i.test(u)) return /Mobile/i.test(u) ? 'phone' : 'tablet';
  if (/CrKey|SMART-TV|Tizen|Web0S|BRAVIA|AFT/i.test(u)) return 'TV';
  if (/Windows|Macintosh|Linux|CrOS/i.test(u)) return 'computer';
  return '';
}

const pickSetup = (raw) => {
  const s = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (['new', 'in_progress', 'skipped', 'done'].includes(s.state)) out.state = s.state;
  if (['home', 'away', 'result'].includes(s.step)) out.step = s.step;
  if (s.homeOk !== undefined) out.homeOk = !!s.homeOk;
  if (s.lastResult && typeof s.lastResult === 'object' && ['direct_ok', 'relay_ok', 'blocked'].includes(s.lastResult.outcome)) {
    out.lastResult = { outcome: s.lastResult.outcome, at: Number(s.lastResult.at) || Date.now(), provider: String(s.lastResult.provider || '').replace(/[^a-z]/g, '').slice(0, 20) };
  }
  return out;
};

// What the Beebo service said, as one short code the renderer turns into words.
function relayErrorCode(status, body) {
  if (status === 0) return 'unreachable';
  if (status === 404) return 'not_available';
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'no_active_subscription';
  if (status === 409) return 'terms_changed';
  const e = body && typeof body.error === 'string' ? body.error : '';
  if (e === 'relay_suspended') return 'relay_suspended';
  return e ? e.replace(/[^a-z_]/g, '').slice(0, 40) : 'http_' + status;
}

/**
 * @param {object} deps
 * @param {object} deps.store                electron-store
 * @param {function} deps.getToken           () => licence token or ''
 * @param {function} deps.backendUrl         () => 'https://...' Beebo service base
 * @param {function} [deps.getOwnAddresses]  () => ['192.168.1.20', ...] this computer's LAN addresses
 * @param {function} [deps.getRelayController] () => relayController (setMode), optional
 * @param {function} [deps.fetch]
 * @param {function} [deps.now]
 */
function createConnectionTest(deps) {
  const { store, getToken, backendUrl, getOwnAddresses, getRelayController, fetch: fetchImpl, now = Date.now } = deps;
  const tests = { home: { since: 0, seenAt: 0, device: '' }, away: { since: 0 } };
  let events = [];

  const base = () => String((typeof backendUrl === 'function' ? backendUrl() : backendUrl) || '').replace(/\/+$/, '');
  const ownIps = () => { try { return (getOwnAddresses && getOwnAddresses()) || []; } catch (_) { return []; } };

  function getSetup() {
    const s = store.get(SETUP_KEY);
    return s && typeof s === 'object' ? s : {};
  }
  function saveSetup(partial) {
    const next = Object.assign({}, getSetup(), pickSetup(partial));
    store.set(SETUP_KEY, next);
    return next;
  }

  // streamServer: every request. Cheap unless a home test is waiting.
  function onLanRequest({ ip, ua, remote } = {}) {
    const t = tests.home;
    if (!t.since || t.seenAt >= t.since || remote) return false;
    const a = String(ip || '').replace(/^::ffff:/i, '');
    if (!isPrivateLan(a) || ownIps().includes(a)) return false;
    t.seenAt = now();
    t.device = deviceWord(ua);
    saveSetup({ homeOk: true });
    return true;
  }

  // Host agent: { state: 'open'|'failed'|'closed', path, provider }
  function onConnection(m) {
    if (!m || (m.state !== 'open' && m.state !== 'failed')) return;
    events.unshift({
      at: now(),
      state: m.state,
      path: m.path === 'relay' ? 'relay' : 'direct',
      provider: String(m.provider || '').replace(/[^a-z]/g, '').slice(0, 20),
    });
    events = events.slice(0, EVENTS_MAX);
  }

  function start(kind) {
    if (!TEST_KINDS.includes(kind)) return { ok: false };
    if (kind === 'home') tests.home = { since: now(), seenAt: 0, device: '' };
    else tests.away = { since: now() };
    const s = getSetup();
    if (s.state !== 'done') saveSetup({ state: 'in_progress', step: kind });
    return { ok: true, since: kind === 'home' ? tests.home.since : tests.away.since };
  }

  function snapshot() {
    return {
      setup: getSetup(),
      home: Object.assign({}, tests.home),
      away: { since: tests.away.since, events: events.map((e) => Object.assign({}, e)) },
      now: now(),
    };
  }

  async function call(path, body) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const token = getToken && getToken();
    if (!token) return { status: -1, body: null };
    if (!base() || !f) return { status: 0, body: null };
    try {
      const res = await f(base() + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: Object.assign({ authorization: 'Bearer ' + token, accept: 'application/json' }, body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      let j = null;
      try { j = await res.json(); } catch (_) { j = null; }
      return { status: res.status, body: j };
    } catch (_) {
      return { status: 0, body: null };
    }
  }

  const rc = () => { try { return (getRelayController && getRelayController()) || null; } catch (_) { return null; } };
  const relayMode = () => { try { return store.get('relayMode'); } catch (_) { return undefined; } };

  // Beebo Relay on, for the account and on this computer.
  async function relayOptIn(termsVersion) {
    const r = await call('/relay/opt-in', { termsVersion: String(termsVersion || '') });
    if (r.status === -1) return { ok: false, error: 'signed_out' };
    if (r.status !== 200 || !r.body || !r.body.enabled) return { ok: false, error: relayErrorCode(r.status, r.body) };
    // "My Cloudflare first, then Beebo Relay" already includes Beebo Relay; anything else becomes Beebo Relay only.
    const c = rc();
    if (relayMode() !== 'cloudflare_then_beebo') {
      if (c && typeof c.setMode === 'function') c.setMode('beebo_only'); else store.set('relayMode', 'beebo_only');
    }
    const acceptedAt = (r.body.optIn && Number(r.body.optIn.acceptedAt)) || Math.floor(now() / 1000);
    store.set(SETUP_KEY, Object.assign({}, getSetup(), { choice: 'relay', relayAcceptedAt: acceptedAt, relayTermsVersion: String((r.body.optIn && r.body.optIn.termsVersion) || termsVersion || '') }));
    return { ok: true, relay: relayInfoFrom(r.body) };
  }

  const setMode = (m) => {
    const c = rc();
    if (c && typeof c.setMode === 'function') c.setMode(m); else store.set('relayMode', m);
  };

  // "Cloudflare only": the owner's own Cloudflare account, never Beebo Relay.
  // The PC switches first (relay mode 'own' never asks Beebo for relay
  // credentials), then Beebo Relay is turned off for the whole account
  // (POST /relay/opt-out), so viewers' devices don't get Beebo Relay either.
  // 404 = Beebo Relay isn't switched on at Beebo at all, which is fine too.
  async function chooseCloudflareOnly() {
    setMode('own');
    const r = await call('/relay/opt-out', {});
    if (r.status === -1) return { ok: false, error: 'signed_out', modeSet: true };
    if (r.status !== 200 && r.status !== 404) return { ok: false, error: relayErrorCode(r.status, r.body), modeSet: true };
    store.set(SETUP_KEY, Object.assign({}, getSetup(), { choice: 'cloudflare' }));
    return { ok: true, relay: r.status === 200 && r.body ? relayInfoFrom(r.body) : null };
  }

  // The owner picked "Open ports" or "Home only". Beebo Relay goes off only if
  // they had turned it on here; a relay set up some other way is left alone.
  async function choose(choice) {
    if (choice === 'cloudflare') return chooseCloudflareOnly();
    if (choice !== 'ports' && choice !== 'home_only') return { ok: false, error: 'bad_choice' };
    const s = getSetup();
    if (s.choice === 'cloudflare' && relayMode() === 'own') setMode('off');
    if (s.choice === 'relay') {
      const r = await call('/relay/opt-out', {});
      if (r.status !== 200 && r.status !== 404 && r.status !== -1) return { ok: false, error: relayErrorCode(r.status, r.body) };
      if (relayMode() === 'beebo_only') {
        const c = rc();
        if (c && typeof c.setMode === 'function') c.setMode('off'); else store.set('relayMode', 'off');
      }
    }
    store.set(SETUP_KEY, Object.assign({}, getSetup(), { choice }));
    return { ok: true };
  }

  function relayInfoFrom(b) {
    const usage = b.usage || {};
    return {
      enabled: !!b.enabled,
      suspended: !!b.suspended,
      free: !!b.free,
      month: String(usage.month || b.month || ''),
      gb: Number(usage.usedGB !== undefined ? usage.usedGB : b.gb) || 0,
      capGB: Number(usage.capGB !== undefined ? usage.capGB : b.capGB) || 0,
      optIn: b.optIn || null,
      ...(b.lifetimeGB !== undefined ? { lifetimeGB: Number(b.lifetimeGB) || 0 } : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(String(b.resetsOn || '')) ? { resetsOn: String(b.resetsOn) } : {}),
    };
  }

  // --- "Help us plan Beebo Relay": the optional payment survey (worker/relaySurvey.js).
  // "Not now" hides it on this computer for 30 days (store key relaySurveyHiddenUntil).
  const SURVEY_HIDE_MS = 30 * 86400 * 1000;
  const SURVEY_CHOICE_IDS = ['card_prepaid', 'card_monthly', 'ads', 'mix', 'not_sure'];
  const hiddenUntil = () => { try { return Number(store.get('relaySurveyHiddenUntil')) || 0; } catch (_) { return 0; } };

  async function survey() {
    const r = await call('/relay/survey/me');
    const base = { hiddenUntil: hiddenUntil(), now: now() };
    if (r.status === -1) return Object.assign(base, { error: 'signed_out', answer: null });
    if (r.status !== 200 || !r.body) return Object.assign(base, { error: relayErrorCode(r.status, r.body), answer: null });
    return Object.assign(base, { answer: r.body.answer || null });
  }

  async function surveySend(choice, comment) {
    if (!SURVEY_CHOICE_IDS.includes(choice)) return { ok: false, error: 'bad_choice' };
    const text = typeof comment === 'string' ? Array.from(comment).slice(0, 300).join('') : '';
    const r = await call('/relay/survey', { choice, comment: text });
    if (r.status === -1) return { ok: false, error: 'signed_out' };
    if (r.status === 429) return { ok: false, error: 'rate_limited' };
    if (r.status !== 200 || !r.body || !r.body.ok) return { ok: false, error: relayErrorCode(r.status, r.body) };
    try { store.delete('relaySurveyHiddenUntil'); } catch (_) {}
    return { ok: true, answer: r.body.answer || null };
  }

  function surveyLater() {
    const until = now() + SURVEY_HIDE_MS;
    store.set('relaySurveyHiddenUntil', until);
    return { ok: true, hiddenUntil: until };
  }

  async function relayInfo() {
    const r = await call('/relay/usage/me');
    if (r.status === 404) return { unavailable: true };
    if (r.status === -1) return { error: 'signed_out' };
    if (r.status !== 200 || !r.body) return { error: relayErrorCode(r.status, r.body) };
    return relayInfoFrom(r.body);
  }

  return { onLanRequest, onConnection, start, snapshot, saveSetup, getSetup, relayOptIn, choose, chooseCloudflareOnly, relayInfo, survey, surveySend, surveyLater };
}

module.exports = { createConnectionTest, isPrivateLan, deviceWord, relayErrorCode, SETUP_KEY };
