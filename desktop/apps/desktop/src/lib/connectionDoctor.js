// connectionDoctor.js: "Can't connect? Fix it for me", as pure functions (test/connection-doctor.test.js).
//
// The main process gathers plain facts (electron/connectionDoctorIpc.js); this turns them into an
// ordered list of checks, each pass / warn / fail / skip, with the plain-language meaning and, where
// Beebo can do it, a one-click fix. No React, no IPC, no network, so every decision is testable
// with made-up facts.
//
// Order matters and is part of the design: what a phone on the home Wi-Fi needs comes first (server,
// firewall, address), then what only watching away from home needs (internet, router, address
// record), and the sleep setting last because it can break either. Away checks are skipped, not
// failed, on a computer that never turned away-from-home on: a family that only watches at home
// should not see red for a router feature it does not use.

import { autoCheck } from './connectionModel.js'

export const CHECK_ORDER = ['server', 'firewall', 'lan', 'internet', 'router', 'nat', 'address', 'sleep']

export const FIXES = {
  restart: { id: 'restart', label: 'Restart Beebo', needsAdmin: false, explain: 'Closes and reopens Beebo, which takes about ten seconds. Anyone watching right now will be interrupted.' },
  firewall: { id: 'firewall', label: 'Fix the firewall', needsAdmin: true, explain: 'Windows will show a permission prompt (a shield) because changing the firewall needs administrator approval. Beebo only replaces its own rule, for its own port. Nothing changes unless you approve.' },
  retryRouter: { id: 'retryRouter', label: 'Ask the router again', needsAdmin: false, explain: 'Asks your router once more to open the connection Beebo needs. It can take up to fifteen seconds.' },
  updateAddress: { id: 'updateAddress', label: 'Update my address now', needsAdmin: false, explain: 'Tells beebo.tv where your home is right now.' },
  sleepSettings: { id: 'sleepSettings', label: 'Open sleep settings', needsAdmin: false, explain: 'Opens the Windows page where you choose when this computer sleeps.' },
  openSignin: { id: 'openSignin', label: 'Set up away-from-home', needsAdmin: false, explain: 'Opens the sign-in for watching away from home. Your home library never needs it.' },
}

const mk = (id, status, title, summary, extra = {}) => ({ id, status, title, summary, detail: '', fix: null, scope: 'home', ...extra })

// "47811", "Any", "1000-2000", "80,47811" -> does it cover `port`?
export function portCovered(localPort, port) {
  const s = String(localPort == null ? '' : localPort).trim()
  if (!s || /^any$/i.test(s)) return true
  return s.split(',').some((part) => {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part)
    if (!m) return false
    const lo = Number(m[1]); const hi = m[2] ? Number(m[2]) : lo
    return port >= lo && port <= hi
  })
}

const inbound = (r) => /^in/i.test(r.direction || '')
const isBlock = (r) => /^block/i.test(r.action || '')
const isAllow = (r) => /^allow/i.test(r.action || '')

function checkServer(f) {
  const port = f.server && f.server.port
  const listening = f.server && f.server.listening
  if (listening === true) return mk('server', 'pass', 'Beebo is running', 'Beebo is running on this computer and answering' + (port ? ' on port ' + port : '') + '.')
  if (listening === false) {
    return mk('server', 'fail', 'Beebo is not answering', 'Beebo’s server is not answering on this computer, so no phone or TV can connect.', {
      detail: 'This usually means Beebo is still starting, or it stopped after an error. Restarting Beebo fixes most cases.', fix: FIXES.restart,
    })
  }
  return mk('server', 'warn', 'Could not check the server', 'Beebo could not tell whether its server is running yet. Wait a few seconds and run the check again.')
}

