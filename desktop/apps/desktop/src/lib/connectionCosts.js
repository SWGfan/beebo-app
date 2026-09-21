// connectionCosts.js — what each way of watching away from home would cost in a
// month, side by side. Pure: no React, no IPC (test/connection-wizard.test.js).
//
// Every number comes from relay-pricing.json, as parsed on the PC
// (electron/relayPricing.js) and handed over as getRelayModel().pricing
// (relayPolicy.publicPricing). Nothing here hard-codes a price. If the prices
// couldn't be loaded, the relay rows say so instead of showing a number.
//
//   Direct / Open ports / Home only   $0: no relay, nothing passes through a server
//   Beebo Relay                        charged $0 while free; estimate = GB x pay-as-you-go
//                                      price (at cost while the markup is 0)
//   Cloudflare only                    billed by Cloudflare: GB past the free allowance x price
//   Cloudflare first, then Beebo Relay Cloudflare up to switchAtGB (inside its free allowance),
//                                      the rest through Beebo Relay

export const OPTION_ORDER = ['direct', 'ports', 'home_only', 'relay', 'cloudflare', 'cloudflare_then_beebo']

const round2 = (n) => Math.round(n * 100) / 100
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

export function money(n, currency = 'USD') {
  const t = Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (currency === 'USD' ? '$' : currency + ' ') + t
}
export function gbText(gb) {
  const n = Number(gb) || 0
  return (n >= 100 ? Math.round(n).toLocaleString('en-US') : n >= 10 ? (Math.round(n * 10) / 10).toString() : (Math.round(n * 100) / 100).toString()) + ' GB'
}
const markupWords = (pct) => (Number(pct) > 0 ? `our cost plus ${pct}% markup` : 'at cost, 0% markup')

// The usable parts of getRelayModel().pricing, or null.
export function readPricing(p) {
  if (!p || typeof p !== 'object' || !p.beebo || !p.cloudflare) return null
  const b = p.beebo, cf = p.cloudflare
  const cost = fin(b.costPerGB), price = fin(b.payAsYouGoPricePerGB)
  const cfFree = fin(cf.freeGBPerMonth), cfPrice = fin(cf.pricePerGB), cfSwitch = fin(cf.switchAtGB)
  if (cost === null || price === null || cfFree === null || cfPrice === null || cfSwitch === null) return null
  return {
    currency: typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) ? p.currency : 'USD',
    free: p.free !== false,
    costPerGB: cost,
    pricePerGB: price,
    markupPercent: fin(b.payAsYouGoMarkupPercent) ?? 0,
    cloudflare: { freeGB: cfFree, pricePerGB: cfPrice, switchAtGB: Math.min(cfSwitch, cfFree), checkedOn: String(cf.pricesCheckedOn || ''), source: String(cf.source || '') },
    hdGBPerHour: fin(p.gbPerHour && p.gbPerHour.hd) || 3,
  }
}

// The amounts to compare: this month's use when there is some, then examples.
export function amountRows(pricing, usedGB) {
  const P = readPricing(pricing)
  const film = round2(((P && P.hdGBPerHour) || 3) * 2)
  const rows = []
  const used = Number(usedGB) || 0
  if (used > 0) rows.push({ id: 'month', gb: round2(used), label: `Your use this month so far (${gbText(used)})` })
  rows.push({ id: 'film', gb: film, label: `1 HD film (about ${gbText(film)})` })
  rows.push({ id: 'films10', gb: round2(film * 10), label: `10 HD films a month (about ${gbText(film * 10)})` })
  for (const gb of [100, 500, 1500]) rows.push({ id: 'gb' + gb, gb, label: `${gbText(gb)} a month` })
  return rows
}

