'use strict';
// ============================================================================
// walletModel.js — what Settings shows for the Beebo Relay balance.
// ----------------------------------------------------------------------------
// Pure. Inputs: walletClient.getState(), the parsed relay-pricing.json
// (relayPricing.js), this computer's relay meter (relayMeter.js), the relay
// mode and the owner's own relay kind. The cost comparison on the choice screen
// is worked out HERE from relay-pricing.json and the PC's metered usage, not
// taken from the Worker, so it matches the prices the rest of Settings shows.
//
// In "Beebo Relay only" mode Cloudflare appears once, as a one-line alternative
// on the choice screen, and nowhere else.
// ============================================================================

const { GB, effectiveBytes } = require('./relayMeter');
const { topUpBonus } = require('./relayPricing');

const DAY_MS = 86400000;
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rate = (n) => '$' + Number(n || 0).toFixed(4);
const gbText = (gb) => (gb >= 100 ? Math.round(gb).toLocaleString('en-US') : gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)) + ' GB';

// This month's relayed GB so far, spread to a whole month at the same pace.
function projectedMonthlyGB(usage, nowMs) {
  if (!usage || !usage.periodStart) return { soFarGB: 0, monthlyGB: 0 };
  const soFarGB = (effectiveBytes(usage, 'beebo') + effectiveBytes(usage, 'cloudflare')) / GB;
  const monthDays = Math.max(1, (Number(usage.periodEnd) - Number(usage.periodStart)) / DAY_MS);
  const elapsedDays = Math.max(1, (nowMs - Number(usage.periodStart)) / DAY_MS);
  return { soFarGB, monthlyGB: (soFarGB / Math.min(elapsedDays, monthDays)) * monthDays };
}

// What each way forward would cost a month at this usage, from relay-pricing.json.
function compareChoices({ pricing, monthlyGB, mode, ownKind }) {
  const b = pricing.beebo;
  const cf = pricing.cloudflare;
  // In "Cloudflare first" only what's past the switch would ever go through Beebo.
  const beeboGB = mode === 'cloudflare_then_beebo' ? Math.max(0, monthlyGB - cf.switchAtGB) : monthlyGB;
  const tiers = b.bonusTiers || [];
  const best = tiers.length ? tiers[tiers.length - 1] : null;
  const cfMonthly = round2(Math.max(0, monthlyGB - cf.freeGBPerMonth) * cf.pricePerGB);
  const options = [
    {
      id: 'topup',
      title: 'Top up',
      monthly: round2(beeboGB * b.prepaidPricePerGB),
      detail: `${rate(b.prepaidPricePerGB)}/GB, our lowest rate` + (best ? `. Top up $${best.minAmount} and get ${best.bonusPercent}% extra, about ${money(round2((beeboGB * b.prepaidPricePerGB) / (1 + best.bonusPercent / 100)))} a month.` : '.'),
    },
    {
      id: 'payg',
      title: 'Pay as you go with Beebo',
      monthly: round2(beeboGB * b.payAsYouGoPricePerGB),
      detail: `${rate(b.payAsYouGoPricePerGB)}/GB, added to your monthly Beebo bill. Nothing to top up.`,
    },
    {
      id: 'cloudflare_only',
      title: 'Use my Cloudflare only',
      monthly: cfMonthly,
      detail: `Billed by Cloudflare: first ${gbText(cf.freeGBPerMonth)} a month free, then ${rate(cf.pricePerGB)}/GB.` + (ownKind === 'cloudflare' ? '' : ' Needs your own Cloudflare relay set up below.'),
      alternative: mode === 'beebo_only',
      needsSetup: ownKind !== 'cloudflare',
    },
  ];
  const ranked = options.filter((o) => !o.needsSetup).slice().sort((x, y) => x.monthly - y.monthly);
  return { monthlyGB: Math.round(monthlyGB * 10) / 10, beeboGB: Math.round(beeboGB * 10) / 10, options, cheapest: ranked.length ? ranked[0].id : 'topup' };
}