function checkFirewall(f) {
  const fw = f.firewall || {}
  const port = f.server && f.server.port
  if (fw.applicable === false) return mk('firewall', 'pass', 'Firewall', 'Nothing to check on this computer.')
  if (fw.present === null || fw.present === undefined) {
    return mk('firewall', 'warn', 'Could not check the firewall', 'Beebo could not read the Windows Firewall settings. If phones cannot connect, try “Fix the firewall”.', { fix: FIXES.firewall })
  }
  if (fw.present === false) {
    return mk('firewall', 'fail', 'Windows Firewall is blocking phones', 'Windows Firewall has no rule letting phones reach Beebo, so phones on your Wi-Fi are probably being turned away.', {
      detail: 'Beebo normally adds this rule when it is installed. Antivirus programs and Windows updates sometimes remove it.', fix: FIXES.firewall,
    })
  }
  const rules = (fw.rules || []).filter((r) => r.enabled && inbound(r))
  const blocks = rules.filter(isBlock)
  const allows = rules.filter(isAllow)
  if (blocks.length) {
    return mk('firewall', 'fail', 'A firewall Block rule overrides Beebo', 'Windows has a Block rule for Beebo. Windows always obeys Block over Allow, so phones are turned away even though an Allow rule exists.', {
      detail: 'This happens when someone chooses Cancel on the first Windows Firewall question. Fixing it removes both rules and adds back a single Allow rule.', fix: FIXES.firewall,
    })
  }
  if (!allows.length) {
    return mk('firewall', 'fail', 'The firewall rule is turned off', 'Beebo’s firewall rule exists but is not switched on for incoming connections.', { fix: FIXES.firewall })
  }
  if (port && !allows.some((r) => (!r.protocol || /^(tcp|any)$/i.test(r.protocol)) && portCovered(r.localPort, port))) {
    return mk('firewall', 'fail', 'The firewall rule is for a different port', 'Beebo now uses port ' + port + ', but the firewall rule lets through a different one.', { fix: FIXES.firewall })
  }
  const profiles = allows.map((r) => String(r.profiles || '')).join(',')
  if (profiles && !/any|all|private/i.test(profiles)) {
    return mk('firewall', 'warn', 'The firewall only allows public networks', 'The rule does not cover “Private” networks, which is what your home Wi-Fi usually is.', { fix: FIXES.firewall })
  }
  return mk('firewall', 'pass', 'Firewall is open for Beebo', 'Windows Firewall lets phones reach Beebo, and no Block rule overrides it.')
}

const isLinkLocal = (a) => /^169\.254\./.test(a)

function checkLan(f) {
  const addrs = ((f.network && f.network.addresses) || []).map((a) => (typeof a === 'string' ? a : a.address)).filter(Boolean)
  if (!addrs.length) {
    return mk('lan', 'fail', 'This computer is not on a network', 'This computer has no Wi-Fi or cable address, so phones have nothing to connect to.', {
      detail: 'Connect this computer to your home Wi-Fi or plug in the network cable, then check again.',
    })
  }
  if (addrs.every(isLinkLocal)) {
    return mk('lan', 'fail', 'This computer did not get an address from the router', 'Its network address starts with 169.254, which means the router never gave it a real one.', {
      detail: 'Restart your router, or reconnect this computer to the Wi-Fi.',
    })
  }
  const good = addrs.filter((a) => !isLinkLocal(a))
  if (good.length > 1) {
    return mk('lan', 'warn', 'This computer is on more than one network', 'It has addresses on ' + good.length + ' networks (' + good.join(', ') + '). A phone can only connect if it is on the same one as the address it was given.', {
      detail: 'If a phone cannot connect, check it is on the same Wi-Fi as the address in the Get Started QR code, and not on a “guest” network. Guest Wi-Fi often stops phones from seeing other devices.',
    })
  }
  return mk('lan', 'pass', 'This computer’s address', 'Phones on the same Wi-Fi reach this computer at ' + good[0] + '.', {
    address: good[0] + (f.server && f.server.port ? ':' + f.server.port : ''),
    detail: 'If a phone still cannot connect, check that it is on the same Wi-Fi as this computer and not on a “guest” network, and that Wi-Fi is on (not just mobile data).',
  })
}

const awayOff = (id, title) => mk(id, 'skip', title, 'You have not turned on watching away from home, so this does not matter yet.', { scope: 'away', fix: FIXES.openSignin })

// "The internet is out" (as opposed to "beebo.tv is having trouble"): either the doctor's own check said the internet
// is down, or beebo.tv could not be reached by name, in time, or at all. That is a normal state for a home library,
// not a fault: nothing at home needs the internet. So it is a note (warn), never a failure, and the words say so.
const OFFLINE_ERRORS = ['dns', 'timeout', 'network']
function isOffline(f) {
  const c = f.cloud || {}
  if (c.signedIn && c.reachable === false) return OFFLINE_ERRORS.includes(c.error || 'network')
  return !!(f.internet && f.internet.online === false)
}