// One option's cost for `gb` relayed in a month.
//   charged   what the user pays now (null = unknown)
//   estimate  Beebo Relay only: what it would cost if fees start later
//   billedBy  'nobody' | 'Beebo' | 'Cloudflare' | 'Cloudflare and Beebo'
export function optionCost(id, pricing, gb) {
  const P = readPricing(pricing)
  const g = Math.max(0, Number(gb) || 0)
  const cur = P ? P.currency : 'USD'
  const unknown = { id, charged: null, estimate: null, billedBy: '', headline: 'Prices couldn’t be loaded', note: 'Open Settings again when this computer is online.' }
  switch (id) {
    case 'direct':
      return { id, charged: 0, estimate: null, billedBy: 'nobody', headline: money(0, cur), note: 'No relay. Your video goes straight to your phone or browser, not through any server.' }
    case 'ports':
      return { id, charged: 0, estimate: null, billedBy: 'nobody', headline: money(0, cur), note: 'No extra relay charge. Away-from-home access still needs the household plan.' }
    case 'home_only':
      return { id, charged: 0, estimate: null, billedBy: 'nobody', headline: money(0, cur), note: 'Same Wi-Fi only. No relay, no charge.' }
    case 'relay': {
      if (!P) return Object.assign(unknown, { headline: 'Included', charged: 0, note: '' })
      const estimate = round2(g * P.pricePerGB)
      return P.free
        ? { id, charged: 0, estimate, billedBy: 'nobody', free: true, headline: 'Included', note: 'No extra relay charge with the CA$3/month away-from-home household plan.' }
        : { id, charged: estimate, estimate, billedBy: 'Beebo', free: false, headline: money(estimate, cur), note: `Billed by Beebo, ${markupWords(P.markupPercent)}.` }
    }
    case 'cloudflare': {
      if (!P) return unknown
      const cf = P.cloudflare
      const over = Math.max(0, g - cf.freeGB)
      const charged = round2(over * cf.pricePerGB)
      return {
        id, charged, estimate: null, billedBy: 'Cloudflare', headline: money(charged, cur),
        note: over > 0
          ? `Billed by Cloudflare: ${gbText(over)} past its free ${gbText(cf.freeGB)} a month, at ${money(cf.pricePerGB, cur)}/GB.`
          : `Inside Cloudflare’s free ${gbText(cf.freeGB)} a month. Past that, Cloudflare bills you ${money(cf.pricePerGB, cur)}/GB.`,
      }
    }
    case 'cloudflare_then_beebo': {
      if (!P) return unknown
      const cf = P.cloudflare
      const cfGB = Math.min(g, cf.switchAtGB)
      const beeboGB = Math.max(0, g - cf.switchAtGB)
      const cfCost = round2(Math.max(0, cfGB - cf.freeGB) * cf.pricePerGB)
      const estimate = round2(beeboGB * P.pricePerGB)
      const charged = round2(cfCost + (P.free ? 0 : estimate))
      if (beeboGB === 0) {
        return { id, charged, estimate: 0, billedBy: cfCost > 0 ? 'Cloudflare' : 'nobody', free: P.free, headline: money(charged, cur), note: `All of it stays on your Cloudflare, inside its free allowance. New connections switch to Beebo Relay at ${gbText(cf.switchAtGB)} a month.` }
      }
      return {
        id, charged, estimate, billedBy: P.free ? (cfCost > 0 ? 'Cloudflare' : 'nobody') : 'Cloudflare and Beebo', free: P.free,
        headline: P.free ? `${money(charged, cur)} · Beebo Relay included` : money(charged, cur),
        note: P.free
          ? `First ${gbText(cf.switchAtGB)} on your Cloudflare (free allowance), then ${gbText(beeboGB)} through Beebo Relay, included with your away-from-home household plan.`
          : `First ${gbText(cf.switchAtGB)} on your Cloudflare (free allowance), then ${gbText(beeboGB)} through Beebo Relay, ${money(estimate, cur)} billed by Beebo.`,
      }
    }
    default:
      return unknown
  }
}

export const OPTION_TITLES = {
  direct: 'Direct connection',
  ports: 'Open ports on my router',
  home_only: 'Home only',
  relay: 'Beebo Relay',
  cloudflare: 'Cloudflare only (your own account)',
  cloudflare_then_beebo: 'Cloudflare first, then Beebo Relay',
}

// The whole comparison for one amount.
export function compareAll(pricing, gb) {
  return OPTION_ORDER.map((id) => Object.assign({ title: OPTION_TITLES[id] }, optionCost(id, pricing, gb)))
}

