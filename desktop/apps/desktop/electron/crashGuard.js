'use strict'
// Makes crashes visible and survivable in the main process.
//
//  - A failure while Beebo is starting is fatal and is SAID, in plain words, with a
//    "Copy diagnostics" button. Nothing about startup is swallowed: a window-less,
//    tray-less app that looks running but is not serving anyone is the worst outcome.
//  - After startup, an uncaught exception or rejection is logged and Beebo keeps serving.
//    A home server that exits because one request handler threw (or because a closed stdout
//    pipe made console.log throw EPIPE) would silently end every away-from-home promise.
//  - The window's renderer crashing reloads it (a few times, then it stops and says why);
//    other Electron child processes (GPU, utility) are logged. The away-from-home host agent
//    is a plain Node child managed by remoteHostAgent.js, which already restarts it with
//    backoff and logs every exit.
//
// Everything is injected so it can be tested without Electron.

const SUPPORT_EMAIL = 'support@beeboentertainment.com'
const RENDERER_RELOAD_LIMIT = 3
const RENDERER_RELOAD_WINDOW_MS = 10 * 60 * 1000
const EXCEPTION_LOG_BURST = 20
const EXCEPTION_LOG_WINDOW_MS = 60 * 1000

function errText(err) {
  if (err && err.stack) return String(err.stack)
  if (err && err.message) return String(err.message)
  try { return typeof err === 'string' ? err : JSON.stringify(err) } catch (e) { return String(err) }
}

// A short, redacted first line for the dialog; the full detail goes to the diagnostics.
function shortReason(err, redact) {
  const first = String((err && err.message) || err || 'unknown error').split(/\r?\n/)[0].slice(0, 300)
  return redact ? redact(first) : first
}