function checkInternet(f) {
  const c = f.cloud || {}
  if (isOffline(f)) {
    const lan = ((f.network && f.network.addresses) || []).map((a) => (typeof a === 'string' ? a : a.address)).filter((a) => a && !isLinkLocal(a))[0]
    const port = f.server && f.server.port
    const numbers = lan ? lan + (port ? ':' + port : '') : ''
    return mk('internet', 'warn', 'You’re offline right now', 'This computer cannot reach the internet, but Beebo is fine. Everything on your home network still works: your library, your accounts, and phones and TVs on the same Wi-Fi.', {
      scope: 'away', offline: true,
      detail: 'Only watching away from home, update checks and looking up titles Beebo has not seen before need the internet. Beebo keeps going by itself and reconnects when it is back.'
        + (numbers ? ' To watch on a phone at home right now, join the same Wi-Fi and use ' + numbers + ' (or scan the code in Get Started). No internet is needed for that.' : ''),
    })
  }
  if (!c.signedIn) {
    if (f.internet && f.internet.online === true) return mk('internet', 'pass', 'The internet is working', 'This computer can reach the internet. Watching at home never needs it.', { scope: 'away' })
    return awayOff('internet', 'Beebo’s service (beebo.tv)')
  }
  if (c.reachable === true) return mk('internet', 'pass', 'beebo.tv answers', 'This computer can reach beebo.tv' + (c.ms ? ' (' + c.ms + ' ms)' : '') + '.', { scope: 'away' })
  if (c.reachable === false) {
    const why = {
      tls: ['Secure connection to beebo.tv failed', 'This computer could not make a secure connection to beebo.tv. A wrong date or time on this computer, or an antivirus that inspects web traffic, causes this.'],
      http_5xx: ['beebo.tv is having trouble', 'beebo.tv answered with an error. This is on Beebo’s side, and usually clears up in a few minutes.'],
    }[c.error] || ['Cannot reach beebo.tv', 'This computer could not reach beebo.tv. Check the internet connection.']
    return mk('internet', 'fail', why[0], why[1], { scope: 'away', detail: 'Away-from-home viewing needs this computer to be online. Watching at home over your Wi-Fi does not.' })
  }
  return mk('internet', 'warn', 'Could not check beebo.tv', 'Beebo could not test the internet connection just now.', { scope: 'away' })
}

const dependsOnInternet = (f) => !!(f.cloud || {}).signedIn && ((f.cloud || {}).reachable === false || isOffline(f))
const offlineAway = (f) => !!(f.cloud || {}).signedIn && isOffline(f)

function checkRouter(f) {
  const c = f.cloud || {}
  if (!c.signedIn) return awayOff('router', 'Router and port opening')
  if (offlineAway(f)) return mk('router', 'skip', 'Router and port opening', 'Skipped until this computer is online.', { scope: 'away' })
  const r = f.router && f.router.server
  if (!r) return mk('router', 'warn', 'Router not tried yet', 'Beebo has not asked your router to open the connection yet.', { scope: 'away', fix: FIXES.retryRouter })
  if (r.active && r.reachable) return mk('router', 'pass', 'Your router opened the door', 'Your router accepted Beebo’s request (' + (r.method === 'nat-pmp' ? 'NAT-PMP' : r.method === 'upnp' ? 'UPnP' : 'automatic') + '), so direct connections from outside can reach this computer.', { scope: 'away' })
  if (r.active) {
    return mk('router', 'warn', 'The router accepted, but it is not reachable', 'The router said yes, but the address it reported cannot be reached from the internet.', { scope: 'away', detail: r.reason || '', fix: FIXES.retryRouter })
  }
  return mk('router', 'warn', 'Your router did not open the door', 'Your router did not accept Beebo’s automatic request. UPnP or NAT-PMP may be turned off on it.', {
    scope: 'away',
    detail: 'Beebo Relay can still carry your video when a direct connection is not possible. Turning UPnP on in the router’s settings, then asking again, restores direct connections.',
    fix: FIXES.retryRouter,
  })
}