// ---------------------------------------------------------------------------
// For the payment survey: what `gb` of Beebo Relay would cost IF fees start
// later (at the file's pay-as-you-go price: at cost while the markup is 0), and
// about how many short ads that would be, from relay-pricing.json "ads".
// Nothing here is a charge: while Beebo Relay is free, charged is always 0.
//   ads = ceil(cost / estimatedRevenuePerAdUSD), in whole micro-dollars so 60 GB
//   at $0.011 over $0.015 is exactly 44, not 45.
export function relayIfFeesStart(pricing, gb) {
  const P = readPricing(pricing)
  const g = Math.max(0, Number(gb) || 0)
  const perAd = pricing && pricing.ads && fin(pricing.ads.estimatedRevenuePerAdUSD)
  // How long those ads would take to watch (Owner, 2026-09-17). Short rewarded ads run
  // about 15-30 seconds; the file's estimatedSecondsPerAd (default 30) keeps it editable.
  const secsPerAd = (pricing && pricing.ads && fin(pricing.ads.estimatedSecondsPerAd)) || 30
  if (!P) return { gb: g, charged: 0, cost: null, ads: null, adSeconds: null, free: true }
  const costMicros = Math.round(g * P.pricePerGB * 1e6)
  const adMicros = perAd ? Math.round(perAd * 1e6) : 0
  return {
    gb: g,
    free: P.free,
    charged: P.free ? 0 : round2(costMicros / 1e6),
    cost: round2(costMicros / 1e6),
    ads: adMicros > 0 ? Math.floor((costMicros + adMicros - 1) / adMicros) : null,
    adSeconds: adMicros > 0 ? Math.floor((costMicros + adMicros - 1) / adMicros) * secsPerAd : null,
    atCost: markupWords(P.markupPercent),
    currency: P.currency,
  }
}

// The lines under "Help us plan Beebo Relay": your use, then two examples.
// "about 3 minutes of watching": seconds below 90, then whole minutes, then hours.
export function adTimeText(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.floor(m / 60), r = m % 60
  return `${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} minute${r === 1 ? '' : 's'}` : ''}`
}

export function surveyExamples(pricing, { monthGB = 0 } = {}) {
  const P = readPricing(pricing)
  const hdPerHour = (P && P.hdGBPerHour) || 3
  const film = round2(hdPerHour * 2)
  const oneGBMinutes = Math.round(60 / hdPerHour)
  const rows = [
    { id: 'month', gb: Math.max(0, Number(monthGB) || 0), label: 'Your use this month' },
    { id: 'gb1', gb: 1, label: `1 GB of video (about ${oneGBMinutes} minutes of HD)` },
    { id: 'film', gb: film, label: `1 HD film (about ${gbText(film)})` },
    { id: 'films10', gb: round2(film * 10), label: `10 HD films (about ${gbText(film * 10)})` },
  ]
  return rows.map((r) => {
    const e = relayIfFeesStart(pricing, r.gb)
    const cur = e.currency || 'USD'
    const costText = e.cost === null ? '' : `about ${money(e.cost, cur)} (${cur})`
    const adsText = e.ads === null ? '' : `or about ${e.ads.toLocaleString('en-US')} short ad${e.ads === 1 ? '' : 's'} (about ${adTimeText(e.adSeconds)} of watching)`
    return Object.assign({}, r, e, { costText, adsText })
  })
}

// The small print under the comparison.
export function costFootnotes(pricing) {
  const P = readPricing(pricing)
  const notes = [`Prices in US dollars (USD). If your card is in Canadian dollars, your bank converts the amount.`]
  if (P && P.currency !== 'USD') notes[0] = `Prices in ${P.currency}.`
  notes.push('These are extra connection costs. At-home Beebo use is free. Away-from-home access is CA$3/month per household, for up to 6 people including the owner, whether the connection is direct or uses included Beebo Relay.')
  if (P && !P.free) notes[1] = `Beebo Relay is charged per GB (${markupWords(P.markupPercent)}).`
  if (P) {
    notes.push(`Cloudflare bills you directly for your own account.${P.cloudflare.checkedOn ? ` Cloudflare prices checked on ${P.cloudflare.checkedOn}.` : ''} Cloudflare may change them.`)
  }
  notes.push('Beebo tries a direct connection first. Beebo Relay is included when needed; your household subscription does not increase with relay usage.')
  return { notes, cloudflareSource: P && P.cloudflare.source ? P.cloudflare.source : '' }
}
