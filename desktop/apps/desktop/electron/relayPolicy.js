'use strict';
// ============================================================================
// relayPolicy.js — which relay new away-from-home connections are offered.
// ----------------------------------------------------------------------------
// Four modes (Settings > Your Beebo address > Relay):
//   off                   direct connections only (the default)
//   own                   Cloudflare only (the owner's own Cloudflare account),
//                         or "your own relay only" for their own TURN server.
//                         Beebo Relay is never offered in this mode.
//   cloudflare_then_beebo my Cloudflare until it has carried switchAtGB (950)
//                         this month, then Beebo Relay
//   beebo_only            Beebo Relay only
//
// The answer is a provider ORDER the host agent tries for each NEW connection
// ('cloudflare' | 'custom' | 'beebo'); a connection already playing keeps the
// relay it started on (see "Relay credentials" in beebo-rtc-host.js for why).
//
// Hysteresis: once switched to Beebo in a month, it stays switched unless the
// Cloudflare figure falls back below switchAtGB - HYSTERESIS_GB (possible only
// when a correction lowers it). Beebo Relay being briefly unreachable doesn't
// change the order either: the agent falls back to Cloudflare for that one
// connection and retries Beebo after a pause. So nothing flaps near 950.
//
// Pure functions: no store, no Electron. relayController.js does the wiring.
// ============================================================================

const { GB, effectiveBytes } = require('./relayMeter');

const MODES = ['off', 'own', 'cloudflare_then_beebo', 'beebo_only'];
const HYSTERESIS_GB = 25;
const GUIDE_URL = 'https://www.beeboentertainment.com/own-relay.html';

const FREE_BADGE = 'Included in away plan';
const markupLabel = (pct) => (Number(pct) > 0 ? `our cost plus ${pct}% markup` : 'at cost, 0% markup');

// The words for each mode. Beebo Relay wording follows relay-pricing.json:
// while it is free nothing is "charged"; a price is only an estimate.
// Without prices (older callers) the words assume free, the published state.
function modeInfo(id, { pricing, ownKind } = {}) {
  const free = !pricing || pricing.free !== false;
  const cf = (pricing && pricing.cloudflare) || { freeGBPerMonth: 1000, pricePerGB: 0.05 };
  const cur = (pricing && pricing.currency) || 'USD';
  const pct = pricing && pricing.beebo ? pricing.beebo.payAsYouGoMarkupPercent : 0;
  switch (id) {
    case 'off':
      return { label: 'Off (direct only)', explain: 'Viewers connect straight to this computer. If their connection can’t reach it, they can’t watch.', guide: 'direct' };
    case 'own':
      return ownKind === 'turn'
        ? { label: 'Your own relay only', explain: 'Connections that can’t go direct use your own TURN server. Your video never passes through Beebo’s servers. Your provider bills you for what it carries.', guide: 'cloudflare' }
        : { label: 'Cloudflare only (your own Cloudflare account)', explain: `Your video uses your own Cloudflare account when a direct connection isn’t possible. It never passes through Beebo’s servers. Cloudflare’s own pricing applies (first ${gbText(cf.freeGBPerMonth)} a month free, then Cloudflare bills you ${money(cf.pricePerGB, cur)}/GB).`, guide: 'cloudflare' };
    case 'cloudflare_then_beebo':
      return {
        label: 'My Cloudflare first, then Beebo Relay',
        explain: `Uses your Cloudflare while it’s inside its free allowance, then moves new connections to Beebo Relay for the rest of the month.${free ? ' Beebo Relay is included with the away-from-home household plan.' : ''}`,
        guide: 'cloudflare_then_beebo', badge: free ? FREE_BADGE : '', free,
      };
    case 'beebo_only':
      return free
        ? { label: 'Beebo Relay only', explain: 'Connections that can’t go direct use Beebo Relay, included with the CA$3/month away-from-home household plan for up to 6 people including the owner. There is no extra relay charge. At-home use is free.', guide: 'relay', badge: FREE_BADGE, free, highlight: true }
        : { label: 'Beebo Relay only', explain: `Connections that can’t go direct use Beebo Relay, charged per GB on your Beebo account (${markupLabel(pct)}).`, guide: 'relay', badge: '', free, highlight: true };
    default:
      return { label: String(id), explain: '', guide: '' };
  }
}