function createCrashGuard(deps) {
  const {
    app, dialog, clipboard, proc = process, now = Date.now,
    log = (...a) => console.error(...a),
    buildDiagnostics,   // (err?) => string | Promise<string>, already redacted
    saveDiagnostics,    // (text) => Promise<string|null>: asks where to save, returns the path or null
    flushLogs = () => {},
    redact,
    setTimeoutFn = setTimeout,
    exit = (code) => app.exit(code)
  } = deps

  let started = false
  let fatalShown = false
  let exceptionTimes = []
  let suppressedExceptions = 0
  const rendererReloads = []
  const RELOAD_DELAY_MS = 500

  async function safeDiagnostics(err) {
    try { return buildDiagnostics ? String(await buildDiagnostics(err)) : '' } catch (e) {
      const fallback = 'Beebo diagnostics could not be fully built (' + shortReason(e, redact) + ').\nLast error: ' + shortReason(err, redact)
      return fallback
    }
  }

  function noteException(kind, err) {
    const t = now()
    exceptionTimes = exceptionTimes.filter((x) => t - x < EXCEPTION_LOG_WINDOW_MS)
    exceptionTimes.push(t)
    if (exceptionTimes.length > EXCEPTION_LOG_BURST) {
      suppressedExceptions++
      if (suppressedExceptions === 1 || suppressedExceptions % 100 === 0) log('[crash] ' + kind + ' repeating rapidly; ' + suppressedExceptions + ' more suppressed from this log')
      return
    }
    suppressedExceptions = 0
    log('[crash] ' + kind + ': ' + errText(err))
  }

  async function fatalStartup(err) {
    if (fatalShown) return
    fatalShown = true
    try { log('[crash] FATAL while starting: ' + errText(err)) } catch (e) { /* ignore */ }
    try { flushLogs() } catch (e) { /* ignore */ }
    const reason = shortReason(err, redact)
    try {
      await Promise.race([app.whenReady(), new Promise((r) => setTimeoutFn(r, 8000))])
    } catch (e) { /* show the dialog anyway */ }
    let report = null
    try {
      let note = ''
      for (;;) {
        const r = await dialog.showMessageBox({
          type: 'error',
          title: 'Beebo could not start',
          message: 'Beebo ran into a problem while starting and had to stop.',
          detail: 'Your videos and photos were not touched.\n\nWhat went wrong: ' + reason +
            '\n\nIf it happens again, choose Copy diagnostics and send it to ' + SUPPORT_EMAIL + '. It contains no passwords, sign-in details or file names.' + note,
          buttons: ['Copy diagnostics', 'Save diagnostics file', 'Close'],
          defaultId: 0,
          cancelId: 2,
          noLink: true
        })
        if (r.response === 2) break
        if (report === null) report = await safeDiagnostics(err)
        if (r.response === 0) {
          try { clipboard.writeText(report); note = '\n\nCopied. You can paste it into an email.' } catch (e) { note = '\n\nCould not copy to the clipboard.' }
        } else if (r.response === 1 && saveDiagnostics) {
          try {
            const saved = await saveDiagnostics(report)
            note = saved ? '\n\nSaved to ' + saved : ''
          } catch (e) { note = '\n\nCould not save the file.' }
        }
      }
    } catch (dialogErr) {
      try { dialog.showErrorBox('Beebo could not start', 'Beebo ran into a problem while starting and had to stop.\n\n' + reason) } catch (e) { /* nothing left to try */ }
    }
    try { flushLogs() } catch (e) { /* ignore */ }
    exit(1)
  }

  // A packaged app has no console, so writes to stdout/stderr can fail with EPIPE at any
  // moment, including while starting. That is not a reason to refuse to start.
  function isBenign(err) {
    const code = err && err.code
    return code === 'EPIPE' || code === 'ERR_STREAM_WRITE_AFTER_END' || code === 'ERR_STREAM_DESTROYED'
  }

  function onUncaughtException(err) {
    noteException('uncaughtException', err)
    if (!started && !isBenign(err)) fatalStartup(err)
  }

  function onUnhandledRejection(reason) {
    // Never fatal, even at startup: many startup promises are best-effort by design.
    noteException('unhandledRejection', reason)
  }

  function onRenderProcessGone(_event, webContents, details) {
    const reason = details && details.reason
    log('[crash] window process gone: reason=' + reason + ' exitCode=' + (details && details.exitCode))
    if (reason === 'clean-exit' || reason === 'killed') return
    const t = now()
    while (rendererReloads.length && t - rendererReloads[0] > RENDERER_RELOAD_WINDOW_MS) rendererReloads.shift()
    if (rendererReloads.length >= RENDERER_RELOAD_LIMIT) {
      log('[crash] the window has crashed ' + RENDERER_RELOAD_LIMIT + ' times in 10 minutes; not reloading again')
      try {
        dialog.showMessageBox({
          type: 'warning', title: 'Beebo window problem',
          message: 'The Beebo window keeps closing unexpectedly.',
          detail: 'Beebo is still running in the background and phones and TVs can still connect. Use the Beebo icon by the clock to open it again. If it keeps happening, send diagnostics to ' + SUPPORT_EMAIL + ' (Settings > Help).',
          buttons: ['OK']
        })
      } catch (e) { /* ignore */ }
      return
    }
    rendererReloads.push(t)
    setTimeoutFn(() => {
      try { if (webContents && !webContents.isDestroyed()) webContents.reload() } catch (e) { log('[crash] reload after crash failed: ' + (e && e.message)) }
    }, RELOAD_DELAY_MS)
  }

  function onChildProcessGone(_event, details) {
    if (details && details.reason === 'clean-exit') return
    log('[crash] ' + ((details && details.type) || 'child') + ' process gone: reason=' + (details && details.reason) + ' exitCode=' + (details && details.exitCode) + (details && details.name ? ' name=' + details.name : ''))
  }

  function install() {
    proc.on('uncaughtException', onUncaughtException)
    proc.on('unhandledRejection', onUnhandledRejection)
    app.on('render-process-gone', onRenderProcessGone)
    app.on('child-process-gone', onChildProcessGone)
  }

  return {
    install,
    markStarted() { started = true },
    isStarted: () => started,
    fatalStartup,
    onUncaughtException, onUnhandledRejection, onRenderProcessGone, onChildProcessGone
  }
}

module.exports = { createCrashGuard, shortReason, errText, SUPPORT_EMAIL, RENDERER_RELOAD_LIMIT }