function walletSettingsModel({ state, pricing, usage, mode, ownKind, now }) {
  const usesBeebo = mode === 'beebo_only' || mode === 'cloudflare_then_beebo';
  const model = { show: usesBeebo, status: 'loading', notice: '' };
  if (!usesBeebo) return model;
  const s = state || { kind: 'unknown' };
  const me = s.me || (s.kind !== 'off' && s.cached && s.cached.me) || null;
  if ((pricing && (pricing.free || pricing.includedWithSubscription)) || me?.includedWithSubscription) {
    model.status = 'free';
    model.includedWithSubscription = true;
    model.notice = 'Beebo Relay is included with the CA$3/month away-from-home household plan for up to 6 people, including the owner. No relay top-up is needed. At-home use is free.';
    model.balanceText = me?.balance ? money(me.balance.amount) : null;
    model.ledger = (me?.ledger || []).slice(0, 10).map((e) => ({ at: Number(e.at) * 1000, kind: e.kind, amount: e.amount, balanceAfter: e.balanceAfter, text: ledgerText(e) }));
    model.banner = null;
    model.topUps = [];
    model.choiceScreen = null;
    return model;
  }
  if (s.kind === 'off') {
    model.status = 'off';
    model.notice = 'Beebo Relay balances aren’t switched on yet.';
    return model;
  }
  if (!me) {
    model.status = s.kind === 'unknown' ? 'loading' : 'unreachable';
    model.notice = s.kind === 'unknown' ? 'Checking your Beebo Relay balance…' : (s.error === 'unauthorized' ? 'Sign in to Beebo to see your Beebo Relay balance.' : 'Couldn’t reach Beebo to check your balance. Beebo Relay is paused until it can, so nothing is charged by surprise.');
    return model;
  }
  model.status = s.kind === 'ok' ? 'ok' : 'stale';
  if (model.status === 'stale') model.notice = 'Couldn’t reach Beebo just now; showing your last known balance.';
  const b = pricing.beebo;
  const balance = me.balance ? Number(me.balance.amount) : 0;
  const hoursHD = Math.max(0, Math.floor(balance / (pricing.gbPerHour.hd * b.prepaidPricePerGB)));
  const proj = projectedMonthlyGB(usage, now);
  const beeboShareGB = mode === 'cloudflare_then_beebo' ? Math.max(0, proj.monthlyGB - pricing.cloudflare.switchAtGB) : proj.monthlyGB;
  const dailySpend = (beeboShareGB / 30) * b.prepaidPricePerGB;
  const level = (me.warning && me.warning.level) || 'ok';
  const percents = b.lowBalanceWarnPercents && b.lowBalanceWarnPercents.length ? b.lowBalanceWarnPercents : [25, 10];
  const lowest = 'low' + Math.min(...percents);
  const choice = me.choice || { choice: null, remember: false, needed: false };
  const relay = me.relay || {};

  Object.assign(model, {
    balance,
    balanceText: money(balance),
    hoursHDLeft: hoursHD,
    daysLeftAtYourPace: dailySpend > 0 ? Math.floor(balance / dailySpend) : null,
    level,
    percentLeft: me.warning ? me.warning.percentLeft : null,
    prepaidPricePerGB: b.prepaidPricePerGB,
    payAsYouGoPricePerGB: b.payAsYouGoPricePerGB,
    costPerGB: b.costPerGB,
    prepaidMarkupPercent: b.prepaidMarkupPercent,
    balancePolicy: (me.pricing && me.pricing.balancePolicy) || 'Never expires. Refundable on request.',
    topUps: [10, 25, 50].map((amount) => {
      const fromWorker = me.pricing && Array.isArray(me.pricing.topUps) ? me.pricing.topUps.find((q) => q.amount === amount) : null;
      const bonus = topUpBonus(amount, b.bonusTiers);
      return { amount, bonus, credit: round2(amount + bonus), offered: !me.pricing || !me.pricing.topUps || !!fromWorker };
    }).filter((q) => q.offered),
    ledger: (me.ledger || []).slice(0, 10).map((e) => ({ at: Number(e.at) * 1000, kind: e.kind, amount: e.amount, balanceAfter: e.balanceAfter, gb: e.gb, bonus: e.bonus, payg: e.payg, waived: e.waived, text: ledgerText(e) })),
    payg: { active: !!(me.payg && me.payg.active), unbilled: me.payg ? me.payg.unbilled : 0 },
    choice: { current: choice.choice, remember: !!choice.remember },
    relayAllowed: !!relay.allowed,
    relayReason: relay.reason || '',
  });

  // The banner: balance, hours of HD left, and a Top up button.
  if (level !== 'ok' && !(level === 'empty' && model.payg.active && !me.lastTopUpCredit)) {
    let text;
    if (level === 'empty') {
      text = model.payg.active
        ? `Your Beebo Relay balance is used up. Pay as you go is on: ${rate(b.payAsYouGoPricePerGB)}/GB on your monthly bill.`
        : relay.reason === 'wallet_cloudflare_only'
          ? 'Your Beebo Relay balance is used up. As you chose, relaying uses your own Cloudflare only.'
          : 'Your Beebo Relay balance is used up, so Beebo Relay is paused. Nothing is charged until you choose.';
    } else {
      text = `Beebo Relay balance: ${money(balance)}, about ${hoursHD} hour${hoursHD === 1 ? '' : 's'} of HD left` +
        (model.daysLeftAtYourPace !== null ? ` (about ${model.daysLeftAtYourPace} day${model.daysLeftAtYourPace === 1 ? '' : 's'} at your recent use).` : '.');
    }
    model.banner = { level, text, urgent: level === 'empty' || level === lowest };
  } else {
    model.banner = null;
  }

  // The choice screen: from the lowest warning on, or whenever the Worker says one is needed.
  const showChoice = level === 'empty' || level === lowest || !!choice.needed;
  model.choiceScreen = showChoice
    ? Object.assign(compareChoices({ pricing, monthlyGB: proj.monthlyGB, mode, ownKind }), {
      basedOn: proj.soFarGB > 0 ? `At this month’s pace (${gbText(proj.soFarGB)} relayed so far, about ${gbText(proj.monthlyGB)} a month):` : 'Nothing relayed yet this month, so costs are per GB:',
      fallback: ownKind === 'cloudflare' ? 'If you don’t choose, Beebo Relay pauses at $0 and relaying uses your own Cloudflare.' : 'If you don’t choose, Beebo Relay pauses at $0 and viewers connect directly only.',
    })
    : null;
  if (model.choiceScreen && mode === 'beebo_only' && ownKind !== 'cloudflare') {
    model.choiceScreen.fallback = 'If you don’t choose, Beebo Relay pauses at $0 and viewers connect directly only.';
  }
  return model;
}

function ledgerText(e) {
  if (e.kind === 'topup') return `Top-up ${money(e.paid)}${e.bonus ? ` + ${money(e.bonus)} bonus` : ''}`;
  if (e.kind === 'usage') return `Relayed ${gbText(Number(e.gb) || 0)}` + (e.payg ? `, ${money(e.payg)} pay as you go` : '') + (e.waived ? ' (past your balance, not charged)' : '');
  if (e.kind === 'payg_invoiced') return `Pay as you go ${money(Math.abs(e.payg || 0))} added to your bill`;
  if (e.kind === 'refund') return 'Refund';
  if (e.kind === 'adjust') return 'Adjustment' + (e.note ? `: ${e.note}` : '');
  if (e.kind === 'choice') return 'Choice: ' + String(e.note || '').replace('payg', 'pay as you go').replace('cloudflare_only', 'my Cloudflare only').replace('topup', 'top up');
  return e.kind;
}

module.exports = { walletSettingsModel, compareChoices, projectedMonthlyGB };
