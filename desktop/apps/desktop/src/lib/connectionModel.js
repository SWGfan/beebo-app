// connectionModel.js — the Connection wizard and Settings > Connection, as pure
// functions: what a test result means, which words to show, what the current
// status is. No React, no IPC, no DOM, so node --test can check all of it
// (test/connection-model.test.js).
//
// Facts the words rely on (checked 2026-09-17, keep them true):
//   - Direct: the video goes over WebRTC straight between the computer and the
//     viewer. Beebo's service (the beebo.tv Worker) only introduces the two
//     ends and signs people in. See resources/beebo-rtc-host.
//   - Beebo Relay: coturn on an OVHcloud VPS in Beauharnois (BHS), Canada
//     (relay/HOOKUP.md). The video stays DTLS-encrypted end to end; the relay
//     only forwards packets.
//   - Kept: GB per account per month (worker/relay.js relay_usage_monthly), and
//     server logs (coturn, journal, auth.log) for 7 days at most
//     (relay/setup/bootstrap.sh "Log retention (7 days)").
//   - Country counts: per month, no address, not linked to an account
//     (worker/regions.js).
//   - Terms version must equal RELAY_TERMS.version in worker/relay.js.

export const RELAY_TERMS_VERSION = '2026-09-17'

// Beebo Relay is free at this time (RELAY_TERMS.free in worker/relay.js, and
// "freeAtThisTime" in relay-pricing.json). If fees ever start: at cost, 0% markup.
export const FREE_AT_THIS_TIME = 'Included in away plan'
export const NO_MARKUP_PROMISE = 'Beebo Relay is included with the CA$3/month away-from-home household plan for up to 6 people, including the owner. There is no extra Beebo Relay usage charge. At-home use is free.'

// ---------------------------------------------------------------------------
// Setup state kept in the app store (electron/connectionTest.js keeps the same shape).
export const STEPS = ['home', 'away', 'result']
export const CHOICES = ['relay', 'cloudflare', 'ports', 'home_only']

export function normalizeSetup(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    state: ['new', 'in_progress', 'skipped', 'done'].includes(s.state) ? s.state : 'new',
    step: STEPS.includes(s.step) ? s.step : 'home',
    choice: CHOICES.includes(s.choice) ? s.choice : null,
    homeOk: !!s.homeOk,
    lastResult: s.lastResult && typeof s.lastResult === 'object' && typeof s.lastResult.outcome === 'string'
      ? { outcome: s.lastResult.outcome, at: Number(s.lastResult.at) || 0, provider: String(s.lastResult.provider || '') }
      : null,
    relayAcceptedAt: Number(s.relayAcceptedAt) || 0,
    relayTermsVersion: String(s.relayTermsVersion || ''),
  }
}

// Should the first-run guide open on its own?
export function wizardPending(setup) {
  const s = normalizeSetup(setup)
  return s.state === 'new' || s.state === 'in_progress'
}

// ---------------------------------------------------------------------------
// A. Watch at home. `home` = { since, seenAt, device } from the PC.
export function homeResult(home) {
  if (!home || !home.since) return { state: 'idle' }
  if (home.seenAt && home.seenAt >= home.since) return { state: 'connected', device: home.device || '' }
  return { state: 'waiting' }
}

// ---------------------------------------------------------------------------
// B. Watch away from home.
// The automatic check the PC can do alone: did the router open Beebo's ports,
// or does the internet provider share one address between many homes? It is a
// hint, never proof; the phone test is the proof.
//   remote = remote:getName result { hostname, online, problem, udp }
export function autoCheck(remote) {
  if (!remote || !remote.hostname) return { state: 'no_address' }
  if (remote.problem) return { state: 'address_problem', problem: remote.problem }
  const udp = remote.udp || {}
  if (!remote.online) return { state: 'starting' }
  if (!udp.enabled) return { state: 'unknown' }
  if (udp.kind === 'cgnat' || udp.kind === 'double-nat') return { state: 'direct_unlikely', kind: udp.kind }
  if (udp.mapped) return { state: 'direct_likely' }
  if (!udp.tried) return { state: 'checking' }
  return { state: 'unknown' }
}

// events: newest-first or any order, [{ at, state: 'open'|'failed', path, provider }]
// -> the most telling thing that happened since the test started.
export function awayResult(events, since) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && Number(e.at) >= Number(since || 0))
  const opened = list.filter((e) => e.state === 'open').sort((a, b) => b.at - a.at)
  const latest = opened[0]
  if (latest && latest.path === 'direct') return { state: 'direct', at: latest.at }
  if (opened.length) return { state: 'relay', at: opened[0].at, provider: opened[0].provider || '' }
  const failed = list.filter((e) => e.state === 'failed').sort((a, b) => b.at - a.at)[0]
  if (failed) return { state: 'failed', at: failed.at }
  return { state: 'waiting' }
}

