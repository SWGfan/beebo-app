'use strict'
// The main-process half of "Can't connect? Fix it for me": gathers plain facts about this computer's
// connection, and carries out the one-click fixes. What the facts MEAN lives in
// src/lib/connectionDoctor.js so it can be tested without a computer that is actually broken.
//
// Every probe is bounded and tolerant: a probe that fails or hangs becomes `null` ("unknown"), never
// an exception. Nothing here sends anything to Beebo beyond a plain request to its own service.
//
// Fixes are a fixed list. The firewall fix uses the same netsh commands the installer does
// (installer/beebo-installer.nsh) and only asks Windows for administrator approval when it is
// needed, after the screen has explained why; it never elevates on its own.

const os = require('os')
const dns = require('dns')
const { execFile } = require('child_process')
const { probePort, checkFirewall, FIREWALL_RULE_NAME, parseFirewallRule } = require('./diagnostics')
const { redact } = require('./logRedact')

const POWER_SETTINGS_URI = 'ms-settings:powersleep'
const FIX_IDS = new Set(['restart', 'firewall', 'retryRouter', 'updateAddress', 'sleepSettings'])

const bounded = (promise, ms, fallback) => {
  let timer
  const t = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); if (timer.unref) timer.unref() })
  return Promise.race([Promise.resolve(promise).catch(() => fallback), t]).finally(() => clearTimeout(timer))
}

// `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` ends with the AC and then the battery value,
// each as 0x........ seconds. Reading the last two hex numbers works in every Windows language.
function parseStandbyMinutes(text) {
  const hex = String(text || '').match(/0x[0-9a-f]{8}/gi)
  if (!hex || hex.length < 2) return null
  const seconds = parseInt(hex[hex.length - 2], 16)
  if (!Number.isFinite(seconds)) return null
  return seconds === 0 ? 0 : Math.max(1, Math.round(seconds / 60))
}

function readSleepMinutes({ platform = process.platform, run = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      run('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE'], { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err && !stdout ? null : parseStandbyMinutes(stdout)))
    } catch (e) { resolve(null) }
  })
}

// Can this computer reach Beebo's service? One name lookup, then one plain HTTPS request. ANY answer
// from the service, even a 404, proves the path works; only a server error counts against beebo.tv.
async function probeBeebo({ url, fetchImpl, lookup = dns.promises.lookup, timeoutMs = 6000, now = Date.now } = {}) {
  const target = /^https:\/\//i.test(String(url || '')) ? String(url) : 'https://beebo.tv/'
  let host = 'beebo.tv'
  try { host = new URL(target).hostname } catch (e) { /* default */ }
  const t0 = now()
  let looked
  try { looked = await Promise.race([Promise.resolve(lookup(host)).then(() => 'ok'), new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), timeoutMs); if (t.unref) t.unref() })]) } catch (e) {
    return { reachable: false, error: 'dns' }
  }
  if (looked === 'timeout') return { reachable: false, error: 'timeout' }
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') return { reachable: null }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  let timer
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { try { if (ctl) ctl.abort() } catch (e) { /* ignore */ } resolve('timeout') }, timeoutMs); if (timer.unref) timer.unref() })
    const res = await Promise.race([doFetch(target, { method: 'HEAD', signal: ctl ? ctl.signal : undefined }), timeout])
    if (res === 'timeout') return { reachable: false, error: 'timeout' }
    if (res.status >= 500) return { reachable: false, error: 'http_5xx' }
    return { reachable: true, ms: Math.max(1, now() - t0) }
  } catch (e) {
    const m = String((e && (e.cause && e.cause.code || e.code || e.message)) || '')
    if (/CERT|SSL|TLS|SELF_SIGNED|EXPIRED/i.test(m)) return { reachable: false, error: 'tls' }
    return { reachable: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network' }
  } finally { if (timer) clearTimeout(timer) }
}

// ---- the firewall repair ---------------------------------------------------------------------
const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535

// The two netsh commands from the installer: remove every rule with Beebo's name (this also removes a
// Block rule Windows added when someone pressed Cancel), then add one Allow rule.
function firewallCommands(port) {
  if (!validPort(port)) throw new Error('bad port')
  return [
    ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + FIREWALL_RULE_NAME],
    ['advfirewall', 'firewall', 'add', 'rule', 'name=' + FIREWALL_RULE_NAME, 'dir=in', 'action=allow', 'protocol=TCP', 'localport=' + port, 'profile=any'],
  ]
}

