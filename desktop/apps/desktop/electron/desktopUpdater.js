// Desktop self-updater for the installed (packaged) Beebo server.
//
// Feed: https://beeboentertainment.com/desktop-version.json
//   { version, url, sha256, size?, notes, publishedAtUtc, ... }
// Installs from 0.1.32/0.1.33 read the same file, so its shape only ever grows.
//
// THE FLOW (each step is a `phase` the update panel in the window shows):
//   available    the feed has a newer version
//   downloading  MB of MB, speed, "about 2 minutes left"; pause / resume;
//                network drops retry on their own and continue with HTTP Range
//   paused | retrying | error
//   verifying    SHA-256 of the whole file against the feed
//   ready        "Beebo will close for about 45 seconds and reopen" (learned
//                from earlier installs on this PC), with a warning when someone
//                is watching right now
//   waiting      install when nobody is watching / tonight
//   elevating    Windows is asking for permission (UAC)
//   installing   installer started; Beebo quits so its files can be replaced
// ...and after the relaunch the NEW version reports "Updated to 0.1.xx".
//
// Fail-safe rules kept from the previous version:
//   - a bad feed or network error never stops Beebo starting
//   - Beebo only quits once the elevated installer has actually STARTED; if the
//     permission prompt is declined it stays open and says so
//   - every step is logged to %APPDATA%\Beebo Entertainment\updater.log
//
// DIFFERENTIAL UPDATES (not adopted yet - the plan):
// electron-builder already writes "<installer>.exe.blockmap". electron-updater's
// NSIS differential download compares the NEW blockmap with the blockmap of the
// installer it downloaded LAST time (kept in %LOCALAPPDATA%\<app>-updater) and
// fetches only changed blocks with multi-range requests. Nothing is kept today,
// so the first differential update can only happen one release after we start
// caching. Steps: (1) keep the verified installer + its blockmap after install
// (instead of deleting it) under userData\update-cache; (2) the release script
// uploads "Beebo Entertainment Setup X.exe.blockmap" next to the exe and adds
// blockMapUrl + sha512 (base64, what the blockmap format uses) to the feed;
// (3) here: fetch both blockmaps, copy unchanged blocks from the cached exe,
// Range-download the rest, then check sha512 AND sha256 before launching -
// falling back to the full download on any mismatch. Feed fields are additive,
// so 0.1.32/0.1.33 keep working. Most of each release is Electron + ffmpeg,
// which don't change, so an update should need far less than the full file -
// how much less depends on how the 7-Zip package inside the installer shifts
// between builds, so measure with two real builds' blockmaps before building it.
// Held back for now because a differential assembly bug means an installer
// that fails verification, and this pass already changes the install flow.
//
// Installer arguments: --updated (electron-builder: close the running app
// without asking, skip first-run bits) --force-run (reopen Beebo when done)
// --beebo-eta=<seconds> (installer.nsh shows "about N seconds left").
const { app, dialog, BrowserWindow, shell } = require('electron')
const https = require('https')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const model = require('./updateModel')
const { downloadResumable, sha256File } = require('./updateDownload')
const marker = require('./updateMarker')
const trust = require('./updateTrust')
const platformPolicy = require('./platformPolicy')

// Swapped out by the tests (test/updater-decision.test.js) so no network, installer or
// PowerShell is ever touched.
const impl = {
  downloadResumable,
  startElevated: (exe, args, opts) => startElevated(exe, args, opts),
  exists: (p) => fs.existsSync(p),
  fetchJson: (url) => fetchJson(url),
  platform: () => process.platform, // a seam so the tests can act as Windows on any OS
  showItem: (p) => { try { shell.showItemInFolder(p) } catch (e) {} }
}

const VERSION_URL = 'https://beeboentertainment.com/desktop-version.json'
const MAX_REDIRECTS = 5
const FEED_MAX_CHARS = 256 * 1024