function checkNat(f) {
  const c = f.cloud || {}
  if (!c.signedIn) return awayOff('nat', 'Shared internet address')
  if (offlineAway(f)) return mk('nat', 'skip', 'Shared internet address', 'Skipped until this computer is online.', { scope: 'away' })
  let auto = autoCheck(f.remote)
  const routerKind = f.router && f.router.server && f.router.server.kind
  if ((auto.state === 'unknown' || auto.state === 'checking') && (routerKind === 'cgnat' || routerKind === 'double-nat')) auto = { state: 'direct_unlikely', kind: routerKind }
  switch (auto.state) {
    case 'direct_unlikely':
      return auto.kind === 'cgnat'
        ? mk('nat', 'warn', 'Your internet provider shares one address', 'Your internet provider shares a single public address between many homes (called CGNAT), so a direct connection from outside cannot reach you.', { scope: 'away', detail: 'Turn on Beebo Relay in Settings, or ask your provider for a public address, and watching away from home will work.' })
        : mk('nat', 'warn', 'Two routers in a row', 'There is another router between your Beebo computer and the internet (called double NAT), so the door Beebo opens is not reachable from outside.', { scope: 'away', detail: 'Put the first router in bridge mode, or turn on Beebo Relay in Settings.' })
    case 'direct_likely':
      return mk('nat', 'pass', 'Direct connections should work', 'Nothing here suggests your internet provider or a second router is in the way.', { scope: 'away' })
    case 'address_problem':
      return mk('nat', 'fail', 'Your beebo.tv address has a problem', String(auto.problem || 'Beebo reported a problem with your away-from-home address.'), { scope: 'away' })
    case 'no_address':
      return mk('nat', 'skip', 'Shared internet address', 'Your beebo.tv address is not ready yet, so this cannot be checked.', { scope: 'away' })
    case 'starting':
    case 'checking':
      return mk('nat', 'warn', 'Still checking', 'Beebo is still starting up its away-from-home connection. Run the check again in a minute.', { scope: 'away' })
    default:
      return mk('nat', 'pass', 'No sign of a shared address', 'Beebo cannot tell for sure, but nothing points to a shared address or a second router.', { scope: 'away' })
  }
}

function checkAddress(f) {
  const c = f.cloud || {}
  if (!c.signedIn) return awayOff('address', 'Your beebo.tv address')
  if (dependsOnInternet(f)) return mk('address', 'skip', 'Your beebo.tv address', 'Skipped until this computer can reach beebo.tv.', { scope: 'away' })
  const a = f.address || {}
  if (a.state === 'error') {
    return mk('address', 'fail', 'beebo.tv could not update your address', 'Beebo tried to tell beebo.tv where your home is and it did not work' + (a.reason ? ': ' + a.reason : '') + '.', { scope: 'away', fix: FIXES.updateAddress })
  }
  if (a.state !== 'ok') {
    return mk('address', 'warn', 'Your address is not set yet', 'Beebo has not told beebo.tv where your home is yet. This normally takes under a minute after Beebo starts.', { scope: 'away', fix: FIXES.updateAddress })
  }
  const dns = Array.isArray(a.dnsIpv4) ? a.dnsIpv4 : null
  const seen = a.ipv4 || ''
  const routerIp = f.router && f.router.server && f.router.server.active && f.router.server.reachable ? f.router.server.externalIp : ''
  if (seen && routerIp && seen !== routerIp) {
    return mk('address', 'warn', 'Your home’s internet address changed', 'Your router reports a different internet address than the one beebo.tv has, so phones away from home may be sent to the wrong place.', { scope: 'away', fix: FIXES.updateAddress })
  }
  if (seen && dns && dns.length && !dns.includes(seen)) {
    return mk('address', 'warn', 'Your beebo.tv address is out of date', 'The address record for your home still points at an old internet address. It usually catches up on its own within a few minutes.', { scope: 'away', fix: FIXES.updateAddress })
  }
  return mk('address', 'pass', 'Your beebo.tv address matches', 'Your beebo.tv address points at this home’s current internet address.', { scope: 'away' })
}

function fmtMinutes(m) {
  if (m >= 120 && m % 60 === 0) return (m / 60) + ' hours'
  if (m >= 60) return Math.floor(m / 60) + ' hour' + (m >= 120 ? 's' : '') + (m % 60 ? ' ' + (m % 60) + ' minutes' : '')
  return m + ' minute' + (m === 1 ? '' : 's')
}