// C. What it all adds up to.
//   direct_ok      a viewer away from home connected directly
//   relay_ok       it only worked through a relay: direct is blocked, the relay is on
//   blocked        a viewer tried and could not connect, or the PC is sure direct can't work
//   direct_likely  no phone test yet, but the router opened the ports
//   unknown        not enough to say
export function overallOutcome({ away, auto } = {}) {
  const a = away && away.state
  if (a === 'direct') return 'direct_ok'
  if (a === 'relay') return 'relay_ok'
  if (a === 'failed') return 'blocked'
  const s = auto && auto.state
  if (s === 'direct_unlikely') return 'blocked'
  if (s === 'direct_likely') return 'direct_likely'
  return 'unknown'
}

// Is a result final enough to keep as "last test result"?
export const isFinalOutcome = (o) => o === 'direct_ok' || o === 'relay_ok' || o === 'blocked'

// Settings > Connection status line.
//   direct | relay | cloudflare | home_only | ports | blocked | not_tested
// relayMode = the PC's relay mode ('own' = Cloudflare only / your own relay).
// The host labels a relayed connection's provider ('cloudflare' | 'custom' |
// 'beebo'); when there is no such result, the chosen mode decides.
export function currentStatus({ setup, relayEnabled, relayMode } = {}) {
  const s = normalizeSetup(setup)
  const last = s.lastResult && s.lastResult.outcome
  const lastProvider = s.lastResult && s.lastResult.provider
  if (s.choice === 'home_only') return 'home_only'
  if (last === 'direct_ok') return 'direct'
  if (s.choice === 'cloudflare' || relayMode === 'own') return 'cloudflare'
  if (last === 'relay_ok' && (lastProvider === 'cloudflare' || lastProvider === 'custom') && !relayEnabled && s.choice !== 'relay') return 'cloudflare'
  if (s.choice === 'relay' || relayEnabled || last === 'relay_ok') return 'relay'
  if (s.choice === 'ports') return 'ports'
  if (last === 'blocked') return 'blocked'
  return 'not_tested'
}

// ---------------------------------------------------------------------------
// Words. Plain English, short sentences.

export const STATUS_TEXT = {
  direct: { label: 'Direct connection', detail: 'Your video goes straight from this computer to your phone or browser.', tone: 'ok' },
  relay: { label: 'Beebo Relay enabled', detail: 'Beebo tries a direct connection first. When that doesn’t work, your video goes through Beebo Relay. Included with your away-from-home household plan.', tone: 'ok' },
  cloudflare: { label: 'Through your Cloudflare relay', detail: 'Beebo tries a direct connection first. When that doesn’t work, your video goes through your own Cloudflare account, not Beebo’s servers.', tone: 'ok' },
  home_only: { label: 'Home only', detail: 'You can watch on the same Wi-Fi as this computer. Away from home may not work.', tone: 'muted' },
  ports: { label: 'Open ports on my router', detail: 'Test again after you change your router settings.', tone: 'warn' },
  blocked: { label: 'Direct connection doesn’t work', detail: 'Choose an option below to watch away from home.', tone: 'warn' },
  not_tested: { label: 'Not tested yet', detail: 'Run the test to see how your phone connects away from home.', tone: 'muted' },
}

export function homeText(r) {
  if (r.state === 'connected') return { tone: 'ok', text: r.device ? `Your ${r.device} connected. Watching at home works.` : 'A device on your Wi-Fi connected. Watching at home works.' }
  if (r.state === 'waiting') return { tone: 'muted', text: 'Waiting for your phone… Open the Beebo app and scan the code.' }
  return { tone: 'muted', text: '' }
}

export function autoText(a) {
  switch (a && a.state) {
    case 'no_address': return { tone: 'warn', text: 'Sign in to your Beebo account first. Then this computer gets its own beebo.tv address.' }
    case 'address_problem': return { tone: 'warn', text: 'Your beebo.tv address has a problem. See Settings › Your Beebo address.' }
    case 'starting': return { tone: 'muted', text: 'Your beebo.tv address is starting up…' }
    case 'checking': return { tone: 'muted', text: 'Checking your router…' }
    case 'direct_likely': return { tone: 'ok', text: 'Good sign: your router opened Beebo’s ports by itself. Direct connections should work. The phone test will confirm it.' }
    case 'direct_unlikely': return { tone: 'warn', text: a.kind === 'double-nat'
      ? 'Your home has two routers in a row. Direct connections from outside probably won’t work.'
      : 'Your internet provider shares one internet address between many homes. Direct connections from outside probably won’t work.' }
    default: return { tone: 'muted', text: 'This computer can’t tell on its own whether direct connections work. The phone test will show it.' }
  }
}