// --- settings store ------------------------------------------------------
let PREF_STORE = null
function bindPrefStore(store) { PREF_STORE = store }
function storeGet(k, d) { try { const v = PREF_STORE ? PREF_STORE.get(k) : undefined; return v === undefined ? d : v } catch (e) { return d } }
function storeSet(k, v) { try { if (PREF_STORE) PREF_STORE.set(k, v) } catch (e) {} }
function storeDelete(k) { try { if (PREF_STORE) PREF_STORE.delete(k) } catch (e) {} }

function readAutoUpdatePref() { return storeGet('autoInstallUpdates', false) === true }
function writeAutoUpdatePref(on) {
  storeSet('autoInstallUpdates', !!on)
  log('auto-install preference set to', !!on)
}

// --- logging -------------------------------------------------------------
let LOG_PATH = null
function logPath() {
  if (LOG_PATH) return LOG_PATH
  try { LOG_PATH = path.join(app.getPath('userData'), 'updater.log') } catch (e) { LOG_PATH = path.join(os.tmpdir(), 'beebo-updater.log') }
  return LOG_PATH
}
function log(...a) {
  const line = '[updater ' + new Date().toISOString() + '] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  try { console.log(line) } catch (e) {}
  try { fs.appendFileSync(logPath(), line + '\n') } catch (e) {}
}

function cmpVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error('too many redirects'))
    const lib = url.startsWith('http:') ? http : https
    const req = lib.get(url, { timeout: 20000, headers: { 'User-Agent': 'Beebo-Desktop-Updater' } }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        let next
        try { next = new URL(res.headers.location, url).toString() } catch (e) { return reject(e) }
        // An https address may not hand the request on to plain http (the feed carries the installer's fingerprint).
        if (!url.startsWith('http:') && !next.startsWith('https:')) return reject(new Error('redirect to an insecure address'))
        return resolve(get(next, redirects + 1))
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)) }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

async function fetchJson(url) {
  const res = await get(url)
  return await new Promise((resolve, reject) => {
    let data = ''
    res.setEncoding('utf8')
    res.on('data', (c) => {
      data += c
      if (data.length > FEED_MAX_CHARS) { try { res.destroy() } catch (e) {} reject(new Error('the update feed is too large')) } // a feed is a few KB
    })
    res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    res.on('error', reject)
  })
}

// --- status (what the badge reads) ----------------------------------------
let LAST_STATUS = { supported: false, available: false, current: '', latest: '', notes: '', checkedAt: 0 }
function lastUpdateStatus() { return LAST_STATUS }
// True while an update is being downloaded, checked or installed: keeps the PC from sleeping.
function isBusy() { return ['downloading', 'retrying', 'verifying', 'elevating', 'installing'].includes(PROGRESS.phase) }

async function fetchUpdateStatus() {
  const base = { supported: false, available: false, current: '', latest: '', notes: '', checkedAt: Date.now() }
  try {
    base.current = app.getVersion()
    if (!app.isPackaged || impl.platform() !== 'win32') {
      LAST_STATUS = base
      return base
    }
    base.supported = true
    const info = await impl.fetchJson(VERSION_URL)
    if (!info || !info.version || !info.url) throw new Error('version feed is missing version/url')
    base.latest = String(info.version)
    base.notes = info.notes ? String(info.notes) : ''
    base.size = Number(info.size) > 0 ? Number(info.size) : 0
    base.available = cmpVersions(info.version, base.current) > 0
    base.info = info
    // Lets the panel warn before a download that Beebo will refuse to install.
    const feed = trust.evaluateFeed(info)
    base.installable = feed.ok
    base.notInstallableReason = feed.reason
  } catch (e) {
    base.error = (e && e.message) || String(e)
    log('status check failed:', base.error)
  }
  base.installSeconds = installEstimate()
  LAST_STATUS = base
  return base
}

// --- progress state + broadcast -------------------------------------------
const IDLE_PROGRESS = { phase: 'idle' }
let PROGRESS = { ...IDLE_PROGRESS }
let job = null // { info, controller, estimator, dest, waitTimer, ... }
let lastSent = 0
let sendTimer = null

