'use strict'
// The "Copy diagnostics" report: what a support person needs to see why Beebo is not
// reachable or not starting, and nothing more.
//
// It is built from an explicit allow-list of facts (versions, yes/no states, counts), never
// by dumping settings or status objects, so a secret cannot be included by accident. The
// finished text then goes through logRedact.js once more as a safety net, with the user's
// name, the computer's name and the library folders added to what is hidden.
//
// Not included, by design: tokens, licence keys, passwords, e-mail addresses, the Beebo
// name, IP addresses, anything under the library folders (folder or file names), and the
// contents of any setting.

const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const { execFile } = require('child_process')
const { redact } = require('./logRedact')
const { lastProblems } = require('./mainLog')

const FIREWALL_RULE_NAME = 'Beebo Entertainment' // installer/beebo-installer.nsh
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm'])

// Free text that a component wrote about itself: other people's addresses and anything
// credential-shaped are hidden, the household's own private addresses stay.
const free = (v) => redact(String(v == null ? '' : v), { maxLine: 300 })
const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown')
const mb = (b) => (Number.isFinite(b) ? Math.round(b / (1024 * 1024)).toLocaleString('en-US') + ' MB' : 'unknown')
const gb = (b) => (Number.isFinite(b) ? (b / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : 'unknown')

// Counts video files without recording a single name. Bounded in entries and time so a huge
// or sleeping NAS cannot stall the report, and asynchronous so the media server sharing this
// process is never blocked while it walks.
async function countVideos(dir, opts) {
  const o = Object.assign({ maxDepth: 4, maxEntries: 40000, maxMs: 1500 }, opts)
  const started = Date.now()
  let entries = 0
  let count = 0
  let truncated = false
  const walk = async (d, depth) => {
    if (truncated) return
    let items
    try { items = await fs.promises.readdir(d, { withFileTypes: true }) } catch (e) { return }
    for (const it of items) {
      if (++entries > o.maxEntries || Date.now() - started > o.maxMs) { truncated = true; return }
      if (it.isDirectory()) { if (depth < o.maxDepth) await walk(path.join(d, it.name), depth + 1) } else if (VIDEO_EXT.has(path.extname(it.name).toLowerCase())) count++
    }
  }
  let exists = false
  try { exists = (await fs.promises.stat(dir)).isDirectory() } catch (e) { exists = false }
  if (exists) await walk(dir, 0)
  return { exists, count, truncated }
}

function freeBytesOf(dir, statfs) {
  try {
    const s = (statfs || fs.statfsSync)(dir)
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }
  } catch (e) { return null }
}

function probePort(port, timeoutMs, connect) {
  return new Promise((resolve) => {
    if (!port) return resolve(false)
    const sock = (connect || net.connect)({ host: '127.0.0.1', port })
    let done = false
    const end = (v) => { if (done) return; done = true; try { sock.destroy() } catch (e) { /* ignore */ } resolve(v) }
    sock.setTimeout(timeoutMs, () => end(false))
    sock.on('connect', () => end(true))
    sock.on('error', () => end(false))
  })
}

// Reads what `netsh advfirewall firewall show rule` says about our rule name. Windows can hold
// several rules with the same name (an installer's Allow rule plus a Block rule Windows adds when
// someone answers "Cancel" to its firewall prompt), and a Block wins, so every rule is reported.
// Only the facts that matter are kept: is it on, which way, allow or block, protocol, port, profiles.
function parseFirewallRule(text) {
  const out = String(text || '')
  if (/No rules match/i.test(out)) return { present: false, rules: [] }
  const blocks = out.split(/^\s*Rule Name:/im).slice(1)
  if (!blocks.length) return { present: null, rules: [] }
  const rules = blocks.slice(0, 8).map((b) => {
    const field = (name) => { const m = new RegExp('^\\s*' + name + ':\\s*(.+?)\\s*$', 'im').exec(b); return m ? m[1] : '' }
    return {
      enabled: /^yes$/i.test(field('Enabled')),
      direction: field('Direction'),
      action: field('Action'),
      protocol: field('Protocol'),
      localPort: field('LocalPort'),
      profiles: field('Profiles')
    }
  })
  return { present: true, rules }
}

function checkFirewall({ platform = process.platform, run = execFile, timeoutMs = 6000 } = {}) {
  if (platform !== 'win32') return Promise.resolve({ applicable: false })
  return new Promise((resolve) => {
    let finished = false
    const done = (v) => { if (!finished) { finished = true; resolve(v) } }
    try {
      run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + FIREWALL_RULE_NAME], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err && !stdout) return done({ applicable: true, present: null, error: (err && err.code) || 'failed' })
        done(Object.assign({ applicable: true }, parseFirewallRule(stdout)))
      })
    } catch (e) { done({ applicable: true, present: null, error: 'failed' }) }
  })
}