// ---------------------------------------------------------------------------
// The wallet hook. The switch-over asks this before offering Beebo Relay.
// With no hook: allowed. main.js installs walletClient.allowed(), which checks
// the prepaid balance or the owner's pay-as-you-go consent (walletClient.js).
let allowedHook = null;
function setBeeboRelayAllowedHook(fn) { allowedHook = typeof fn === 'function' ? fn : null; }
// -> { allowed: boolean, reason: string }   reason e.g. 'balance_empty', 'no_consent'
function beeboRelayAllowed(ctx = {}) {
  if (!allowedHook) return { allowed: true, reason: '' };
  // Free at this time: no balance or pay-as-you-go consent is needed. The
  // Beebo service still decides who gets relay credentials (worker/relay.js).
  if (ctx && ctx.pricing && ctx.pricing.free === true) return { allowed: true, reason: '' };
  try {
    const r = allowedHook(ctx);
    if (r === true || r === false) return { allowed: r, reason: r ? '' : 'not_allowed' };
    return { allowed: !!(r && r.allowed), reason: String((r && r.reason) || (r && r.allowed ? '' : 'not_allowed')) };
  } catch (_) {
    return { allowed: false, reason: 'check_failed' };
  }
}

function normalizeMode(m, hasOwnRelay) {
  if (MODES.includes(m)) return m;
  // Before modes existed, having an own relay meant using it.
  return hasOwnRelay ? 'own' : 'off';
}

// Why Beebo Relay can't be used, in plain English.
const BEEBO_REASON_TEXT = {
  not_offered: 'Beebo Relay isn’t available yet',
  relay_not_enabled: 'Beebo Relay isn’t turned on for your account',
  relay_suspended: 'Beebo Relay is paused on your account',
  no_active_subscription: 'Beebo Relay needs an active Beebo subscription',
  relay_cap_reached: 'your Beebo Relay monthly limit has been reached',
  relay_not_configured: 'Beebo Relay is being set up',
  unauthorized: 'this computer needs to sign in to Beebo again',
  unreachable: 'Beebo Relay couldn’t be reached',
  balance_empty: 'your Beebo Relay balance is empty',
  no_consent: 'pay as you go isn’t turned on',
  not_allowed: 'Beebo Relay isn’t allowed on your account right now',
  check_failed: 'Beebo couldn’t check your Beebo Relay balance',
  wallet_empty: 'your Beebo Relay balance is used up',
  wallet_topup_pending: 'Beebo Relay is paused until your top-up arrives',
  wallet_cloudflare_only: 'you chose your own Cloudflare only once your Beebo Relay balance ran out',
  wallet_unreachable: 'Beebo couldn’t check your Beebo Relay balance',
};
// A wallet reason: no balance and no consent. Beebo Relay pauses, and relaying
// falls back to the owner's own Cloudflare if it's set up, else direct only.
const isWalletReason = (code) => /^wallet_/.test(String(code || ''));
const beeboReasonText = (code) => BEEBO_REASON_TEXT[code] || 'Beebo Relay isn’t available';

/**
 * Decide the provider order for new connections.
 * @param {object} a
 * @param {string} a.mode
 * @param {string|null} a.ownKind      'cloudflare' | 'turn' | null  (the saved own relay)
 * @param {object} a.usage             relayMeter state (this month)
 * @param {object} a.pricing           relayPricing.parsePricing() result
 * @param {object} [a.beebo]           { available: true|false|null, error }
 * @param {object} [a.allowed]         beeboRelayAllowed() result
 * @param {number} a.now
 * @returns {{ order: string[], policy: object, events: object[], state: object }}
 */
