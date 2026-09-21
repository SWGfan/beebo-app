'use strict'
// Puts the reliability pieces together for main.js, so main.js only needs a few lines:
//
//   const reliability = require('./reliability').early({ app, dialog, clipboard, shell })   // first thing
//   const store = reliability.openStore(Store)                                                // replaces new Store()
//   ...
//   reliability.start({ ... })                                                                // last thing in whenReady
//
// What lives where:
//   mainLog.js / logRedact.js   rolling redacted log of everything the main process prints
//   crashGuard.js               crash handlers and the "Beebo could not start" dialog
//   configStore.js              damaged config.json recovery and the daily copies
//   safeJson.js                 atomic JSON files (notices about repairs are collected here)
//   alwaysOn.js                 start at login, stay awake only when needed, redo network work after sleep
//   diagnostics.js              the "Copy diagnostics" report

const fs = require('fs')
const os = require('os')
const path = require('path')
const { createMainLog } = require('./mainLog')
const { createCrashGuard } = require('./crashGuard')
const configStore = require('./configStore')
const safeJson = require('./safeJson')
const alwaysOn = require('./alwaysOn')
const { buildDiagnostics } = require('./diagnostics')
const { redact } = require('./logRedact')

const NOTICE_FILES = /^(manifest|tv-manifest|credits|tv-credits|index)\.json$/