function windows() {
  try { return BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed()) } catch (e) { return [] }
}

function installEstimate() { return model.estimateInstallSeconds(storeGet('updateInstallDurations', [])) }

function viewersNow() {
  try { return model.activeViewers(PREF_STORE, Date.now()) } catch (e) { return [] }
}

function publicProgress() {
  const p = { ...PROGRESS }
  p.installSeconds = installEstimate()
  p.viewers = p.phase === 'ready' || p.phase === 'waiting' ? viewersNow() : []
  p.current = safeVersion()
  return p
}

function safeVersion() { try { return app.getVersion() } catch (e) { return '' } }

// Progress events arrive per chunk; the window gets at most ~4 updates a second.
function setProgress(patch, { immediate = false } = {}) {
  PROGRESS = { ...PROGRESS, ...patch, updatedAt: Date.now() }
  const flush = () => {
    sendTimer = null
    lastSent = Date.now()
    const payload = publicProgress()
    for (const w of windows()) {
      try { w.webContents.send('updates:progress', payload) } catch (e) {}
    }
    const main = windows()[0]
    if (main) {
      try {
        if (PROGRESS.phase === 'downloading' && PROGRESS.fraction != null) main.setProgressBar(Math.max(0.01, Math.min(0.99, PROGRESS.fraction)))
        else if (PROGRESS.phase === 'paused' || PROGRESS.phase === 'error') main.setProgressBar(Math.max(0.01, PROGRESS.fraction || 0.01), { mode: PROGRESS.phase === 'error' ? 'error' : 'paused' })
        else if (PROGRESS.phase === 'verifying' || PROGRESS.phase === 'elevating' || PROGRESS.phase === 'installing') main.setProgressBar(2, { mode: 'indeterminate' })
        else main.setProgressBar(-1)
      } catch (e) {}
    }
  }
  if (immediate || Date.now() - lastSent > 250) { if (sendTimer) clearTimeout(sendTimer); flush() }
  else if (!sendTimer) sendTimer = setTimeout(flush, 250)
}

function installerPathFor(version) {
  return path.join(app.getPath('temp'), 'BeeboEntertainmentSetup-' + version + '.exe')
}