function decide({ mode, ownKind, usage, pricing, beebo = {}, allowed = { allowed: true, reason: '' }, now }) {
  const policy = Object.assign({ onBeebo: false, switchedAt: 0, payingCloudflareSince: 0, lastUnavailableNoticeAt: 0 }, (usage && usage.policy) || {});
  const events = [];
  const cfGB = effectiveBytes(usage, 'cloudflare') / GB;
  const own = ownKind === 'cloudflare' ? 'cloudflare' : ownKind === 'turn' ? 'custom' : null;
  let order = [];
  let status = { code: 'direct', beeboBlocked: '' };

  if (mode === 'own') {
    order = own ? [own] : [];
    status = { code: own ? 'own' : 'own_not_set_up', beeboBlocked: '' };
  } else if (mode === 'beebo_only') {
    if (allowed.allowed) { order = ['beebo']; status = { code: beebo.available === false ? 'beebo_unavailable' : 'beebo', beeboBlocked: beebo.available === false ? (beebo.error || 'unreachable') : '' }; }
    else if (isWalletReason(allowed.reason) && own === 'cloudflare') { order = ['cloudflare']; status = { code: 'wallet_cloudflare', beeboBlocked: allowed.reason }; }
    else { order = []; status = { code: 'beebo_not_allowed', beeboBlocked: allowed.reason || 'not_allowed' }; }
  } else if (mode === 'cloudflare_then_beebo') {
    const switchAt = pricing.cloudflare.switchAtGB;
    if (own !== 'cloudflare') {
      // Nothing of theirs to use first.
      order = allowed.allowed ? ['beebo'] : [];
      status = { code: 'cloudflare_not_set_up', beeboBlocked: allowed.allowed ? '' : allowed.reason };
    } else {
      const past = policy.onBeebo ? cfGB >= switchAt - HYSTERESIS_GB : cfGB >= switchAt;
      if (!past) {
        if (policy.onBeebo) events.push({ type: 'back_to_cloudflare', cfGB });
        policy.onBeebo = false;
        policy.payingCloudflareSince = 0;
        order = ['cloudflare'];
        status = { code: 'cloudflare_free', beeboBlocked: '' };
      } else {
        const blocked = !allowed.allowed ? (allowed.reason || 'not_allowed') : (beebo.available === false ? (beebo.error || 'unreachable') : '');
        if (allowed.allowed) {
          // Beebo first; the agent keeps Cloudflare for a connection only if Beebo can't give credentials.
          order = ['beebo', 'cloudflare'];
          if (!policy.onBeebo) { policy.onBeebo = true; policy.switchedAt = now; events.push({ type: 'switched_to_beebo', cfGB }); }
        } else {
          order = ['cloudflare'];
          if (policy.onBeebo) { policy.onBeebo = false; }
        }
        if (blocked) {
          if (!policy.payingCloudflareSince) policy.payingCloudflareSince = now;
          // One notice per reason every 6 hours at most.
          if (now - (policy.lastUnavailableNoticeAt || 0) > 6 * 3600 * 1000 || policy.lastUnavailableReason !== blocked) {
            policy.lastUnavailableNoticeAt = now;
            policy.lastUnavailableReason = blocked;
            events.push({ type: 'beebo_unavailable_paying_cloudflare', reason: blocked, cfGB });
          }
          status = { code: 'cloudflare_paid', beeboBlocked: blocked };
        } else {
          policy.payingCloudflareSince = 0;
          policy.lastUnavailableReason = '';
          status = { code: 'beebo', beeboBlocked: '' };
        }
      }
    }
  }
  return { order, policy, events, status };
}

const money = (n, cur = 'USD') => (cur === 'USD' ? '$' : cur + ' ') + (n < 1 && n > 0 ? n.toFixed(2) : n.toFixed(2));
const gbText = (gb) => (gb >= 100 ? Math.round(gb).toLocaleString('en-US') : gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)) + ' GB';

function eventText(e, pricing) {
  const cur = pricing.currency;
  if (e.type === 'switched_to_beebo') {
    return {
      title: 'Relay moved to Beebo Relay',
      body: `Your Cloudflare relay has carried ${gbText(e.cfGB)} this month, so new connections that need a relay now use Beebo Relay (${pricing.free ? 'included with your away plan' : money(pricing.beebo.payAsYouGoPricePerGB, cur) + '/GB'}). Films already playing finish where they are.`,
      mentions: ['cloudflare'],
    };
  }
  if (e.type === 'beebo_unavailable_paying_cloudflare') {
    return {
      title: 'Relay staying on your Cloudflare',
      body: `${beeboReasonText(e.reason)}, so relayed connections stay on your Cloudflare. Past ${gbText(pricing.cloudflare.freeGBPerMonth)} this month Cloudflare charges you ${money(pricing.cloudflare.pricePerGB, cur)}/GB.`,
      mentions: ['cloudflare'],
    };
  }
  if (e.type === 'back_to_cloudflare') {
    return { title: 'Relay back on your Cloudflare', body: 'New connections that need a relay use your Cloudflare again.', mentions: ['cloudflare'] };
  }
  return { title: 'Relay', body: '', mentions: [] };
}

