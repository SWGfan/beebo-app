package com.beeboentertainment.movie.watchtogether

import kotlin.math.abs

/**
 * The timing maths behind Watch together, ported from the server's watchTogetherSync.js (which the
 * web player runs too), so a phone and a browser stay in step by the same rules. One shared
 * timeline, no shared clock: each viewer measures its clock offset against the server NTP-style,
 * then nudges its speed by a few percent to close small gaps (never a stutter) and only seeks when
 * it is 1.5 s or more away. Pure, unit tested.
 */
object WtSync {

    /** Where the film should be at server time [serverNowMs]. Never before anchorPos. */
    fun positionAt(tl: WtTimeline?, serverNowMs: Double): Double {
        if (tl == null || !tl.anchorPos.isFinite()) return 0.0
        val rate = if (tl.rate > 0 && tl.rate.isFinite()) tl.rate else 1.0
        if (tl.state != "playing") return tl.anchorPos
        val dt = serverNowMs - tl.anchorAt
        if (!(dt > 0)) return tl.anchorPos
        return tl.anchorPos + (dt / 1000.0) * rate
    }

    /** True once the timeline is playing AND its start time has been reached. */
    fun isRunning(tl: WtTimeline?, serverNowMs: Double): Boolean = tl != null && tl.state == "playing" && serverNowMs >= tl.anchorAt

    data class Sample(val offset: Double, val rtt: Double)

    /** One NTP-style sample from four timestamps (ms): offset = server minus viewer. */
    fun offsetSample(t0: Double, t1: Double, t2: Double, t3: Double): Sample =
        Sample(offset = ((t1 - t0) + (t2 - t3)) / 2, rtt = (t3 - t0) - (t2 - t1))

    /**
     * The offset to use from recent samples: the lowest-rtt one wins (negative or absurd rtt and NaN
     * are ignored). A small change from [prev] is smoothed in; a big one (a clock that was stepped)
     * is taken at once. Null when nothing is usable.
     */
    fun bestOffset(samples: List<Sample>, prev: Double?): Sample? {
        var best: Sample? = null
        for (s in samples) {
            if (!s.offset.isFinite() || !s.rtt.isFinite() || s.rtt < 0 || s.rtt > 5000) continue
            if (best == null || s.rtt < best.rtt) best = s
        }
        val b = best ?: return null
        var offset = b.offset
        if (prev != null && prev.isFinite() && abs(offset - prev) < 200) offset = prev + (offset - prev) * 0.3
        return Sample(offset, b.rtt)
    }

    enum class Drift { NONE, NUDGE, SEEK }

    data class DriftPlan(val action: Drift, val rate: Double, val nudging: Boolean)

    /**
     * What to do about a viewer [err] seconds from where it should be (positive = ahead). 1.5 s or
     * more seeks; over 0.08 s the speed is nudged by err/2.5, at most 5 %; a running nudge stops
     * below 0.03 s (hysteresis, so the speed does not flutter around the threshold).
     */
    fun driftPlan(err: Double, rate: Double, nudging: Boolean, hard: Double = 1.5, engage: Double = 0.08, release: Double = 0.03, maxNudge: Double = 0.05): DriftPlan {
        val base = if (rate > 0 && rate.isFinite()) rate else 1.0
        if (!err.isFinite()) return DriftPlan(Drift.NONE, base, false)
        val a = abs(err)
        if (a >= hard) return DriftPlan(Drift.SEEK, base, false)
        val active = if (nudging) a >= release else a > engage
        if (!active) return DriftPlan(Drift.NONE, base, false)
        val adj = (err / 2.5).coerceIn(-maxNudge, maxNudge)
        return DriftPlan(Drift.NUDGE, base * (1 - adj), true)
    }

    /** Where to seek a viewer that is too far off, allowing for the seek itself taking [lead] seconds. */
    fun seekTarget(tl: WtTimeline, serverNowMs: Double, lead: Double = 0.25): Double {
        val l = if (lead.isFinite() && lead >= 0) lead else 0.25
        val running = isRunning(tl, serverNowMs)
        return positionAt(tl, serverNowMs) + (if (running) l * (if (tl.rate > 0) tl.rate else 1.0) else 0.0)
    }

    /** What this viewer's player is doing right now. */
    data class PlayerView(val serverNowMs: Double, val cur: Double, val paused: Boolean, val rate: Double, val ready: Boolean, val seeking: Boolean, val nudging: Boolean)

    sealed class Action {
        object Pause : Action()
        object Play : Action()
        data class Seek(val to: Double) : Action()
        data class Rate(val rate: Double) : Action()
    }

    enum class Phase { PAUSED, PENDING, PLAYING }

    data class Plan(val actions: List<Action>, val phase: Phase, val target: Double, val inSync: Boolean, val nudging: Boolean)

    /**
     * The whole "make my player match the room" decision, as data. Paused (or holding): sit on the
     * anchor. A start scheduled for a moment not yet reached: sit on the anchor, ready to go.
     * Playing: run, and keep the drift inside the budget. The caller only carries the actions out.
     */
    fun reconcile(tl: WtTimeline?, s: PlayerView): Plan {
        if (tl == null) return Plan(emptyList(), Phase.PAUSED, 0.0, false, false)
        val base = if (tl.rate > 0 && tl.rate.isFinite()) tl.rate else 1.0
        fun rateOff(r: Double) = abs(s.rate - r) > 0.001
        val actions = mutableListOf<Action>()
        if (!isRunning(tl, s.serverNowMs)) {
            if (!s.paused) actions += Action.Pause
            if (abs(s.cur - tl.anchorPos) > 0.35) actions += Action.Seek(tl.anchorPos)
            if (rateOff(base)) actions += Action.Rate(base)
            return Plan(actions, if (tl.state == "playing") Phase.PENDING else Phase.PAUSED, tl.anchorPos, abs(s.cur - tl.anchorPos) <= 0.5 && !s.seeking, false)
        }
        val expected = positionAt(tl, s.serverNowMs)
        val err = s.cur - expected
        val inSync = abs(err) <= 1.5 && !s.seeking
        if (s.paused) {
            if (abs(err) >= 1.5) actions += Action.Seek(seekTarget(tl, s.serverNowMs, 0.25))
            actions += Action.Play
            if (rateOff(base)) actions += Action.Rate(base)
            return Plan(actions, Phase.PLAYING, expected, inSync, false)
        }
        // Buffering: nothing to correct yet.
        if (!s.ready || s.seeking) return Plan(actions, Phase.PLAYING, expected, inSync, s.nudging)
        val plan = driftPlan(err, base, s.nudging)
        if (plan.action == Drift.SEEK) actions += Action.Seek(seekTarget(tl, s.serverNowMs, 0.25))
        else if (rateOff(plan.rate)) actions += Action.Rate(plan.rate)
        return Plan(actions, Phase.PLAYING, expected, inSync, plan.nudging)
    }
}