// --- download ---------------------------------------------------------------
async function startDownload(info, { then = null, allowUnverified = false } = {}) {
  if (job && job.running) { if (then) job.then = then; return publicProgress() }
  if (!info) {
    const st = await fetchUpdateStatus()
    if (!st.available || !st.info) {
      setProgress({ phase: 'error', errorKind: 'feed', message: st.error ? "Couldn't reach the update server. Check the internet connection and try again." : 'No update is available right now.' }, { immediate: true })
      return publicProgress()
    }
    info = st.info
  }
  const version = String(info.version)
  const feed = trust.evaluateFeed(info)
  // No fingerprint means the download cannot be checked and the installer runs elevated:
  // refuse, unless the owner explicitly chose "download only" (nothing is ever run then).
  const downloadOnly = !feed.ok && feed.reason === 'no-fingerprint' && allowUnverified === true
  if (!feed.ok && !downloadOnly) {
    log('refusing update', version, '-', feed.reason)
    setProgress({
      phase: 'error', errorKind: feed.reason === 'no-fingerprint' ? 'nosha' : 'feed', version,
      canDownloadOnly: feed.downloadOnlyPossible, message: trust.messageFor(feed.reason)
    }, { immediate: true })
    return publicProgress()
  }
  const dest = installerPathFor(version)
  if (!job || job.version !== version) {
    if (job && job.waitTimer) clearTimeout(job.waitTimer)
    job = { version, info, dest, estimator: model.createEtaEstimator(), then: null }
  }
  job.info = info
  job.downloadOnly = downloadOnly
  job.verified = false
  if (then && !downloadOnly) job.then = then
  job.cancelled = false
  job.running = true
  job.controller = new AbortController()
  job.estimator.restart(0, Number(info.size) || 0, Date.now())
  let restarted = false
  setProgress({
    phase: 'downloading', version, notes: info.notes ? String(info.notes) : '',
    received: 0, total: Number(info.size) || 0, fraction: null, speedBps: 0, etaSeconds: null, etaText: '',
    stalled: false, message: '', errorKind: '', attempt: 0
  }, { immediate: true })
  log('downloading', info.url, '->', dest)
  const tick = setInterval(() => {
    // Keeps "stalled" honest when no data events arrive at all.
    if (!job || PROGRESS.phase !== 'downloading') return
    const snap = job.estimator.snapshot(Date.now())
    if (snap.stalled !== PROGRESS.stalled) setProgress({ stalled: snap.stalled, speedBps: snap.speedBps, etaSeconds: snap.etaSeconds, etaText: snap.stalled ? 'waiting for the network…' : model.formatEta(snap.etaSeconds) })
  }, 1000)
  try {
    const result = await impl.downloadResumable({
      url: String(info.url),
      dest,
      expectedSha256: feed.sha256,
      expectedSize: Number(info.size) || 0,
      signal: job.controller.signal,
      log,
      onPhase: (phase, extra) => {
        if (phase === 'verifying') setProgress({ phase: 'verifying', etaText: '', speedBps: 0 }, { immediate: true })
        else if (phase === 'retrying') setProgress({ phase: 'retrying', attempt: extra.attempt, message: extra.message, speedBps: 0, etaText: '' }, { immediate: true })
        else if (phase === 'downloading' && PROGRESS.phase !== 'downloading') setProgress({ phase: 'downloading', message: '' }, { immediate: true })
      },
      onProgress: ({ received, total }) => {
        const now = Date.now()
        if (!restarted) { job.estimator.restart(received, total, now); restarted = true }
        const snap = job.estimator.sample(received, now, total)
        setProgress({
          received, total, fraction: snap.fraction, speedBps: snap.speedBps,
          etaSeconds: snap.etaSeconds, etaText: snap.stalled ? 'waiting for the network…' : model.formatEta(snap.etaSeconds), stalled: snap.stalled
        })
      }
    })
    clearInterval(tick)
    job.running = false
    log('download ok', { sha256: result.sha256, bytes: result.bytes, resumedFrom: result.resumedFrom, verified: feed.ok, downloadOnly })
    job.ready = true
    job.verified = feed.ok && result.sha256 === feed.sha256
    if (downloadOnly) {
      log('WARNING: the feed has no sha256; saved without installing (owner chose download only)')
      setProgress({
        phase: 'ready', received: result.bytes, total: result.bytes, fraction: 1, speedBps: 0, etaText: '',
        verified: false, installBlocked: true, savedTo: dest, errorKind: '', message: trust.messageFor('download-only', dest)
      }, { immediate: true })
      return publicProgress()
    }
    setProgress({ phase: 'ready', received: result.bytes, total: result.bytes, fraction: 1, speedBps: 0, etaText: '', verified: job.verified, installBlocked: false, savedTo: '', canDownloadOnly: false, message: '' }, { immediate: true })
    if (job.then) {
      const mode = job.then
      job.then = null
      scheduleInstall(mode)
    }
  } catch (e) {
    clearInterval(tick)
    if (job) job.running = false
    const code = (e && e.code) || 'NETWORK'
    if (code === 'PAUSED' && job && job.cancelled) {
      log('download cancelled at', PROGRESS.received)
      setProgress({ ...IDLE_PROGRESS }, { immediate: true })
    } else if (code === 'PAUSED') {
      log('download paused at', PROGRESS.received)
      setProgress({ phase: 'paused', speedBps: 0, etaText: '' }, { immediate: true })
    } else if (code === 'SHA_MISMATCH') {
      setProgress({ phase: 'error', errorKind: 'sha', message: 'The download failed its security check (the fingerprint didn’t match), so it was deleted and nothing was installed. Try again; if it keeps happening, the download may be being tampered with.' }, { immediate: true })
    } else if (code === 'DISK') {
      setProgress({ phase: 'error', errorKind: 'disk', message: 'Couldn’t save the update: ' + e.message + '. Free some space on drive C: and try again.' }, { immediate: true })
    } else {
      log('download failed', code, e && e.message)
      setProgress({ phase: 'error', errorKind: 'network', message: 'The download stopped: ' + ((e && e.message) || 'network error') + '. What’s downloaded so far is kept — Retry continues from there.' }, { immediate: true })
    }
  }
  return publicProgress()
}