function section(title, lines) {
  return '== ' + title + ' ==\n' + lines.filter((l) => l !== null && l !== undefined).join('\n') + '\n'
}

function mapperLines(label, s) {
  if (!s) return [label + ': not started']
  return [
    label + ': ' + (s.active ? 'router accepted the request' : 'no mapping'),
    '  reachable from the internet: ' + yn(s.reachable),
    s.method ? '  method: ' + s.method : null,
    s.kind ? '  kind: ' + s.kind : null,
    s.reason ? '  detail: ' + free(s.reason) : null,
    Array.isArray(s.mappings) ? '  ports mapped: ' + s.mappings.length : null
  ]
}

/**
 * Every input is optional and guarded: a component that is not up yet, or that throws, is
 * reported as "unknown", never as a failure of the report.
 */
async function buildDiagnostics(deps) {
  const d = deps || {}
  const safe = (fn, fallback) => { try { const v = typeof fn === 'function' ? fn() : undefined; return v === undefined ? fallback : v } catch (e) { return fallback } }
  const now = d.now || Date.now
  const osMod = d.os || os
  const userName = safe(() => osMod.userInfo().username, '')
  const hostName = safe(() => osMod.hostname(), '')
  const libraryDirs = (safe(d.getLibraryDirs, []) || []).filter(Boolean)

  const port = safe(d.getServerPort, 0)
  const [listening, firewall] = await Promise.all([
    probePort(port, 1500, d.connect),
    checkFirewall({ platform: d.platform, run: d.execFile })
  ])

  const lines = []
  const add = (t, l) => lines.push(section(t, l))

  add('Beebo diagnostics', [
    'Created: ' + new Date(now()).toISOString(),
    'This report lists versions, yes/no states and counts. It has no passwords, sign-in details, e-mail addresses, IP addresses or file names.'
  ])

  const v = safe(d.getVersions, {}) || {}
  add('App', [
    'Beebo version: ' + (safe(d.getAppVersion, 'unknown')),
    'Installed build (not a development copy): ' + yn(safe(d.isPackaged, undefined)),
    'Electron ' + (v.electron || '?') + ', Chrome ' + (v.chrome || '?') + ', Node ' + (v.node || '?'),
    'Started with Windows / hidden: ' + yn(safe(d.startedHidden, undefined)),
    'Running for: ' + Math.round(safe(() => process.uptime(), 0) / 60) + ' minutes'
  ])

  add('Computer', [
    'OS: ' + osMod.platform() + ' ' + osMod.release() + ' (' + osMod.arch() + ')',
    'CPU cores: ' + safe(() => osMod.cpus().length, '?'),
    'Memory: ' + mb(safe(() => osMod.freemem(), NaN)) + ' free of ' + mb(safe(() => osMod.totalmem(), NaN)),
    'PC has been on for: ' + Math.round(safe(() => osMod.uptime(), 0) / 3600 * 10) / 10 + ' hours'
  ])

  const diskLines = []
  const userData = safe(d.getUserDataDir, '')
  const seen = new Set()
  const diskOf = (label, dir) => {
    if (!dir) return
    const root = path.parse(path.resolve(dir)).root.toLowerCase()
    if (seen.has(root)) return
    seen.add(root)
    const f = freeBytesOf(dir, d.statfs)
    diskLines.push(label + ' (drive ' + (root.replace(/[\\/]+$/, '') || 'root') + '): ' + (f ? gb(f.free) + ' free of ' + gb(f.total) : 'unknown'))
  }
  diskOf('Beebo settings drive', userData)
  libraryDirs.forEach((dir, i) => diskOf('Library drive ' + (i + 1), dir))
  add('Disk space', diskLines.length ? diskLines : ['unknown'])

  const libLines = []
  const libs = safe(d.getLibraries, []) || []
  for (const lib of libs.slice(0, 6)) {
    if (!lib || !lib.dir) continue
    const c = await (d.countVideos || countVideos)(lib.dir)
    libLines.push(lib.label + ' folder: ' + (c.exists ? 'found' : 'NOT FOUND') + (c.exists ? ', ' + c.count + (c.truncated ? '+' : '') + ' video files' : ''))
  }
  add('Library', libLines.length ? libLines : ['no library folders set'])

  add('Server', [
    'Port: ' + (port || 'unknown'),
    'Answering on this PC: ' + yn(port ? listening : undefined),
    'Secure (HTTPS) certificate active: ' + yn(safe(d.getHttpsActive, undefined))
  ])

  const fwLines = () => {
    if (firewall.applicable === false) return ['Not applicable on this system']
    if (firewall.present === false) return ['Rule "' + FIREWALL_RULE_NAME + '": MISSING (phones on the Wi-Fi may not be able to connect)']
    if (firewall.present === null) return ['Rule "' + FIREWALL_RULE_NAME + '": could not be checked' + (firewall.error ? ' (' + firewall.error + ')' : '')]
    const rules = firewall.rules || []
    const lines = rules.map((r, i) => 'Rule ' + (i + 1) + ' of ' + rules.length + ' named "' + FIREWALL_RULE_NAME + '": enabled: ' + yn(r.enabled) + ', ' + r.direction + ' ' + r.action + ' ' + r.protocol + ' port ' + r.localPort + ', profiles: ' + r.profiles)
    const blocking = rules.some((r) => r.enabled && /^in/i.test(r.direction) && /^block/i.test(r.action))
    const allowing = rules.some((r) => r.enabled && /^in/i.test(r.direction) && /^allow/i.test(r.action))
    if (blocking) lines.push('WARNING: an enabled inbound Block rule has this name; Windows applies Block before Allow, so phones may be refused.')
    else if (!allowing) lines.push('WARNING: no enabled inbound Allow rule was found.')
    return lines
  }
  add('Windows Firewall', fwLines())

  const up = safe(d.getPortMapStatus, null)
  const rtcUp = safe(d.getRtcPortMapStatus, null)
  add('Router (UPnP / NAT-PMP)', [].concat(mapperLines('Server port', up), mapperLines('Away-from-home ports', rtcUp)))

  const rh = safe(d.getRemoteHostStatus, null)
  add('Away from home', rh ? [
    'Signed in: ' + yn(safe(d.isSignedIn, undefined)),
    'Host agent running: ' + yn(rh.running),
    'Registered with beebo.tv and online: ' + yn(rh.online),
    rh.problem ? 'Problem reported: ' + free(rh.problem) : null,
    'Someone connected now: ' + yn(!!rh.connection),
    rh.relay ? 'Relay: ' + (rh.relay.kind || 'none') + ' (' + (rh.relay.state || 'off') + ')' : null
  ] : ['Not started yet'])

  const ha = safe(d.getHomeAddressStatus, null)
  add('Home address', ha ? ['State: ' + (ha.state || 'unknown'), ha.reason ? 'Detail: ' + free(ha.reason) : null, ha.updatedAt ? 'Last confirmed: ' + ha.updatedAt : null] : ['Not started yet'])

  const ao = safe(d.getAlwaysOn, null)
  add('Always on', ao ? [
    'Start with Windows: ' + (ao.login && ao.login.supported ? yn(ao.login.enabled) + (ao.login.blockedByWindows ? ' (Windows has it switched off)' : '') : 'not available here'),
    'Keeping the PC awake right now: ' + yn(ao.awake && ao.awake.holding) + (ao.awake && ao.awake.reasons && ao.awake.reasons.length ? ' (' + ao.awake.reasons.join(', ') + ')' : '')
  ] : ['unknown'])

  const up2 = safe(d.getUpdateStatus, null)
  add('Updates', up2 ? [
    'Updates supported here: ' + yn(up2.supported),
    'Installed: ' + (up2.current || '?') + ', newest known: ' + (up2.latest || '?') + ', update waiting: ' + yn(up2.available),
    'Last check: ' + (up2.checkedAt ? new Date(up2.checkedAt).toISOString() : 'never') + (up2.error ? ' - failed: ' + free(up2.error) : ' - ok')
  ] : ['No update check has run yet'])

  const problems = lastProblems(safe(() => d.readLogTail(96 * 1024), ''), 25)
  add('Recent warnings and errors (newest last)', problems.length ? problems.map((p) => redact(p, { maxLine: 600, literals: [userName, hostName], libraryRoots: libraryDirs, files: true })) : ['none recorded'])

  const extra = safe(d.getStartupNotes, [])
  if (extra && extra.length) add('Startup notes', extra)

  const crash = d.error ? [String((d.error && d.error.stack) || (d.error && d.error.message) || d.error).split('\n').slice(0, 14).join('\n')] : null
  if (crash) add('Error that stopped Beebo from starting', crash)

  const text = lines.join('\n')
  return redact(text, {
    ips: false,
    maxLine: 2000,
    literals: [userName, hostName],
    libraryRoots: libraryDirs,
    files: true
  })
}

module.exports = { buildDiagnostics, countVideos, parseFirewallRule, checkFirewall, probePort, FIREWALL_RULE_NAME }
