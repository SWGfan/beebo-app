'use strict'
// ============================================================================
// watchTogetherSync.js - the timing maths behind Watch together.
// ----------------------------------------------------------------------------
// One shared timeline, no shared clock. The server keeps
//     { state, anchorPos, anchorAt, rate, seq }
// meaning "at server time anchorAt the film was at anchorPos seconds, running at
// `rate`". Anyone can work out where the film should be right now:
//     position(now) = anchorPos + (now - anchorAt) * rate      (while playing)
// A start in the FUTURE (anchorAt > now) is how a synchronised "3, 2, 1, go" is
// done: everybody sits on anchorPos until their own idea of server time reaches
// anchorAt, so nobody has to be told to press play at the same instant.
//
// A browser's clock is not the server's, so each viewer measures the difference
// the way NTP does: send t0, the server stamps t1 (arrived) and t2 (replied), the
// viewer stamps t3 (got it back).
//     offset = ((t1 - t0) + (t2 - t3)) / 2        (server minus viewer)
//     rtt    = (t3 - t0) - (t2 - t1)
// The sample with the smallest rtt is the most trustworthy (the least queueing
// delay to be wrong about), so the best of a few is kept.
//
// A viewer that has drifted a little is NOT hard-seeked (that stutters and rebuffers):
// it is nudged by a few percent - watching at 0.97x for a few seconds is
// imperceptible. Only an error of 1.5 s or more seeks.
//
// IMPORTANT: every function here is a plain function declaration that touches nothing
// but its own arguments and Math, because the very same source is pasted into the web
// player (clientSource()). The server tests exercise exactly what runs in the browser.
// ============================================================================

/** Where the film should be at server time `serverNow` (ms). Never before anchorPos. */
function wtPositionAt(tl, serverNow) {
  if (!tl || !isFinite(tl.anchorPos)) return 0
  var rate = tl.rate > 0 && isFinite(tl.rate) ? tl.rate : 1
  if (tl.state !== 'playing') return tl.anchorPos
  var dt = serverNow - tl.anchorAt
  if (!(dt > 0)) return tl.anchorPos
  return tl.anchorPos + (dt / 1000) * rate
}

/** True once the timeline is playing AND its start time has been reached. */
function wtIsRunning(tl, serverNow) {
  return !!tl && tl.state === 'playing' && serverNow >= tl.anchorAt
}

/** One NTP-style sample from four timestamps (ms): offset = server - viewer. */
function wtOffsetSample(t0, t1, t2, t3) {
  var rtt = t3 - t0 - (t2 - t1)
  var offset = (t1 - t0 + (t2 - t3)) / 2
  return { offset: offset, rtt: rtt }
}

/**
 * The offset to use, from recent samples: the lowest-rtt one wins (bad samples - negative or
 * absurd rtt, NaN - are ignored). `prev` is the offset already in use; a small change is
 * smoothed in so the estimate does not jitter, a big one (a clock that was stepped) is taken
 * at once. Returns null when there is nothing usable.
 */
function wtBestOffset(samples, prev) {
  var best = null
  for (var i = 0; i < (samples || []).length; i++) {
    var s = samples[i]
    if (!s || !isFinite(s.offset) || !isFinite(s.rtt) || s.rtt < 0 || s.rtt > 5000) continue
    if (!best || s.rtt < best.rtt) best = s
  }
  if (!best) return null
  var offset = best.offset
  if (typeof prev === 'number' && isFinite(prev) && Math.abs(offset - prev) < 200) offset = prev + (offset - prev) * 0.3
  return { offset: offset, rtt: best.rtt }
}

/**
 * What to do about a viewer whose playhead is `err` seconds away from where it should be
 * (positive = ahead). `rate` is the room's playback rate, `nudging` whether a nudge is
 * already in progress (hysteresis, so the speed does not flutter around the threshold).
 * Returns { action: 'none' | 'nudge' | 'seek', rate, nudging }.
 *   |err| >= hard  (default 1.5 s)  -> seek
 *   |err| >  engage (0.08 s)        -> speed up / slow down by err/2.5, at most 5 %
 *   |err| <  release (0.03 s)       -> back to exactly `rate`
 */