export function awayText(r) {
  switch (r && r.state) {
    case 'direct': return { tone: 'ok', text: 'Your phone connected. Direct connection.' }
    case 'relay': return { tone: 'ok', text: r.provider === 'beebo' ? 'Your phone connected. Through Beebo Relay.' : r.provider === 'cloudflare' ? 'Your phone connected. Through your Cloudflare relay.' : 'Your phone connected. Through a relay.' }
    case 'failed': return { tone: 'bad', text: 'Your phone tried to connect but couldn’t get through.' }
    default: return { tone: 'muted', text: 'Waiting for your phone… Nothing has connected yet.' }
  }
}

export const RESULT_TEXT = {
  direct_ok: {
    title: 'You’re all set',
    body: [
      'Your video goes straight from your computer to your phone or browser.',
      'Your video never passes through Beebo’s servers. Beebo’s service only helps your phone find your computer and sign you in.',
    ],
    showOptions: false,
  },
  direct_likely: {
    title: 'Looks good so far',
    body: [
      'Your router opened Beebo’s ports, so direct connections should work.',
      'Do the phone test to be sure.',
    ],
    showOptions: false,
  },
  relay_ok: {
    title: 'It works through Beebo Relay',
    body: [
      'The phone test connected through Beebo Relay. Your video remained encrypted between your devices.',
      'You can keep Beebo Relay, or change your router settings instead.',
    ],
    showOptions: true,
  },
  relay_ok_own: {
    title: 'It works through your own relay',
    body: [
      'The phone test connected through your own relay. Your video remained encrypted between your devices.',
      'You can keep it, or change your router settings instead.',
    ],
    showOptions: true,
  },
  blocked: {
    title: 'Your home network blocks direct connections',
    body: [
      'Your phone can’t reach this computer from outside your home.',
      'To watch away from home, you need to either change your modem or router settings, or use Beebo Relay.',
    ],
    showOptions: true,
  },
  unknown: {
    title: 'Phone test not completed',
    body: [
      'This test has not recorded a connection from another network yet.',
      'Relay can already be enabled below. Run the phone test to confirm which connection your phone uses.',
    ],
    showOptions: true,
  },
}

// The result words, with the relay that carried it when known.
export function resultText(outcome, provider) {
  if (outcome === 'relay_ok' && (provider === 'cloudflare' || provider === 'custom')) return RESULT_TEXT.relay_ok_own
  return RESULT_TEXT[outcome] || RESULT_TEXT.unknown
}

export const OPTION_TEXT = {
  relay: {
    title: 'Beebo Relay',
    badge: 'Recommended · Easy',
    freeBadge: FREE_AT_THIS_TIME,
    lines: [
      'Included in your away-from-home household plan. No extra relay charge.',
      NO_MARKUP_PROMISE,
      'Beebo always tries a direct connection first. Beebo Relay is only used when direct doesn’t work.',
    ],
    button: 'Turn on Beebo Relay',
  },
  cloudflare: {
    title: 'Cloudflare only',
    badge: 'Advanced · your own Cloudflare account',
    lines: [
      'When a direct connection doesn’t work, your video goes through your own Cloudflare account, not through Beebo’s servers. It stays encrypted from end to end, so the relay can’t see it.',
      'Cloudflare bills you directly, after its free monthly allowance. You set it up once with a key from your Cloudflare account.',
    ],
    button: 'Set up Cloudflare only',
  },
  ports: {
    title: 'Open ports on my router',
    badge: 'Advanced · No extra relay charge',
    lines: [
      'You change a setting on your modem or router so phones outside your home can reach this computer.',
    ],
    button: 'Show me how',
  },
  home_only: {
    title: 'Home only for now',
    badge: '',
    lines: ['Watch on the same Wi-Fi as this computer. You can change this anytime in Settings › Connection.'],
    button: 'Home only for now',
  },
}