function pauseDownload() {
  if (job && job.running && job.controller) job.controller.abort()
  return publicProgress()
}

function resumeDownload() {
  if (!job) return startDownload(null)
  return startDownload(job.info)
}

function cancelUpdate() {
  if (job) {
    job.cancelled = true
    if (job.running && job.controller) job.controller.abort()
    if (job.waitTimer) clearTimeout(job.waitTimer)
    job.then = null
    job.waitMode = null
  }
  // Downloaded bytes are kept (a later "Install" reuses or resumes them);
  // the OS temp cleanup removes them eventually.
  setProgress({ ...IDLE_PROGRESS, phase: 'idle' }, { immediate: true })
  return publicProgress()
}

// --- when to install ----------------------------------------------------------
// mode: 'now' | 'idle' | 'tonight'
function scheduleInstall(mode) {
  if (job && job.ready) {
    const gate = trust.installGate(job)
    if (!gate.ok) return refuseInstall(gate.reason)
  }
  if (!job || !job.ready) {
    // Not downloaded yet: download first, then come back here.
    startDownload(job ? job.info : null, { then: mode }).catch(() => {})
    return publicProgress()
  }
  if (job.waitTimer) clearTimeout(job.waitTimer)
  job.waitMode = mode
  job.requestedAt = Date.now()
  job.idleSince = viewersNow().length ? null : Date.now()
  const check = () => {
    if (!job || job.waitMode !== mode) return
    const now = Date.now()
    const viewers = viewersNow()
    if (viewers.length) job.idleSince = null
    else if (!job.idleSince) job.idleSince = now
    const d = model.decideInstallTiming({ mode, viewerCount: viewers.length, now, idleSince: job.idleSince, requestedAt: job.requestedAt })
    if (d.action === 'install') {
      job.waitMode = null
      log('installing now (' + d.reason + ')')
      launchInstall().catch(() => {})
      return
    }
    setProgress({ phase: 'waiting', waitMode: mode, waitReason: d.reason, installAt: d.installAt || null }, { immediate: true })
    job.waitTimer = setTimeout(check, d.nextCheckMs || 30000)
  }
  check()
  return publicProgress()
}

// --- launching the installer -----------------------------------------------
function psStr(s) { return "'" + String(s).replace(/'/g, "''") + "'" }

// Start the installer ELEVATED with arguments. shell.openPath (the previous
// method) can raise the permission prompt but can't pass arguments, so the
// installer used to show "Beebo is running, close it?" and never learned the
// time estimate. Start-Process -Verb RunAs goes through the same ShellExecute
// elevation, waits for the person's answer (no timeout to miss), and tells us
// whether it started.
// The installer sits in a folder any program of this user can write to, sometimes for hours ("install tonight"),
// and it is then run with administrator rights. So the file is hashed again right before it is started and must
// still be the one whose fingerprint was verified after the download.
async function installerStillMatches(file, sha256) {
  const want = trust.normalizeSha256(sha256)
  if (!want) return false
  try { return (await sha256File(file)) === want } catch (e) { return false }
}

async function startElevated(exe, args, { sha256 } = {}) {
  // Belt and braces: this runs a Windows installer through PowerShell and must never be reached elsewhere.
  if (impl.platform() !== 'win32') return { ok: false, message: 'Installers only run on Windows.', noPowershell: true }
  if (sha256 !== undefined && !(await installerStillMatches(exe, sha256))) {
    return { ok: false, tampered: true, message: 'the downloaded installer changed after it was checked' }
  }
  return new Promise((resolve) => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      '  Unblock-File -LiteralPath ' + psStr(exe) + ' -ErrorAction SilentlyContinue',
      '  $p = Start-Process -FilePath ' + psStr(exe) + ' -ArgumentList @(' + args.map(psStr).join(',') + ') -Verb RunAs -PassThru',
      "  Write-Output ('ok:' + $p.Id)",
      '} catch {',
      "  Write-Output ('err:' + $_.Exception.Message)",
      '}'
    ].join('\n')
    let out = ''
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true })
    } catch (e) {
      return resolve({ ok: false, message: (e && e.message) || String(e), noPowershell: true })
    }
    child.stdout.on('data', (c) => { out += c.toString() })
    child.on('error', (e) => resolve({ ok: false, message: e.message, noPowershell: true }))
    child.on('close', () => {
      const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('ok:') || l.startsWith('err:')) || ''
      if (line.startsWith('ok:')) resolve({ ok: true, pid: Number(line.slice(3)) || 0 })
      else resolve({ ok: false, message: line.slice(4) || 'the installer did not start' })
    })
  })
}

