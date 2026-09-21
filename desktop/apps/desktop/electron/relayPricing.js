'use strict';
// ============================================================================
// relayPricing.js — relay prices, from beeboentertainment.com, never hard-coded.
// ----------------------------------------------------------------------------
// Source of truth: https://www.beeboentertainment.com/relay-pricing.json
// (version 4; versions 2-3 are still read). Fetched at most every 12 hours,
// cached in the app store, and a bundled copy (relay-pricing.fallback.json,
// taken from the same file) is used when neither the site nor the cache gives
// a valid file. Version 4 added a `tiers` array (two away-from-home quality
// tiers); the flat fields this parser reads (subscriptionMonthly etc.) still
// describe tier[0] for compatibility, so no other change was needed here.
//
//   price per GB = costPerGB x (1 + markupPercent / 100)
//   pay as you go uses payAsYouGoMarkupPercent, prepaid uses prepaidMarkupPercent.
//   A markup that is missing counts as 0: Beebo's policy is at cost, no markup.
//
// Free at this time: "freeAtThisTime": true or "status": "free". Then nothing
// is charged (chargedPricePerGB 0), and the prices above are only shown as
// "if fees start later" estimates.
// ============================================================================

const PRICING_URL = 'https://www.beeboentertainment.com/relay-pricing.json';
const SUPPORTED_VERSION = 4;
const SUPPORTED_VERSIONS = [2, 3, 4];
const REFRESH_MS = 12 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const CACHE_KEY = 'relayPricingCache';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const round6 = (n) => Math.round(n * 1e6) / 1e6;

function pricePerGB(costPerGB, markupPercent) {
  if (num(costPerGB) === null || num(markupPercent) === null) return null;
  return round6(costPerGB * (1 + markupPercent / 100));
}

// A top-up of at least minAmount gets bonusPercent extra; highest matching tier.
function topUpBonus(amount, tiers) {
  let best = 0;
  for (const t of tiers || []) if (amount >= t.minAmount && t.bonusPercent > best) best = t.bonusPercent;
  return Math.round(amount * best) / 100;
}

// The shape the app uses, or null when the file isn't a usable version 2 or 3.
// Readers ignore fields they don't know (the file's own rule).
function parsePricing(json) {
  let j = json;
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch (_) { return null; } }
  if (!j || typeof j !== 'object' || !SUPPORTED_VERSIONS.includes(j.version)) return null;
  const b = j.beeboRelay || {};
  const cf = j.cloudflare || {};
  const costPerGB = num(b.costPerGB);
  // Missing markup = 0% (at cost). Present but not a number >= 0 = a broken file.
  const pct = (v) => (v === undefined ? 0 : num(v));
  const payg = pct(b.payAsYouGoMarkupPercent);
  const prepaid = pct(b.prepaidMarkupPercent);
  const freeGB = num(cf.freeGBPerMonth);
  const switchAtGB = num(cf.switchAtGB);
  const cfPrice = num(cf.pricePerGB);
  if (costPerGB === null || payg === null || prepaid === null || freeGB === null || switchAtGB === null || cfPrice === null) return null;
  if (switchAtGB > freeGB) return null;   // the switch is meant to come before the free allowance runs out
  const tiers = Array.isArray(b.topUp && b.topUp.bonusTiers) ? b.topUp.bonusTiers : [];
  const bonusTiers = tiers
    .map((t) => ({ minAmount: num(t && t.minAmount), bonusPercent: num(t && t.bonusPercent) }))
    .filter((t) => t.minAmount !== null && t.bonusPercent !== null && t.bonusPercent <= 100)
    .sort((a, c) => a.minAmount - c.minAmount);
  const gph = (j.estimates && j.estimates.gbPerHour) || {};
  const status = typeof j.status === 'string' ? j.status : '';
  const free = j.includedWithSubscription === true || j.freeAtThisTime === true || status === 'free';
  const paygPrice = pricePerGB(costPerGB, payg);
  return {
    version: j.version,
    currency: typeof j.currency === 'string' && /^[A-Z]{3}$/.test(j.currency) ? j.currency : 'USD',
    status,
    free,
    includedWithSubscription: j.includedWithSubscription === true,
    subscriptionMonthly: num(j.subscriptionMonthly) ?? 3,
    subscriptionCurrency: j.subscriptionCurrency || 'CAD',
    householdMaxMembers: num(j.householdMaxMembers) ?? 6,
    updatedAt: typeof j.updatedAtEastern === 'string' ? j.updatedAtEastern : '',
    beebo: {
      costPerGB,
      payAsYouGoMarkupPercent: payg,
      prepaidMarkupPercent: prepaid,
      payAsYouGoPricePerGB: paygPrice,
      prepaidPricePerGB: pricePerGB(costPerGB, prepaid),
      free,
      // What is actually charged per GB now: nothing while free.
      chargedPricePerGB: free ? 0 : paygPrice,
      bonusTiers,
      lowBalanceWarnPercents: Array.isArray(b.lowBalanceWarnPercents) ? b.lowBalanceWarnPercents.filter((p) => num(p) !== null) : [],
    },
    cloudflare: {
      freeGBPerMonth: freeGB, switchAtGB, pricePerGB: cfPrice,
      pricesCheckedOn: typeof cf.pricesCheckedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cf.pricesCheckedOn) ? cf.pricesCheckedOn : '',
      source: typeof cf.source === 'string' && /^https:\/\/developers\.cloudflare\.com\//.test(cf.source) ? cf.source : '',
    },
    // Not a Beebo feature: a rough guess the payment survey uses to compare
    // "about N short ads" (null when the file has no usable figure).
    ads: j.ads && typeof j.ads === 'object' && num(j.ads.estimatedRevenuePerAdUSD) > 0
      ? { estimatedRevenuePerAdUSD: j.ads.estimatedRevenuePerAdUSD, estimatedSecondsPerAd: num(j.ads.estimatedSecondsPerAd) > 0 ? j.ads.estimatedSecondsPerAd : 30, note: typeof j.ads.note === 'string' ? j.ads.note.slice(0, 200) : '', status: typeof j.ads.status === 'string' ? j.ads.status : '' }
      : null,
    gbPerHour: {
      sd: num(gph.sd) || 1,
      hd: num(gph.hd) || 3,
      hdHigh: num(gph.hdHigh) || 5,
      uhd: num(gph.uhd) || 7,
    },
  };
}

