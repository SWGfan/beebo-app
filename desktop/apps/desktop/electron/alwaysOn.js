'use strict'
// What "watch from anywhere" needs from the PC itself:
//   1. Beebo comes back by itself after a reboot (start at login, hidden in the tray).
//   2. The PC does not go to sleep while somebody is watching or a task is running,
//      and never stays awake otherwise (no permanent wake lock, display may always sleep).
//   3. After the PC wakes up, everything that depends on the network is redone,
//      because the router mapping, the public address and the connection to beebo.tv
//      may all have changed while it slept.
//
// Nothing here talks to Electron directly; main.js passes the pieces in, so it is testable.

const policy = require('./platformPolicy')

const LOGIN_ARGS = ['--hidden']
const SLEEP_NOTE = 'Beebo keeps your PC awake only while someone is watching or a task is running. If your PC goes to sleep, watching from away from home stops working until it wakes up. You can change when Windows goes to sleep in its power settings.'
const SLEEP_NOTE_MAC = 'Beebo keeps your Mac awake only while someone is watching or a task is running. If your Mac goes to sleep, watching from away from home stops working until it wakes up. You can change when your Mac sleeps in System Settings > Battery (or Energy Saver).'
const POWER_SETTINGS_URI = 'ms-settings:powersleep'

// ---------------------------------------------------------------------------
// 1. Start at login
// ---------------------------------------------------------------------------
function createLoginItem(deps) {
  const { app, store, isPackaged, platform = process.platform, execPath = process.execPath, hasSignedIn = () => false, log = () => {} } = deps
  // Windows and macOS. The OS setting is the same idea on both; only how it is expressed differs
  // (platformPolicy.js). Linux packages do not register a login item.
  const supported = policy.loginItemSupported(platform, isPackaged)
  const query = () => policy.loginItemQuery(platform, execPath, LOGIN_ARGS)

  function choice() {
    const v = store.get('startAtLogin')
    return typeof v === 'boolean' ? v : undefined
  }

  function apply(on) {
    if (!supported) return false
    try {
      app.setLoginItemSettings(policy.loginItemSettings(platform, on, execPath, LOGIN_ARGS))
      return true
    } catch (e) {
      log('[startup] could not update the start-with-Windows setting: ' + ((e && e.message) || e))
      return false
    }
  }

  // Reasserts the saved choice at every start (the install path can change with an update),
  // and gives the default to an install that is already signed in but has never chosen.
  function sync() {
    if (!supported) return
    const c = choice()
    if (c !== undefined) { apply(c); return }
    if (hasSignedIn()) {
      store.set('startAtLogin', true)
      apply(true)
      log('[startup] Beebo will now start with Windows (turn this off in Settings)')
    }
  }

  // First successful sign-in: default ON unless the person already made a choice.
  function onSignedIn() {
    if (!supported || choice() !== undefined) return
    store.set('startAtLogin', true)
    apply(true)
    log('[startup] Beebo will now start with Windows (turn this off in Settings)')
  }

  function set(on) {
    store.set('startAtLogin', !!on)
    return apply(!!on)
  }

  function state() {
    const c = choice()
    let willLaunch = false
    if (supported) {
      try {
        const s = app.getLoginItemSettings(query())
        willLaunch = s.executableWillLaunchAtLogin !== undefined ? !!s.executableWillLaunchAtLogin : !!s.openAtLogin
      } catch (e) { willLaunch = false }
    }
    const wanted = c === undefined ? false : c
    return {
      supported,
      enabled: supported ? (c === undefined ? willLaunch : c) : false,
      chosen: c !== undefined,
      // The person asked for it but the OS is not going to do it (Windows: Task Manager > Startup apps;
      // macOS: System Settings > General > Login Items). The field name is kept for the existing UI.
      blockedByWindows: supported && wanted && !willLaunch
    }
  }

  return { sync, onSignedIn, set, state, supported }
}