// Shown instead of running the installer. `reason` is from updateTrust.installGate.
function refuseInstall(reason) {
  log('refusing to install:', reason)
  if (reason === 'download-only') {
    setProgress({ phase: 'ready', installBlocked: true, errorKind: '', message: trust.messageFor('download-only', job && job.dest) }, { immediate: true })
  } else {
    setProgress({
      phase: 'error', errorKind: reason === 'no-fingerprint' ? 'nosha' : 'verify', canDownloadOnly: reason === 'no-fingerprint',
      message: reason === 'not-verified'
        ? 'The download was not checked against its security fingerprint, so Beebo won’t install it. Nothing was changed. Try downloading it again.'
        : trust.messageFor(reason)
    }, { immediate: true })
  }
  return publicProgress()
}

let installing = false
async function launchInstall() {
  if (installing) return publicProgress()
  if (job && job.ready) {
    const gate = trust.installGate(job)
    if (!gate.ok) return refuseInstall(gate.reason)
  }
  if (!job || !job.ready || !impl.exists(job.dest)) {
    setProgress({ phase: 'error', errorKind: 'missing', message: 'The downloaded update is gone (Windows may have cleaned up temporary files). Download it again.' }, { immediate: true })
    if (job) job.ready = false
    return publicProgress()
  }
  installing = true
  const eta = installEstimate()
  const from = safeVersion()
  setProgress({ phase: 'elevating', message: '' }, { immediate: true })
  // Tell the watchdog BEFORE Beebo stops, so it doesn't restart the old exe
  // in the gap between this app quitting and the installer taking over.
  marker.writeMarker({ from, to: job.version })
  log('launching installer elevated', job.dest, 'eta', eta)
  const r = await impl.startElevated(job.dest, ['--updated', '--force-run', '--beebo-eta=' + eta], { sha256: trust.normalizeSha256(job.info && job.info.sha256) })
  if (!r.ok && r.tampered) {
    // The file is not what was downloaded and verified: never run it, never offer it again.
    installing = false
    marker.clearMarker()
    log('refusing to run the installer: it changed after verification')
    try { fs.unlinkSync(job.dest) } catch (e) {}
    job.ready = false
    job.verified = false
    setProgress({
      phase: 'error', errorKind: 'verify',
      message: 'The downloaded update changed after it was checked, so Beebo did not run it. Nothing was changed. Download it again.'
    }, { immediate: true })
    return publicProgress()
  }
  if (!r.ok) {
    installing = false
    marker.clearMarker()
    const declined = /cancel/i.test(r.message || '')
    log('installer did not start:', r.message)
    setProgress({
      phase: 'ready',
      errorKind: declined ? 'declined' : 'launch',
      message: declined
        ? 'Windows asked for permission and it wasn’t given, so nothing changed. Beebo is still running. Press Install again and choose Yes.'
        : 'The installer didn’t start (' + r.message + '). Nothing changed and Beebo is still running. You can also run it yourself: ' + job.dest
    }, { immediate: true })
    return publicProgress()
  }
  // Recorded before quitting; the new version reads it to show "Updated to"
  // and to learn how long this install took.
  storeSet('pendingUpdate', { from, to: job.version, notes: PROGRESS.notes || '', launchedAt: Date.now(), estimate: eta })
  log('installer started (pid ' + r.pid + ') — quitting so it can replace the files')
  setProgress({ phase: 'installing', message: '' }, { immediate: true })
  setTimeout(() => { try { app.quit() } catch (e) {} }, 800)
  return publicProgress()
}