function wtDriftPlan(err, rate, nudging, opts) {
  var o = opts || {}
  var hard = o.hard > 0 ? o.hard : 1.5
  var engage = o.engage > 0 ? o.engage : 0.08
  var release = o.release > 0 ? o.release : 0.03
  var maxNudge = o.maxNudge > 0 ? o.maxNudge : 0.05
  var base = rate > 0 && isFinite(rate) ? rate : 1
  if (!isFinite(err)) return { action: 'none', rate: base, nudging: false }
  var a = Math.abs(err)
  if (a >= hard) return { action: 'seek', rate: base, nudging: false }
  var active = nudging ? a >= release : a > engage
  if (!active) return { action: 'none', rate: base, nudging: false }
  var adj = err / 2.5
  if (adj > maxNudge) adj = maxNudge
  if (adj < -maxNudge) adj = -maxNudge
  return { action: 'nudge', rate: base * (1 - adj), nudging: true }
}

/** Where to seek a viewer that is too far off, allowing for the seek itself taking `lead` s. */
function wtSeekTarget(tl, serverNow, lead) {
  var l = isFinite(lead) && lead >= 0 ? lead : 0.25
  var running = wtIsRunning(tl, serverNow)
  return wtPositionAt(tl, serverNow) + (running ? l * (tl.rate > 0 ? tl.rate : 1) : 0)
}

/**
 * The whole "make my <video> match the room" decision, as data. tl is the room's timeline; s describes this
 * viewer's player: { serverNow, cur (currentTime), paused, rate (playbackRate), ready (enough buffered),
 * seeking, nudging }. Returns { actions, phase, target, inSync, nudging } where actions are
 * { type: 'pause' } | { type: 'play' } | { type: 'seek', to } | { type: 'rate', rate }.
 *   phase 'paused'   the room is paused (or holding): sit on anchorPos
 *   phase 'pending'  a start is scheduled for a moment not yet reached: sit on anchorPos, ready to go
 *   phase 'playing'  run, and keep the drift inside the budget (nudge under 1.5 s, seek over)
 * The page just carries the actions out, so what runs in the browser is what the tests check.
 */
function wtReconcile(tl, s) {
  var out = { actions: [], phase: 'paused', target: 0, inSync: false, nudging: false }
  if (!tl) return out
  var base = tl.rate > 0 && isFinite(tl.rate) ? tl.rate : 1
  var rateOff = function (r) { return Math.abs((s.rate || 1) - r) > 0.001 }
  if (!wtIsRunning(tl, s.serverNow)) {
    out.phase = tl.state === 'playing' ? 'pending' : 'paused'
    out.target = tl.anchorPos
    if (!s.paused) out.actions.push({ type: 'pause' })
    if (Math.abs(s.cur - tl.anchorPos) > 0.35) out.actions.push({ type: 'seek', to: tl.anchorPos })
    if (rateOff(base)) out.actions.push({ type: 'rate', rate: base })
    out.inSync = Math.abs(s.cur - tl.anchorPos) <= 0.5 && !s.seeking
    return out
  }
  out.phase = 'playing'
  var expected = wtPositionAt(tl, s.serverNow)
  out.target = expected
  var err = s.cur - expected
  out.inSync = Math.abs(err) <= 1.5 && !s.seeking
  if (s.paused) {
    if (Math.abs(err) >= 1.5) out.actions.push({ type: 'seek', to: wtSeekTarget(tl, s.serverNow, 0.25) })
    out.actions.push({ type: 'play' })
    if (rateOff(base)) out.actions.push({ type: 'rate', rate: base })
    return out
  }
  if (!s.ready || s.seeking) { out.nudging = !!s.nudging; return out } // buffering: nothing to correct yet
  var plan = wtDriftPlan(err, base, s.nudging)
  out.nudging = plan.nudging
  if (plan.action === 'seek') out.actions.push({ type: 'seek', to: wtSeekTarget(tl, s.serverNow, 0.25) })
  else if (rateOff(plan.rate)) out.actions.push({ type: 'rate', rate: plan.rate })
  return out
}

var WT_SYNC_FUNCTIONS = [wtPositionAt, wtIsRunning, wtOffsetSample, wtBestOffset, wtDriftPlan, wtSeekTarget, wtReconcile]

/** The functions above as source text, to paste into the web player (already ES5). */
function clientSource() {
  return WT_SYNC_FUNCTIONS.map(function (f) { return f.toString() }).join('\n')
}

module.exports = { wtPositionAt, wtIsRunning, wtOffsetSample, wtBestOffset, wtDriftPlan, wtSeekTarget, wtReconcile, clientSource }