export function portGuide(udp) {
  const ports = udp && udp.ports ? String(udp.ports) : ''
  const ip = udp && udp.localIp ? String(udp.localIp) : ''
  return {
    steps: [
      'Open your router’s settings. The address and password are usually on a sticker on the router.',
      'Find “Port forwarding”. It may be under Advanced, NAT, Firewall or Gaming.',
      ports
        ? `Add a rule: protocol UDP, ports ${ports}, to this computer${ip ? ` (${ip})` : ''}.`
        : 'Add a rule for the UDP ports shown in Settings › Your Beebo address (normally 47820–47829), to this computer.',
      'Save, then press Test again below.',
    ],
    warning: [
      'An open port makes this computer reachable from the internet. Beebo only answers people who sign in, but any open port is a small risk.',
      'Some internet providers block this. If yours shares one internet address between many homes, it won’t work at all.',
    ],
  }
}

export const RELAY_EXPLAINER = {
  title: 'How Beebo Relay works',
  path: ['Your computer', 'Your modem', 'Beebo Relay', 'Your phone or browser'],
  points: [
    'Your video goes from your computer, through your modem, to the Beebo Relay server, and then to your phone or browser.',
    'Your video is encrypted from end to end (WebRTC DTLS). The relay passes it along, but it can’t see it.',
    'We don’t harvest or sell your data.',
  ],
  keepTitle: 'What we keep',
  keep: [
    'How many GB your account used this month. This is for capacity limits and keeping the service reliable. Beebo Relay has no extra usage charge on the household plan.',
    'Basic connection records, including IP addresses, for up to 7 days. This is to stop abuse.',
    'A count of connections per country each month. It has no addresses and isn’t linked to your account. It helps us decide where to add servers.',
  ],
  whereTitle: 'Where it runs',
  where: 'Beebo Relay runs on an OVHcloud server in Beauharnois (BHS), Canada. We plan to add more locations.',
  ovhUrl: 'https://www.ovhcloud.com/',
  noteTitle: 'A note from Nick',
  note: 'Beebo is made by a family man, not a data company. I have no interest in what you watch or how you use Beebo. Beebo Relay exists only to get your video past your home internet when a direct connection isn’t possible. It runs on a server I pay for. Beebo Relay is included with the CA$3/month away-from-home household plan. At-home use is free.',
  noteBy: 'Nick, Beebo Entertainment',
}

// Beebo Relay usage line for Settings. info = connection:relayInfo result.
export function relayUsageText(info) {
  if (!info || info.unavailable) return { text: 'Beebo Relay isn’t available yet.', free: '' }
  if (info.error) return { text: 'Couldn’t check Beebo Relay just now.', free: '' }
  const gb = Number(info.gb) || 0
  const shown = gb >= 100 ? Math.round(gb).toLocaleString('en-US') : gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)
  const cap = Number(info.capGB) > 0 ? ` of your ${Math.round(Number(info.capGB))} GB monthly limit` : ''
  const free = info.free ? FREE_AT_THIS_TIME : ''
  if (!info.enabled) return { text: gb > 0 ? `Beebo Relay is off. ${shown} GB used this month.` : 'Beebo Relay is off.', free }
  if (info.suspended) return { text: 'Beebo Relay is paused on your account. Please contact Beebo support.', free }
  return { text: `${shown} GB used this month${cap}.${info.free ? ' No extra relay charge.' : ''}`, free }
}

// ---------------------------------------------------------------------------
// "Help us plan Beebo Relay": the optional payment survey (worker/relaySurvey.js).
export const SURVEY = {
  title: 'Help us plan Beebo Relay',
  question: 'Beebo Relay is free at this time. If we ever need to charge for extra GB, how would you prefer to pay?',
  optional: 'This is optional. Your answer doesn’t change your plan or what you pay.',
  choices: [
    { id: 'card_prepaid', label: 'Pay by card up front (prepaid GB)' },
    { id: 'card_monthly', label: 'Pay by card monthly for what I use' },
    { id: 'ads', label: 'Watch short ads to earn GB (never during your videos)' },
    { id: 'mix', label: 'A mix: ads when I want, card for the rest' },
    { id: 'not_sure', label: 'Not sure yet' },
  ],
  commentLabel: 'Anything else? (optional)',
  commentMax: 300,
  send: 'Send',
  later: 'Not now',
  thanks: 'Thanks! You can change your answer anytime.',
  yourAnswer: 'Your answer:',
  change: 'Change',
  adsNote: 'Ads aren’t part of Beebo today. This just helps you compare.',
  laterMs: 30 * 86400 * 1000,
}

// Where the survey card shows.
//   place 'settings': the questions until answered (unless "Not now" in the last 30 days),
//                     then "Your answer: … Change".
//   place 'wizard':   the questions only when Beebo Relay was chosen, not answered, not hidden.
// -> 'ask' | 'answer' | 'hidden'
export function surveyMode({ place, answer, hiddenUntil, now, choice } = {}) {
  const answered = !!(answer && answer.choice)
  const snoozed = Number(hiddenUntil) > Number(now || 0)
  if (place === 'wizard') return !answered && !snoozed && choice === 'relay' ? 'ask' : 'hidden'
  if (answered) return 'answer'
  return snoozed ? 'hidden' : 'ask'
}