function early({ app, dialog, clipboard, shell }) {
  const userDataDir = app.getPath('userData')
  const mainLog = createMainLog({ dir: path.join(userDataDir, 'logs') })
  mainLog.install(console)
  try { process.on('exit', () => mainLog.flushSync()) } catch (e) { /* ignore */ }

  const state = {
    src: {},            // filled by start(): what the diagnostics need to look at
    keeper: null,
    loginItem: null,
    recovery: null,     // config.json recovery, shown once the app is ready
    configHandle: null,
    notices: [],
    ready: false,
    noticeTimer: null,
    quitBackedUp: false
  }

  function diagnosticsText(err) {
    const s = state.src
    return buildDiagnostics({
      error: err,
      getAppVersion: () => app.getVersion(),
      isPackaged: () => app.isPackaged,
      getVersions: () => process.versions,
      startedHidden: () => process.argv.includes('--hidden'),
      getUserDataDir: () => userDataDir,
      getServerPort: s.getServerPort,
      getLibraryDirs: s.getLibraryDirs,
      getLibraries: s.getLibraries,
      isSignedIn: s.isSignedIn,
      getRemoteHostStatus: s.getRemoteHostStatus,
      getPortMapStatus: s.getPortMapStatus,
      getRtcPortMapStatus: s.getRtcPortMapStatus,
      getHomeAddressStatus: s.getHomeAddressStatus,
      getUpdateStatus: s.getUpdateStatus,
      getAlwaysOn: () => alwaysOnState(),
      getStartupNotes: () => state.notices.map((n) => n.title + ': ' + n.detail.split('\n')[0]),
      readLogTail: (n) => mainLog.readTail(n)
    })
  }

  async function saveDiagnostics(text) {
    let defaultPath = 'beebo-diagnostics.txt'
    try { defaultPath = path.join(app.getPath('desktop'), 'beebo-diagnostics.txt') } catch (e) { /* use the bare name */ }
    const r = await dialog.showSaveDialog({ title: 'Save diagnostics', defaultPath, filters: [{ name: 'Text file', extensions: ['txt'] }] })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, text, 'utf8')
    return r.filePath
  }

  const crashGuard = createCrashGuard({
    app, dialog, clipboard,
    log: (m) => console.error(m),
    buildDiagnostics: diagnosticsText,
    saveDiagnostics,
    flushLogs: () => mainLog.flushSync(),
    redact
  })
  crashGuard.install()

  function alwaysOnState() {
    return {
      login: state.loginItem ? state.loginItem.state() : { supported: false, enabled: false, chosen: false, blockedByWindows: false },
      awake: state.keeper ? state.keeper.status() : { holding: false, reasons: [], since: 0 }
    }
  }

  // ---- notices about things Beebo repaired on its own ----------------------------------
  function queueNotice(n) {
    if (state.notices.some((x) => x.key === n.key)) return
    state.notices.push(n)
    if (state.ready) scheduleNotices()
  }
  function scheduleNotices() {
    if (state.noticeTimer) return
    state.noticeTimer = setTimeout(() => {
      state.noticeTimer = null
      const pending = state.notices.filter((n) => !n.shown)
      pending.forEach((n) => { n.shown = true })
      for (const n of pending) {
        console.log('[notice] ' + n.title)
        try { dialog.showMessageBox({ type: 'info', title: n.title, message: n.message, detail: n.detail, buttons: ['OK'] }) } catch (e) { /* the log has it */ }
      }
    }, 1500)
    if (state.noticeTimer.unref) state.noticeTimer.unref()
  }

  safeJson.setEventSink((e) => {
    const name = path.basename(e.file || '')
    if (!NOTICE_FILES.test(name)) return
    if (e.type === 'restored-from-backup') {
      queueNotice({
        key: 'safejson:' + name, title: 'Beebo repaired a damaged file',
        message: 'One of Beebo’s lists (' + name + ') was damaged, probably by a crash or power cut while it was saving.',
        detail: 'Beebo went back to the previous copy. Your videos were not touched. The damaged file was kept at:\n' + e.quarantinedTo
      })
    } else if (e.type === 'reset-to-defaults') {
      queueNotice({
        key: 'safejson:' + name, title: 'Beebo had to start a list again',
        message: 'One of Beebo’s lists (' + name + ') was damaged and there was no earlier copy.',
        detail: 'Title matches may need to be looked up again (Rescan does this). Your videos were not touched. The damaged file was kept at:\n' + e.quarantinedTo
      })
    }
  })

  function openStore(Store) {
    const r = configStore.openStore({ Store, userDataDir, log: (m) => console.warn(m) })
    state.configHandle = r
    state.recovery = configStore.describeRecovery(r.recovery)
    return r.store
  }

  function trayItems() {
    if (process.platform !== 'win32') return []
    return [
      { type: 'separator' },
      { label: 'Keeps the PC awake only while someone is watching', enabled: false },
      { label: 'If the PC sleeps, away from home stops - sleep settings', click: () => { try { shell.openExternal(alwaysOn.POWER_SETTINGS_URI) } catch (e) { /* ignore */ } } }
    ]
  }

  // ---- everything that needs the app to be running ---------------------------------------
  function start(s) {
    // Optional plumbing must never stop Beebo from starting; and startup counts as finished
    // whatever happens here, or a later harmless exception would be treated as fatal.
    try { startInner(s) } catch (e) { console.error('[start] could not finish setting up the always-on features: ' + ((e && e.stack) || e)) } finally { crashGuard.markStarted() }
  }

  function startInner(s) {
    state.src = s
    const { ipcMain, store, license } = s
    const electron = require('electron')

    const signedIn = () => { try { return !!license.getToken() } catch (e) { return false } }

    state.loginItem = alwaysOn.createLoginItem({
      app, store, isPackaged: app.isPackaged, hasSignedIn: () => signedIn() || !!(s.hasOwner && s.hasOwner()), log: (m) => console.log(m)
    })
    try { state.loginItem.sync() } catch (e) { console.warn('[startup] start-with-Windows check failed:', e && e.message) }

    const activeStreams = () => {
      const info = s.getServerInfo && s.getServerInfo()
      const dash = info && info.dashboard
      if (!dash) return false
      if (dash._streams && typeof dash._streams.values === 'function') {
        const t = Date.now()
        for (const st of dash._streams.values()) if ((st.open && st.open.size > 0) || t - (st.lastByteAt || 0) < 45000) return true
        return false
      }
      return typeof dash.nowPlaying === 'function' ? dash.nowPlaying().length > 0 : false
    }
    state.keeper = alwaysOn.createAwakeKeeper({
      powerSaveBlocker: electron.powerSaveBlocker,
      log: (m) => console.log(m),
      sources: {
        'someone is watching': activeStreams,
        'someone is connected away from home': () => { const st = s.getRemoteHostStatus && s.getRemoteHostStatus(); return !!(st && st.connection) },
        'an update is downloading': () => !!(s.isUpdating && s.isUpdating()),
        'a video is being converted': () => !!(s.isConverting && s.isConverting())
      }
    })
    state.keeper.start()

    const okOrSkip = (r) => !!(r && (r.ok || r.skipped))
    const recovery = alwaysOn.createResumeRecovery({
      powerMonitor: electron.powerMonitor,
      log: (m) => console.log(m),
      actions: [
        { name: 'router port mapping', run: async () => { const m = s.getPortMapper(); if (!m) return true; await m.refresh(); const st = m.status(); return !!(st && st.active) } },
        { name: 'router mapping for away-from-home video', run: async () => { const m = s.getRtcPortMapper(); if (!m) return true; await m.refresh(); const st = m.status(); return !!(st && st.active) } },
        { name: 'home address', run: async () => { const h = s.getHomeAddress(); if (!h) return true; return okOrSkip(await h.runOnce()) } },
        {
          name: 'away-from-home host',
          run: async () => {
            const h = s.getRemoteHost()
            if (!h || !signedIn()) return true
            h.start()
            try { h.refreshToken() } catch (e) { /* the agent asks again itself */ }
            return !!h.status().running
          }
        },
        { name: 'licence check', run: async () => { if (!license.config.enabled || !signedIn()) return true; const r = await license.revalidate(); return !!(r && (r.ok || r.reason === 'email_required')) } },
        {
          name: 'relay balance',
          run: async () => {
            const w = s.getWalletClient(); if (!w) return true
            const st = await w.refresh()
            return !(st && st.kind === 'error' && (st.error === 'unreachable' || /^http_5/.test(String(st.error))))
          }
        }
      ]
    })
    recovery.install()
    state.resume = recovery

    // Clean quit: give tomorrow a copy of today's final settings, and let the PC sleep again.
    electron.app.on('before-quit', () => {
      try { state.keeper.stop() } catch (e) { /* ignore */ }
      if (state.quitBackedUp || !state.configHandle) return
      state.quitBackedUp = true
      try { state.configHandle.backup({ refresh: true }) } catch (e) { /* never block quitting */ }
      try { mainLog.flushSync() } catch (e) { /* ignore */ }
    })

    // ---- IPC used by Settings > Always on and Settings > Help ---------------------------
    ipcMain.handle('alwaysOn:get', () => Object.assign(alwaysOnState(), {
      note: process.platform === 'darwin' ? alwaysOn.SLEEP_NOTE_MAC : alwaysOn.SLEEP_NOTE,
      platform: process.platform,
      powerSettingsSupported: process.platform === 'win32'
    }))
    ipcMain.handle('alwaysOn:setLoginItem', (_e, on) => { state.loginItem.set(!!on); return alwaysOnState().login })
    ipcMain.handle('alwaysOn:openPowerSettings', async () => {
      if (process.platform !== 'win32') return { ok: false }
      try { await electron.shell.openExternal(alwaysOn.POWER_SETTINGS_URI); return { ok: true } } catch (e) { return { ok: false } }
    })
    ipcMain.handle('diagnostics:preview', async () => ({ text: await diagnosticsText() }))
    ipcMain.handle('diagnostics:copy', async () => {
      const text = await diagnosticsText()
      electron.clipboard.writeText(text)
      return { ok: true, chars: text.length }
    })
    ipcMain.handle('diagnostics:save', async () => {
      const text = await diagnosticsText()
      const file = await saveDiagnostics(text)
      return file ? { ok: true, path: file } : { ok: false, canceled: true }
    })
    ipcMain.handle('diagnostics:openLogs', async () => {
      const r = await electron.shell.openPath(path.join(userDataDir, 'logs'))
      return { ok: !r }
    })

    // "Can't connect? Fix it for me" (connectionDoctorIpc.js): the checks, the one-click fixes and the report.
    require('./connectionDoctorIpc').register({
      ipcMain, clipboard: electron.clipboard,
      diagnosticsText: () => diagnosticsText(),
      getServerPort: s.getServerPort, isSignedIn: s.isSignedIn,
      getNetworkAddresses: s.getNetworkAddresses, getConnectionRemote: s.getConnectionRemote, getBackendUrl: s.getBackendUrl,
      getPortMapStatus: s.getPortMapStatus, getRtcPortMapStatus: s.getRtcPortMapStatus, getHomeAddressStatus: s.getHomeAddressStatus,
      getPortMapper: s.getPortMapper, getRtcPortMapper: s.getRtcPortMapper, getHomeAddress: s.getHomeAddress,
      openExternal: (u) => electron.shell.openExternal(u),
      relaunch: () => { electron.app.relaunch(); electron.app.exit(0) }
    })

    state.ready = true
    if (state.recovery) queueNotice(Object.assign({ key: 'config-recovery' }, state.recovery))
    if (state.notices.length) scheduleNotices()
    console.log('[start] Beebo ' + app.getVersion() + ' started on ' + os.platform() + ' ' + os.release() + (process.argv.includes('--hidden') ? ' (hidden, started with Windows)' : ''))
  }

  return {
    openStore,
    trayItems,
    start,
    fatalStartup: (err) => crashGuard.fatalStartup(err),
    signedIn: (result) => { try { if (result && result.ok && state.loginItem) state.loginItem.onSignedIn() } catch (e) { /* ignore */ } },
    // The home library needs no cloud account, so the first owner account is what turns start-with-Windows on.
    ownerCreated: (result) => { try { if (result && !result.error && state.loginItem) state.loginItem.onSignedIn() } catch (e) { /* ignore */ } },
    mainLog, crashGuard, diagnosticsText,
    _state: state
  }
}

module.exports = { early }