/**
 * The object Settings shows. In "Beebo Relay only" mode there is deliberately
 * no Cloudflare anything: no figures, no allowance, no Cloudflare log lines.
 */
function settingsModel({ mode, ownKind, usage, pricing, pricingSource, status, beebo = {}, log = [], now }) {
  const cur = pricing.currency;
  const cfGB = effectiveBytes(usage, 'cloudflare') / GB;
  const beeboGB = effectiveBytes(usage, 'beebo') / GB;
  const customGB = effectiveBytes(usage, 'custom') / GB;
  const hdGB = pricing.gbPerHour.hd * 2;   // a two-hour film in HD, one viewer
  const beeboPrice = pricing.beebo.payAsYouGoPricePerGB;
  const resetDate = new Date(usage.periodEnd).toISOString().slice(0, 10);

  const model = {
    mode,
    modes: MODES.map((id) => Object.assign({ id }, modeInfo(id, { pricing, ownKind }))),
    free: !!pricing.free,
    pricing: publicPricing(pricing),
    guideUrl: GUIDE_URL,
    currency: cur,
    period: { start: new Date(usage.periodStart).toISOString().slice(0, 10), resetDate, resetDay: usage.resetDay },
    pricingSource,
    status: status ? status.code : 'direct',
    notice: '',
    example: '',
    log: [],
  };

  const showCloudflare = mode === 'own' || mode === 'cloudflare_then_beebo';
  const showBeebo = mode === 'beebo_only' || mode === 'cloudflare_then_beebo';

  if (showCloudflare && ownKind === 'cloudflare') {
    const reported = usage.reported && usage.reported.cloudflare;
    const over = Math.max(0, cfGB - pricing.cloudflare.freeGBPerMonth);
    model.cloudflare = {
      gb: round3(cfGB),
      freeGB: pricing.cloudflare.freeGBPerMonth,
      switchAtGB: mode === 'cloudflare_then_beebo' ? pricing.cloudflare.switchAtGB : null,
      pricePerGB: pricing.cloudflare.pricePerGB,
      estimatedCost: round2(over * pricing.cloudflare.pricePerGB),
      fromCloudflare: !!(reported && reported.bytes >= (usage.bytes.cloudflare || 0)),
      payingCloudflare: !!(status && status.code === 'cloudflare_paid'),
    };
  }
  if (showCloudflare && ownKind === 'turn') model.custom = { gb: round3(customGB) };
  if (showBeebo) {
    model.beebo = {
      gb: round3(beeboGB),
      pricePerGB: beeboPrice,
      prepaidPricePerGB: pricing.beebo.prepaidPricePerGB,
      costPerGB: pricing.beebo.costPerGB,
      markupPercent: pricing.beebo.payAsYouGoMarkupPercent,
      markupLabel: markupLabel(pricing.beebo.payAsYouGoMarkupPercent),
      // This month's use at the current prices ("if fees start later" while free).
      estimatedCost: round2(beeboGB * beeboPrice),
      // What is actually charged: nothing while Beebo Relay is free.
      free: !!pricing.free,
      chargedCost: pricing.free ? 0 : round2(beeboGB * beeboPrice),
      planned: pricing.status === 'planned',
      unavailable: status && status.beeboBlocked ? beeboReasonText(status.beeboBlocked) : '',
    };
  }

  // One plain-English line on what's happening now.
  const code = model.status;
  if (mode === 'off') model.notice = 'No relay. Viewers whose connection can’t reach this computer directly can’t watch.';
  else if (code === 'own') model.notice = ownKind === 'turn' ? 'Relayed connections use your own TURN server.' : 'Relayed connections use your Cloudflare.';
  else if (code === 'own_not_set_up') model.notice = 'Enter your relay details below to use this.';
  else if (code === 'cloudflare_free') model.notice = `Relayed connections use your Cloudflare until it has carried ${gbText(pricing.cloudflare.switchAtGB)} this month.`;
  else if (code === 'cloudflare_paid') model.notice = `${beeboReasonText(status.beeboBlocked)}, so relayed connections stay on your Cloudflare, which charges ${money(pricing.cloudflare.pricePerGB, cur)}/GB past ${gbText(pricing.cloudflare.freeGBPerMonth)}.`;
  else if (code === 'cloudflare_not_set_up') model.notice = 'Your Cloudflare relay isn’t set up, so relayed connections use Beebo Relay.';
  else if (code === 'beebo') model.notice = mode === 'beebo_only' ? 'Relayed connections use Beebo Relay.' : 'Your Cloudflare has carried its share this month; new relayed connections use Beebo Relay until the month resets.';
  else if (code === 'wallet_cloudflare') model.notice = `${capitalize(beeboReasonText(status.beeboBlocked))}, so relayed connections use your own Cloudflare for now.`;
  else if (code === 'beebo_unavailable' || code === 'beebo_not_allowed') model.notice = `${beeboReasonText(status.beeboBlocked)}, so viewers who can’t connect directly can’t watch right now.`;

  // "What this would cost".
  const beeboLine = `about ${money(hdGB * beeboPrice, cur)} through Beebo Relay`;
  const atCost = markupLabel(pricing.beebo.payAsYouGoMarkupPercent);
  if (mode === 'beebo_only') {
    model.example = pricing.free
      ? `Example: a 2-hour HD film for one relayed viewer uses about ${gbText(hdGB)}. Beebo Relay is included with your away-from-home household plan, with no extra relay charge.`
      : `Example: a 2-hour HD film for one relayed viewer uses about ${gbText(hdGB)}, ${beeboLine}.`;
  } else if (mode === 'cloudflare_then_beebo') {
    model.example = pricing.free
      ? `Example: a 2-hour HD film for one relayed viewer uses about ${gbText(hdGB)}: inside your Cloudflare allowance, then included Beebo Relay after the switch. Your own provider’s charges remain separate.`
      : `Example: a 2-hour HD film for one relayed viewer uses about ${gbText(hdGB)}: free inside your Cloudflare allowance, or ${beeboLine} after the switch.`;
  }
  else if (mode === 'own' && ownKind === 'cloudflare') model.example = `Example: a 2-hour HD film for one relayed viewer uses about ${gbText(hdGB)}: free inside Cloudflare’s ${gbText(pricing.cloudflare.freeGBPerMonth)} a month, then about ${money(hdGB * pricing.cloudflare.pricePerGB, cur)} at Cloudflare’s rate.`;
  else if (mode === 'own') model.example = `Example: a 2-hour HD film for one relayed viewer uses about ${gbText(hdGB)} of your relay’s data.`;

  model.log = (Array.isArray(log) ? log : [])
    .filter((e) => !(mode === 'beebo_only' && Array.isArray(e.mentions) && e.mentions.includes('cloudflare')))
    .slice(0, 20)
    .map((e) => ({ at: e.at, title: e.title, body: e.body }));
  if (beebo && beebo.usage && showBeebo && typeof beebo.usage.gb === 'number') model.beebo.meteredByBeeboGB = beebo.usage.gb;
  return model;
}