// One elevated command line (a single Windows permission prompt for both steps). Only the fixed
// rule name and a validated integer go into it.
function elevatedFirewallInvocation(port) {
  const [del, add] = firewallCommands(port).map((a) => 'netsh ' + a.map((x) => (x.includes(' ') ? x.replace(/=(.*)$/, '="$1"') : x)).join(' '))
  const inner = del + ' & ' + add
  const script = "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','" + inner.replace(/'/g, "''") + "' -Verb RunAs -Wait -WindowStyle Hidden"
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], inner }
}

const needsElevation = (err, out) => /requires elevation|elevat|administrator|access is denied/i.test(String(out || '') + ' ' + String((err && err.message) || ''))

const runFile = (run, file, args, opts) => new Promise((resolve) => {
  try { run(file, args, Object.assign({ windowsHide: true }, opts), (err, stdout, stderr) => resolve({ err, out: String(stdout || '') + String(stderr || '') })) } catch (e) { resolve({ err: e, out: '' }) }
})

// Outcome: { ok, elevated, message, code } where code is one of
// fixed | declined | failed | not-windows | bad-port. Never throws.
async function repairFirewall({ port, platform = process.platform, run = execFile, timeoutMs = 90000 } = {}) {
  if (platform !== 'win32') return { ok: false, code: 'not-windows', message: 'The firewall fix is only for Windows.' }
  if (!validPort(port)) return { ok: false, code: 'bad-port', message: 'Beebo does not know which port it is using yet. Restart Beebo and try again.' }
  const [del, add] = firewallCommands(port)
  const first = await runFile(run, 'netsh', del, { timeout: 15000 })
  if (first.err && needsElevation(first.err, first.out)) {
    const inv = elevatedFirewallInvocation(port)
    const el = await runFile(run, inv.file, inv.args, { timeout: timeoutMs })
    if (el.err) {
      const declined = /canceled by the user|cancelled by the user|operation was canceled/i.test(el.out + ' ' + String(el.err.message || ''))
      return declined
        ? { ok: false, elevated: true, code: 'declined', message: 'You chose not to allow it, so nothing was changed.' }
        : { ok: false, elevated: true, code: 'failed', message: 'Windows did not let Beebo change the firewall.' }
    }
    return { ok: true, elevated: true, code: 'fixed', message: 'Done. Beebo’s firewall rule has been replaced.' }
  }
  // "No rules match" on the delete is fine: there was nothing to remove.
  if (first.err && !/No rules match/i.test(first.out)) return { ok: false, elevated: false, code: 'failed', message: 'Windows did not let Beebo change the firewall.' }
  const second = await runFile(run, 'netsh', add, { timeout: 15000 })
  if (second.err) return { ok: false, elevated: false, code: 'failed', message: 'Beebo removed the old rule but could not add the new one.' }
  return { ok: true, elevated: false, code: 'fixed', message: 'Done. Beebo’s firewall rule has been replaced.' }
}

