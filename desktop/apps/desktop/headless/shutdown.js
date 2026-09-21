'use strict'

function createShutdown({ requestQuit, closeServer, exit, log = () => {}, hardTimeoutMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let started = false
  let finished = false
  let timer = null

  const finish = (code) => {
    if (finished) return
    finished = true
    if (timer) clearTimer(timer)
    Promise.resolve()
      .then(() => new Promise((resolve) => {
        let settled = false
        const done = () => { if (!settled) { settled = true; resolve() } }
        try { closeServer(done) } catch { done() }
        const guard = setTimer(done, 3000)
        if (guard && guard.unref) guard.unref()
      }))
      .catch(() => {})
      .then(() => {
        log('Beebo server stopped')
        exit(code)
      })
  }

  const trigger = (reason) => {
    if (started) {
      log('second stop request: exiting now')
      finished = true
      exit(1)
      return
    }
    started = true
    log(`stopping (${reason})`)
    timer = setTimer(() => {
      log('shutdown took longer than expected: exiting anyway')
      finished = true
      exit(1)
    }, hardTimeoutMs)
    if (timer && timer.unref) timer.unref()
    try { requestQuit() } catch { finish(1) }
  }

  return { trigger, finish, isStopping: () => started }
}

module.exports = { createShutdown }