// The prices the renderer's cost comparison needs (src/lib/connectionCosts.js).
function publicPricing(p) {
  if (!p || !p.beebo || !p.cloudflare) return null;
  return {
    version: p.version, currency: p.currency, status: p.status, free: !!p.free, includedWithSubscription: !!p.includedWithSubscription, subscriptionMonthly: p.subscriptionMonthly, subscriptionCurrency: p.subscriptionCurrency, householdMaxMembers: p.householdMaxMembers, updatedAt: p.updatedAt,
    beebo: { costPerGB: p.beebo.costPerGB, payAsYouGoMarkupPercent: p.beebo.payAsYouGoMarkupPercent, payAsYouGoPricePerGB: p.beebo.payAsYouGoPricePerGB },
    cloudflare: Object.assign({}, p.cloudflare),
    gbPerHour: Object.assign({}, p.gbPerHour),
    ads: p.ads ? Object.assign({}, p.ads) : null,
  };
}

// Static words, for callers without prices.
const MODE_INFO = Object.fromEntries(MODES.map((id) => [id, modeInfo(id)]));

const capitalize = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

module.exports = {
  MODES, MODE_INFO, HYSTERESIS_GB, GUIDE_URL, FREE_BADGE,
  modeInfo, markupLabel, publicPricing,
  normalizeMode, decide, settingsModel, eventText, beeboReasonText, isWalletReason,
  beeboRelayAllowed, setBeeboRelayAllowedHook,
};