export function surveyErrorText(code) {
  if (code === 'rate_limited') return 'You’ve changed your answer a lot today. Please try again tomorrow.'
  return relayErrorText(code)
}

// ---------------------------------------------------------------------------
// "How to set it up": a short summary that works offline, and the full guide
// on beeboentertainment.com (opened with the openExternal bridge).
const SITE = 'https://www.beeboentertainment.com/'
export const GUIDES = {
  direct: {
    title: 'Direct connection',
    url: SITE + 'direct-connection.html',
    steps: [
      'Nothing to set up for most homes. Beebo always tries a direct connection first.',
      'Run the test in Settings › Connection. Test 1 checks your phone on the same Wi-Fi. Test 2 checks your phone on mobile data.',
      'This computer also checks whether your router opened Beebo’s UDP ports by itself (NAT-PMP or UPnP), and whether your internet provider shares one address between many homes.',
      'If the router didn’t open the ports, turn on UPnP in your router’s settings, or open the ports yourself.',
    ],
  },
  ports: {
    title: 'Open ports on my router',
    url: SITE + 'open-ports.html',
    steps: [
      'Give this computer a fixed local address in your router (often called DHCP reservation).',
      'Open your router’s settings. The address and password are usually on a sticker on the router (usually Bell 192.168.2.1, Rogers 10.0.0.1, Telus 192.168.1.254).',
      'Find Port forwarding. Add a rule: protocol UDP, the ports shown in Settings › Your Beebo address (normally 47820–47829), to this computer.',
      'Save, then press Test again. Only forward Beebo’s ports, and never use DMZ.',
    ],
  },
  relay: {
    title: 'Beebo Relay',
    url: SITE + 'beebo-relay.html',
    steps: [
      'Press Turn on Beebo Relay. This accepts the Beebo Relay terms. You need an active Beebo subscription.',
      'Beebo still tries a direct connection first. Beebo Relay is only used when direct doesn’t work.',
      'Test with your phone on mobile data. Beebo Relay is included with your away-from-home household plan.',
      'To turn it off, choose another option in Settings › Connection.',
    ],
  },
  cloudflare: {
    title: 'Cloudflare only (your own Cloudflare account)',
    url: SITE + 'own-relay.html',
    steps: [
      'Create a free Cloudflare account, then open Realtime › TURN Server.',
      'Create a TURN key. Copy the key ID and the API token.',
      'In Settings › Your Beebo address › Away from home: Relay, choose Cloudflare only, paste both values, and save.',
      'Beebo turns Beebo Relay off for your account, so relayed video only uses your Cloudflare. Cloudflare bills you after its free monthly allowance.',
    ],
  },
  cloudflare_then_beebo: {
    title: 'Cloudflare first, then Beebo Relay',
    url: SITE + 'beebo-relay.html#cloudflare-first',
    steps: [
      'Set up your own Cloudflare relay first (see the Cloudflare only guide).',
      'Choose My Cloudflare first, then Beebo Relay, and paste your Cloudflare key.',
      'Beebo uses your Cloudflare inside its free allowance. At 950 GB in a month, new relayed connections move to Beebo Relay (included with your away-from-home household plan) until the month resets.',
    ],
  },
  home_only: {
    title: 'Home only',
    url: SITE + 'direct-connection.html#home-only',
    steps: [
      'Nothing to set up. Watch on the same Wi-Fi as this computer.',
      'Away-from-home access needs the CA$3/month household plan.',
      'You can change this anytime in Settings › Connection.',
    ],
  },
}

// Plain-English reason for a failed opt-in / opt-out (codes from electron/connectionTest.js).
export function relayErrorText(code) {
  switch (code) {
    case 'not_available': return 'Beebo Relay isn’t switched on yet. Please try again later.'
    case 'no_active_subscription': return 'Beebo Relay needs an active Beebo subscription.'
    case 'relay_suspended': return 'Beebo Relay is paused on your account. Please contact Beebo support.'
    case 'terms_changed': return 'The Beebo Relay terms have changed. Please update Beebo, then try again.'
    case 'unauthorized': return 'This computer needs to sign in to Beebo again.'
    case 'signed_out': return 'Sign in to your Beebo account first.'
    case 'unreachable': return 'Beebo couldn’t be reached. Check your internet connection and try again.'
    default: return 'Something went wrong. Please try again.'
  }
}