// ---------------------------------------------------------------------------
// 2. Stay awake only while there is a reason to
// ---------------------------------------------------------------------------
function createAwakeKeeper(deps) {
  const {
    powerSaveBlocker,
    // name -> () => boolean. A source that throws counts as "no".
    sources = {},
    log = () => {},
    now = Date.now,
    graceMs = 60 * 1000,
    intervalMs = 20 * 1000,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  } = deps

  let id = null
  let timer = null
  let lastActiveAt = 0
  let reasons = []
  let since = 0

  function activeReasons() {
    const out = []
    for (const [name, fn] of Object.entries(sources)) {
      try { if (fn()) out.push(name) } catch (e) { /* an unavailable source is not a reason */ }
    }
    return out
  }

  function evaluate() {
    reasons = activeReasons()
    const t = now()
    if (reasons.length) lastActiveAt = t
    // A short grace so a stream that pauses, or two jobs handing over, does not flap the lock.
    const hold = reasons.length > 0 || (id !== null && t - lastActiveAt < graceMs)
    if (hold && id === null) {
      try {
        id = powerSaveBlocker.start('prevent-app-suspension')
        since = t
        log('[power] keeping the PC awake: ' + reasons.join(', '))
      } catch (e) { id = null; log('[power] could not keep the PC awake: ' + ((e && e.message) || e)) }
    } else if (!hold && id !== null) {
      release('nothing is running')
    }
    return status()
  }

  function release(why) {
    try { powerSaveBlocker.stop(id) } catch (e) { /* already stopped */ }
    id = null
    since = 0
    log('[power] letting the PC sleep again (' + why + ')')
  }

  function start() {
    if (timer) return
    timer = setIntervalFn(evaluate, intervalMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    evaluate()
  }

  function stop() {
    if (timer) { clearIntervalFn(timer); timer = null }
    if (id !== null) release('Beebo is quitting')
  }

  function status() {
    return { holding: id !== null, reasons: reasons.slice(), since }
  }

  return { start, stop, evaluate, status }
}

// ---------------------------------------------------------------------------
// 3. Redo the network-dependent work after the PC wakes up
// ---------------------------------------------------------------------------
// Right after resume the network is often not back yet (Wi-Fi takes seconds to
// reconnect), so an action is tried again after 5 s, 20 s, 60 s and 3 min until it
// reports success. Each action is the existing component's own re-check entry point.
const RESUME_DELAYS_MS = [5000, 20000, 60000, 180000]

function createResumeRecovery(deps) {
  const {
    powerMonitor,
    // [{ name, run: async () => boolean (true = done) }]
    actions = [],
    log = () => {},
    now = Date.now,
    delays = RESUME_DELAYS_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    unlockGapMs = 15 * 60 * 1000
  } = deps

  let generation = 0
  let timers = new Set()
  let lastRunAt = 0
  let suspendedAt = 0
  const results = new Map() // action name -> { at, ok, attempts }

  function cancelPending() {
    for (const t of timers) clearTimeoutFn(t)
    timers = new Set()
  }

  function runAction(action, gen, attemptNo) {
    if (gen !== generation) return
    Promise.resolve()
      .then(() => action.run())
      .then((done) => finish(action, gen, attemptNo, done === true, ''))
      .catch((e) => finish(action, gen, attemptNo, false, (e && e.message) || String(e)))
  }

  function finish(action, gen, attemptNo, ok, err) {
    if (gen !== generation) return
    results.set(action.name, { at: now(), ok, attempts: attemptNo + 1 })
    if (ok) {
      log('[resume] ' + action.name + ' is back' + (attemptNo ? ' (attempt ' + (attemptNo + 1) + ')' : ''))
      return
    }
    if (attemptNo + 1 >= delays.length) {
      log('[resume] ' + action.name + ' still not working after ' + delays.length + ' tries' + (err ? ' (' + err + ')' : '') + '; its own timer will keep trying')
      return
    }
    const t = setTimeoutFn(() => { timers.delete(t); runAction(action, gen, attemptNo + 1) }, delays[attemptNo + 1] - delays[attemptNo])
    if (t && typeof t.unref === 'function') t.unref()
    timers.add(t)
  }

  function trigger(reason) {
    generation++
    cancelPending()
    lastRunAt = now()
    const gen = generation
    const slept = suspendedAt ? Math.round((now() - suspendedAt) / 1000) : null
    log('[resume] ' + reason + (slept !== null ? ' after ' + slept + ' s' : '') + '; re-checking ' + actions.map((a) => a.name).join(', '))
    suspendedAt = 0
    for (const action of actions) {
      const t = setTimeoutFn(() => { timers.delete(t); runAction(action, gen, 0) }, delays[0])
      if (t && typeof t.unref === 'function') t.unref()
      timers.add(t)
    }
  }

  function install() {
    powerMonitor.on('suspend', () => { suspendedAt = now(); cancelPending(); generation++ ; log('[power] the PC is going to sleep') })
    powerMonitor.on('resume', () => trigger('the PC woke up'))
    powerMonitor.on('unlock-screen', () => {
      // Unlocking does not change the network by itself; only redo the work if it has been a long while.
      if (now() - lastRunAt >= unlockGapMs) trigger('the screen was unlocked')
    })
  }

  return { install, trigger, status: () => Object.fromEntries(results), cancel: () => { generation++; cancelPending() } }
}

module.exports = {
  createLoginItem, createAwakeKeeper, createResumeRecovery,
  SLEEP_NOTE, SLEEP_NOTE_MAC, POWER_SETTINGS_URI, LOGIN_ARGS, RESUME_DELAYS_MS
}