function bundled() {
  // require() of a JSON file: packaged with electron/** by electron-builder.
  return parsePricing(require('./relay-pricing.fallback.json'));
}

/**
 * @param {object} deps
 * @param {object} deps.store       electron-store (cache lives under relayPricingCache)
 * @param {function} [deps.fetch]   fetch implementation
 * @param {function} [deps.now]     () => ms
 * @param {string} [deps.url]
 */
function createPricingSource({ store, fetch: fetchImpl, now = Date.now, url = PRICING_URL } = {}) {
  let lastTry = 0;
  let inflight = null;

  function cached() {
    try {
      const c = store && store.get(CACHE_KEY);
      const p = c && parsePricing(c.json);
      return p ? { pricing: p, fetchedAt: Number(c.fetchedAt) || 0 } : null;
    } catch (_) { return null; }
  }

  // { pricing, source: 'site' | 'cached' | 'bundled', fetchedAt }
  function current() {
    const c = cached();
    if (c) return { pricing: c.pricing, source: now() - c.fetchedAt < REFRESH_MS ? 'site' : 'cached', fetchedAt: c.fetchedAt };
    return { pricing: bundled(), source: 'bundled', fetchedAt: 0 };
  }

  async function refresh(force = false) {
    const c = cached();
    if (!force && c && now() - c.fetchedAt < REFRESH_MS) return current();
    if (!force && now() - lastTry < RETRY_MS) return current();
    if (inflight) return inflight;
    lastTry = now();
    inflight = (async () => {
      try {
        const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
        if (!f) return current();
        const res = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!res || !res.ok) return current();
        const text = await res.text();
        if (text.length > 256 * 1024) return current();
        const json = JSON.parse(text);
        // Only a file this app understands replaces the cache.
        if (parsePricing(json)) store.set(CACHE_KEY, { fetchedAt: now(), json });
      } catch (_) { /* keep what we have */ }
      return current();
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  return { current, refresh };
}

module.exports = { PRICING_URL, SUPPORTED_VERSION, SUPPORTED_VERSIONS, parsePricing, pricePerGB, topUpBonus, createPricingSource, bundled };