function checkSleep(f) {
  const s = f.sleep || {}
  if (!s.known) return mk('sleep', 'skip', 'Sleep setting', 'Beebo could not read this computer’s sleep setting.', { scope: 'both' })
  if (s.acMinutes === 0) return mk('sleep', 'pass', 'This computer will stay awake', 'Windows is set to never sleep while plugged in, so Beebo stays reachable.', { scope: 'both' })
  return mk('sleep', 'warn', 'This computer will go to sleep', 'Windows puts this computer to sleep after ' + fmtMinutes(s.acMinutes) + '. While it sleeps, phones and TVs cannot connect, at home or away.', {
    scope: 'both',
    detail: 'Beebo keeps the computer awake while someone is watching, but not while nobody is. Choose “Never” for sleep when plugged in.',
    fix: FIXES.sleepSettings,
  })
}

// facts -> the ordered list of checks. Every check always appears, in CHECK_ORDER.
export function evaluate(facts) {
  const f = facts || {}
  const byId = {
    server: checkServer, firewall: checkFirewall, lan: checkLan, internet: checkInternet,
    router: checkRouter, nat: checkNat, address: checkAddress, sleep: checkSleep,
  }
  return CHECK_ORDER.map((id) => {
    try { return byId[id](f) } catch (e) { return mk(id, 'warn', 'Could not run this check', 'This check hit an unexpected problem and was skipped.') }
  })
}

const RANK = { fail: 3, warn: 2, pass: 1, skip: 0 }

// checks -> the one line at the top and the thing to do first.
export function summarize(checks) {
  const list = Array.isArray(checks) ? checks : []
  const fails = list.filter((c) => c.status === 'fail')
  const warns = list.filter((c) => c.status === 'warn')
  const first = fails[0] || warns[0] || null
  const worst = list.reduce((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'skip')
  let headline = 'Everything looks good on this computer.'
  // No internet is the only thing found: say what is true. Beebo is fine, and watching at home works.
  const onlyOffline = !fails.length && warns.length > 0 && warns.every((c) => c.offline)
  if (onlyOffline) headline = 'No internet right now, but watching at home works.'
  else if (fails.length) headline = fails.length === 1 ? 'Found a problem: ' + fails[0].title + '.' : 'Found ' + fails.length + ' problems. Start with: ' + fails[0].title + '.'
  else if (warns.length) headline = warns.length === 1 ? 'Nearly there: ' + warns[0].title + '.' : 'Nearly there. ' + warns.length + ' things are worth a look.'
  return { worst, headline, first, onlyOffline, fixable: list.filter((c) => c.fix && (c.status === 'fail' || c.status === 'warn')).map((c) => c.id) }
}

// What to try on the phone, chosen from what this computer found. Always ends with the phone-side basics.
export function phoneAdvice(checks) {
  const by = Object.fromEntries((checks || []).map((c) => [c.id, c]))
  const out = []
  if (by.server && by.server.status === 'fail') out.push('Open Beebo on the computer and wait until it says it is running.')
  if (by.firewall && by.firewall.status === 'fail') out.push('Press “Fix the firewall” above, then try the phone again.')
  if (by.lan && by.lan.status !== 'pass') out.push('Make sure the phone is on the same Wi-Fi as this computer, not a guest network and not mobile data.')
  if (by.sleep && by.sleep.status === 'warn') out.push('Wake this computer up. It may have gone to sleep.')
  if (by.internet && by.internet.offline) {
    const numbers = by.lan && by.lan.address ? ' (' + by.lan.address + ')' : ''
    out.push('The internet is down, but phones on the same Wi-Fi can still connect. In the Beebo app choose “Home” and type the numbers' + numbers + ' shown in Get Started, or scan its code.')
  }
  out.push('On the phone, turn Wi-Fi on and open the Beebo app’s “Can’t connect?” screen for its own checks.')
  return out
}

const TAG = { pass: 'OK', warn: 'WARNING', fail: 'PROBLEM', skip: 'skipped' }

// The lines added to the shareable report: no addresses, only what each check concluded.
export function reportText(checks) {
  const list = Array.isArray(checks) ? checks : []
  const lines = list.map((c) => '[' + (TAG[c.status] || c.status) + '] ' + c.id + ': ' + c.title)
  return lines.join('\n')
}