// --- after a relaunch -----------------------------------------------------------
let AFTER = null // { kind: 'updated' | 'failed', from, to, notes, seconds }
function handleStartup() {
  const pending = storeGet('pendingUpdate', null)
  const current = safeVersion()
  const r = model.resolvePendingUpdate(pending, current, Date.now(), cmpVersions)
  if (r.kind === 'updated') {
    const secs = Math.round(r.seconds)
    storeSet('updateInstallDurations', model.recordInstallDuration(storeGet('updateInstallDurations', []), secs, { from: pending.from, to: pending.to }))
    AFTER = { kind: 'updated', from: pending.from, to: current, notes: pending.notes || '', seconds: secs }
    storeDelete('pendingUpdate')
    marker.clearMarker()
    log('updated', pending.from, '->', current, 'in', secs, 's')
    // The installer can be deleted now.
    try { fs.unlinkSync(installerPathFor(pending.to)) } catch (e) {}
  } else if (r.kind === 'failed') {
    AFTER = { kind: 'failed', from: current, to: pending.to, notes: '' }
    storeDelete('pendingUpdate')
    log('the update to', pending.to, 'did not finish; still on', current)
  } else if (r.kind === 'none' && pending) {
    storeDelete('pendingUpdate')
  }
  // A stale marker from a crashed install must not keep the watchdog away.
  const m = marker.readMarker()
  if (m.exists && !m.fresh) marker.clearMarker()
  return AFTER
}

function afterUpdateInfo() { return AFTER }
function ackAfterUpdate() { AFTER = null; return true }

// --- macOS: "download page" mode ---------------------------------------------------
// Reads the same feed for the version number only; the Windows installer URL in it is ignored.
async function checkMacDownloadPage(parent) {
  const info = await impl.fetchJson(VERSION_URL)
  const r = platformPolicy.describeMacUpdate({ current: app.getVersion(), feed: info, cmp: cmpVersions })
  if (!r.ok) throw new Error(r.error)
  if (!r.available) {
    log('mac: up to date at', r.current)
    dialog.showMessageBox(parent, { type: 'info', title: "You're up to date", message: 'Beebo ' + r.current + ' is the latest version.' })
    return r
  }
  log('mac: update available', r.current, '->', r.latest)
  const res = await dialog.showMessageBox(parent, {
    type: 'info', title: 'Update available', message: 'Beebo ' + r.latest + ' is available (you have ' + r.current + ').',
    detail: (r.notes ? r.notes + '\n\n' : '') + 'Download the new version from the Beebo website and drag it over the old one in Applications.',
    buttons: ['Open download page', 'Later'], defaultId: 0, cancelId: 1
  })
  if (res && res.response === 0) { try { shell.openExternal(r.pageUrl) } catch (e) {} }
  return r
}

