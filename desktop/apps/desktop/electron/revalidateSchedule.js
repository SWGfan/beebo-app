'use strict'
// When Beebo renews the signed licence token in the background.
//
// The token already carries its own offline grace (the service sets its expiry to the end of the paid
// period plus 14 days), so a household whose internet is down keeps whatever they are entitled to until
// that time; this schedule only decides how soon a renewal is retried once the internet comes back.
//
//   - Nothing is sent when there is no token: a person who only uses Beebo at home and never signed in
//     has nothing to renew, so Beebo does not ask beebo.tv anything for them.
//   - A renewal that could not reach the service (network error, gateway error) is retried after
//     2, 5, 15, 30 and then every 60 minutes, instead of waiting a full 12 hours. A router that was
//     still starting when Beebo launched is the usual cause.
//   - A renewal the service answered (renewed, unchanged, or refused) goes back to every 12 hours.
//
// Never grants or extends anything: it only decides when to ask.

const MIN = 60 * 1000
const DEFAULTS = Object.freeze({ firstDelayMs: 8000, intervalMs: 12 * 60 * MIN, retryMs: [2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN, 60 * MIN] })

// "The service did not answer" as opposed to "the service said no".
function isOutage(result) {
  if (!result || result.ok) return false
  const reason = String(result.reason || '')
  return /^network:/.test(reason) || /^http_(5\d\d)$/.test(reason)
}

function createRevalidateSchedule({ run, hasToken, setTimer = setTimeout, clearTimer = clearTimeout, options = {}, log = () => {} } = {}) {
  const cfg = Object.assign({}, DEFAULTS, options)
  let timer = null
  let stopped = false
  let failures = 0

  function next(ms) {
    if (stopped) return
    timer = setTimer(tick, ms)
    if (timer && timer.unref) timer.unref()
  }

  async function tick() {
    timer = null
    if (stopped) return
    let delay = cfg.intervalMs
    try {
      if (hasToken()) {
        const result = await run()
        if (isOutage(result)) {
          delay = cfg.retryMs[Math.min(failures, cfg.retryMs.length - 1)]
          failures++
          log('[license] renewal could not reach the service; trying again in ' + Math.round(delay / MIN) + ' min. Nothing is locked meanwhile.')
        } else {
          failures = 0
        }
      }
    } catch { /* a renewal problem must never become an app problem */ }
    next(delay)
  }

  return {
    start() { stopped = false; next(cfg.firstDelayMs) },
    stop() { stopped = true; if (timer) { clearTimer(timer); timer = null } },
    // After a sign-in or when the network returns: ask again soon instead of at the next slot.
    kick(ms = 1000) { if (stopped) return; if (timer) clearTimer(timer); failures = 0; next(ms) },
    failures: () => failures
  }
}

module.exports = { createRevalidateSchedule, isOutage, DEFAULTS }