// ---- gathering facts -------------------------------------------------------------------------
function createConnectionDoctor(deps) {
  const d = deps || {}
  const safe = (fn, fallback) => { try { const v = typeof fn === 'function' ? fn() : undefined; return v === undefined ? fallback : v } catch (e) { return fallback } }

  async function collectFacts() {
    const port = safe(d.getServerPort, 0)
    const signedIn = !!safe(d.isSignedIn, false)
    const remote = safe(d.getConnectionRemote, null)
    const addr = safe(d.getHomeAddressStatus, null)
    const [listening, firewall, cloud, dnsIps, sleepMinutes, internet] = await Promise.all([
      bounded(probePort(port, 1500, d.connect), 3000, null),
      bounded(checkFirewall({ platform: d.platform, run: d.execFile }), 8000, { applicable: true, present: null }),
      signedIn ? bounded(probeBeebo({ url: safe(d.getBackendUrl, ''), fetchImpl: d.fetchImpl }), 9000, { reachable: null }) : Promise.resolve({ reachable: null }),
      addr && addr.hostname && addr.state === 'ok'
        ? bounded((d.resolve4 || dns.promises.resolve4)(addr.hostname), 4000, null)
        : Promise.resolve(null),
      bounded(readSleepMinutes({ platform: d.platform, run: d.execFile }), 7000, null),
      // "Is the internet up at all?", for everyone, signed in or not. Only when the caller supplies a way to check
      // (main.js does): a plain connection that is opened and closed, or what Beebo has already seen. Never a request.
      d.probeInternet ? bounded(d.probeInternet(), 4000, null) : Promise.resolve(null),
    ])
    return {
      platform: d.platform || process.platform,
      server: { port, listening: port ? listening : null },
      firewall,
      network: { addresses: (safe(d.getNetworkAddresses, []) || []).map((a) => (typeof a === 'string' ? a : a.address)).filter(Boolean) },
      router: { server: safe(d.getPortMapStatus, null), rtc: safe(d.getRtcPortMapStatus, null) },
      remote,
      cloud: Object.assign({ signedIn }, cloud),
      internet: internet && typeof internet.online === 'boolean' ? { online: internet.online } : null,
      address: addr ? { state: addr.state, hostname: addr.hostname, ipv4: addr.ipv4, reason: addr.reason, dnsIpv4: Array.isArray(dnsIps) ? dnsIps : null } : null,
      sleep: { known: sleepMinutes !== null, acMinutes: sleepMinutes },
    }
  }

  // id -> { ok, message, ... }. Unknown ids are refused, so the window cannot ask for anything else.
  async function applyFix(id) {
    if (!FIX_IDS.has(id)) return { ok: false, message: 'Unknown fix.' }
    try {
      if (id === 'firewall') {
        const r = await repairFirewall({ port: safe(d.getServerPort, 0), platform: d.platform, run: d.execFile })
        const after = r.ok ? await bounded(checkFirewall({ platform: d.platform, run: d.execFile }), 8000, null) : null
        return Object.assign({}, r, { firewall: after })
      }
      if (id === 'retryRouter') {
        const mappers = [safe(d.getRtcPortMapper, null), safe(d.getPortMapper, null)].filter(Boolean)
        await bounded(Promise.all(mappers.map((m) => Promise.resolve().then(() => m.refresh()).catch(() => {}))), 15000, null)
        return { ok: true, message: 'Asked the router again.' }
      }
      if (id === 'updateAddress') {
        const h = safe(d.getHomeAddress, null)
        if (!h) return { ok: false, message: 'Your address is not set up yet.' }
        const r = await bounded(h.runOnce(), 25000, null)
        return { ok: !!(r && r.ok), message: r && r.ok ? 'Your address was updated.' : 'beebo.tv did not accept the update yet.' }
      }
      if (id === 'sleepSettings') {
        if (!d.openExternal) return { ok: false, message: 'Could not open Windows settings.' }
        await d.openExternal(POWER_SETTINGS_URI)
        return { ok: true, message: 'Opened Windows sleep settings.' }
      }
      if (id === 'restart') {
        if (!d.relaunch) return { ok: false, message: 'Could not restart.' }
        setTimeout(() => { try { d.relaunch() } catch (e) { /* the window stays open */ } }, 400)
        return { ok: true, message: 'Restarting Beebo…' }
      }
    } catch (e) { return { ok: false, message: 'That did not work.' } }
    return { ok: false, message: 'Unknown fix.' }
  }

  // The shareable report: the existing redacted diagnostics text plus the doctor's verdicts.
  async function buildReport(checksText) {
    const base = await d.diagnosticsText()
    const extra = typeof checksText === 'string' ? checksText.slice(0, 6000) : ''
    if (!extra) return base
    return base + '\n== Connection doctor ==\n' + redact(extra, { ips: false, maxLine: 300 }) + '\n'
  }

  return { collectFacts, applyFix, buildReport }
}

function register({ ipcMain, clipboard, ...deps }) {
  const doctor = createConnectionDoctor(deps)
  ipcMain.handle('doctor:facts', () => doctor.collectFacts())
  ipcMain.handle('doctor:fix', (_e, id) => doctor.applyFix(String(id || '')))
  ipcMain.handle('doctor:report', async (_e, checksText) => ({ text: await doctor.buildReport(checksText) }))
  ipcMain.handle('doctor:copyReport', async (_e, checksText) => {
    const text = await doctor.buildReport(checksText)
    if (clipboard) clipboard.writeText(text)
    return { ok: !!clipboard, chars: text.length }
  })
  return doctor
}

module.exports = {
  createConnectionDoctor, register, probeBeebo, readSleepMinutes, parseStandbyMinutes,
  repairFirewall, firewallCommands, elevatedFirewallInvocation, needsElevation, POWER_SETTINGS_URI, FIX_IDS, parseFirewallRule,
}