// --- the startup / menu check -----------------------------------------------------
// manual=true: "Check for updates" from the tray or Settings — say something
// either way, and open the in-window update panel when there is one.
// Unattended (auto preference on, or opts.auto): download in the background,
// then install when nobody is watching.
async function checkForDesktopUpdate(opts = {}) {
  const manual = !!opts.manual
  const parent = BrowserWindow.getFocusedWindow() || windows()[0] || null
  try {
    if (!app.isPackaged) {
      if (manual) dialog.showMessageBox(parent, { type: 'info', title: 'Updates', message: 'This is a development build.', detail: 'Automatic updates run on the installed app. From source, update with git.' })
      return
    }
    const mode = platformPolicy.updateMode(impl.platform(), app.isPackaged)
    if (mode === 'download-page') {
      // macOS: no installer is ever downloaded or run. Say whether a newer version exists and
      // open the download page (docs/MACOS.md, "Updates").
      if (manual) await checkMacDownloadPage(parent)
      return
    }
    if (mode !== 'installer') {
      if (manual) dialog.showMessageBox(parent, { type: 'info', title: 'Updates', message: 'Automatic updates are not available for this build.' })
      return
    }
    const st = await fetchUpdateStatus()
    if (st.error) throw new Error(st.error)
    for (const w of windows()) { try { w.webContents.send('updates:status', { ...st, openPrompt: manual && st.available }) } catch (e) {} }
    if (!st.available) {
      log('up to date at', st.current)
      if (manual) dialog.showMessageBox(parent, { type: 'info', title: "You're up to date", message: 'Beebo ' + st.current + ' is the latest version.' })
      return
    }
    log('update available', st.current, '->', st.latest)
    if (opts.auto === true) {
      // "Install now" from the prompt: the person is here and asked.
      await startDownload(st.info, { then: 'now' })
      return
    }
    if (!manual && readAutoUpdatePref()) {
      log('auto-install is on — downloading, then installing when nobody is watching')
      await startDownload(st.info, { then: 'idle' })
      return
    }
    if (manual && parent) { try { if (!parent.isVisible()) parent.show(); parent.focus() } catch (e) {} }
  } catch (e) {
    log('check failed:', (e && e.message) || String(e))
    if (manual) {
      // No internet is not an error worth alarming anyone about: say so, and say that everything at home still works.
      const raw = String((e && e.message) || e)
      const offline = /ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED|timeout|getaddrinfo|fetch failed/i.test(raw)
      dialog.showMessageBox(parent, offline
        ? { type: 'info', title: 'You’re offline', message: "Couldn't check for updates because this computer is offline.", detail: 'Everything on your home network still works. Beebo will check again by itself when the internet is back.' }
        : { type: 'warning', title: 'Update check failed', message: "Couldn't check for updates right now.", detail: raw })
    }
  }
}

// IPC for the update panel. main.js keeps the older channels (status, auto
// preference, installNow); these are the new, finer-grained ones.
function registerUpdateIpc(ipcMain) {
  ipcMain.handle('updates:progress', () => publicProgress())
  ipcMain.handle('updates:download', () => startDownload(job ? job.info : null))
  // The owner's explicit choice for a feed with no fingerprint: save the file, run nothing.
  ipcMain.handle('updates:downloadOnly', () => startDownload(job ? job.info : null, { allowUnverified: true }))
  ipcMain.handle('updates:showFile', () => { if (job && job.dest && impl.exists(job.dest)) impl.showItem(job.dest); return true })
  ipcMain.handle('updates:pause', () => pauseDownload())
  ipcMain.handle('updates:resume', () => resumeDownload())
  ipcMain.handle('updates:cancel', () => cancelUpdate())
  ipcMain.handle('updates:install', (_e, mode) => scheduleInstall(['now', 'idle', 'tonight'].includes(mode) ? mode : 'now'))
  ipcMain.handle('updates:afterUpdate', () => afterUpdateInfo())
  ipcMain.handle('updates:ackAfterUpdate', () => ackAfterUpdate())
}

module.exports = {
  checkForDesktopUpdate,
  cmpVersions,
  fetchUpdateStatus,
  lastUpdateStatus,
  isBusy,
  bindPrefStore,
  readAutoUpdatePref,
  writeAutoUpdatePref,
  registerUpdateIpc,
  handleStartup,
  startDownload,
  scheduleInstall,
  launchInstall,
  // Test seam: swap the network/installer pieces and read the current state.
  __test: { impl, installerStillMatches, progress: () => publicProgress(), reset: () => { job = null; installing = false; PROGRESS = { ...IDLE_PROGRESS } }, setJob: (j) => { job = j } }
}
