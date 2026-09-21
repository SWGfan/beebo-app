package com.beeboentertainment.movie.watchtogether

import kotlin.math.abs

/** The bit of a player the engine drives (a Media3 controller in the app; a fake in tests). */
interface WtPlayerPort {
    fun positionSec(): Double
    /** True when the player is not set to play (paused, or waiting). */
    fun isPaused(): Boolean
    fun rate(): Double
    /** Enough buffered to play. */
    fun isReady(): Boolean
    fun durationSec(): Double
    fun play()
    fun pause()
    fun seekToSec(sec: Double)
    fun setRate(rate: Double)
}

/** Where the engine's own reports and commands go (POSTs in the app). */
interface WtSink {
    fun command(type: String, pos: Double?, rate: Double?)
    fun ready(ready: Boolean, appliedSeq: Long, durationSec: Double)
}

/**
 * Keeps one player in step with a room. The room's timeline is the truth; every 250 ms [tick]
 * compares the player with it and carries out what [WtSync.reconcile] says (pause, play, seek, a few
 * percent of speed). It also reports readiness (buffering pauses everyone: "Waiting for Sam to
 * buffer"), and turns the person's own play, pause, seek and speed presses into commands when they
 * are allowed to give them. A press by someone who may not control the room is simply undone by the
 * next tick.
 *
 * No Android and no network in here: time comes from [nowMs], the player from [WtPlayerPort], and the
 * outgoing messages go to [WtSink], so all of it is unit tested with fakes.
 */
class WtEngine(
    private val player: WtPlayerPort,
    private val sink: WtSink,
    private val nowMs: () -> Double,
) {
    /** Server time minus this device's time, in ms (from clock pings). */
    var offsetMs: Double = 0.0
        private set
    private var haveOffset = false

    var timeline: WtTimeline? = null
        private set
    var canControl: Boolean = false
    /** A small speed change is in progress (see [WtSync.driftPlan]). */
    private var nudging = false
    private var appliedSeq = 0L
    private var lastReported: Boolean? = null
    private var lastReportedSeq = -1L
    private var suppressLocalUntil = 0.0
    private var holdReconcileUntil = 0.0
    private var lastSeekAt = 0.0
    var lastPlan: WtSync.Plan? = null
        private set

    private companion object {
        /** How long a person's own press is left alone before the room's answer is enforced (a round trip or two). */
        const val HOLD_MS = 1500.0
    }

    /** The room's current server-time estimate. */
    fun serverNow(): Double = nowMs() + offsetMs

    fun setOffset(offset: Double) { offsetMs = offset; haveOffset = true }

    /** A new room state arrived: keep the newest timeline (older ones, by seq, are ignored). */
    fun onTimeline(tl: WtTimeline) {
        val cur = timeline
        if (cur != null && tl.seq < cur.seq) return
        // The room answered (a newer timeline): whatever the person pressed is now decided.
        if (cur == null || tl.seq > cur.seq) holdReconcileUntil = 0.0
        timeline = tl
    }

    /** One 250 ms beat. Returns what it did (for tests and the panel). */
    fun tick(): WtSync.Plan? {
        val tl = timeline ?: return null
        if (!haveOffset) return null
        val now = nowMs()
        // The person just pressed something and the room has not answered yet: do not undo it meanwhile.
        if (now < holdReconcileUntil) { reportReadiness(now); return null }
        val view = WtSync.PlayerView(
            serverNowMs = now + offsetMs,
            cur = player.positionSec(),
            paused = player.isPaused(),
            rate = player.rate(),
            ready = player.isReady(),
            seeking = now - lastSeekAt < 600,
            nudging = nudging,
        )
        val plan = WtSync.reconcile(tl, view)
        lastPlan = plan
        nudging = plan.nudging
        if (plan.actions.isNotEmpty()) {
            // What we do here is not the person's own press: do not send it back as a command.
            suppressLocalUntil = now + 900
            for (a in plan.actions) {
                when (a) {
                    WtSync.Action.Pause -> player.pause()
                    WtSync.Action.Play -> player.play()
                    is WtSync.Action.Seek -> { lastSeekAt = now; player.seekToSec(a.to) }
                    is WtSync.Action.Rate -> player.setRate(a.rate)
                }
            }
        }
        appliedSeq = tl.seq
        reportReadiness(now)
        return plan
    }

    /** Tell the room when this player becomes ready or stops being ready, or has applied a newer timeline. */
    private fun reportReadiness(now: Double) {
        if (timeline == null) return
        // Just after a seek the player still shows the old picture: not ready until it has settled.
        val ready = player.isReady() && now - lastSeekAt >= 600
        if (lastReported != ready || lastReportedSeq != appliedSeq) {
            lastReported = ready
            lastReportedSeq = appliedSeq
            sink.ready(ready, appliedSeq, player.durationSec())
        }
    }

    /* ------------------------ the person's own controls ------------------------ */

    private fun isEcho(): Boolean = nowMs() < suppressLocalUntil

    /** The app itself is about to change the player (a new title): ignore the player's own callbacks for a while. */
    fun suppressLocal(ms: Double) { suppressLocalUntil = maxOf(suppressLocalUntil, nowMs() + ms) }

    /** The person pressed play or pause. Sent as a command when they may control the room. */
    fun onLocalPlayWhenReady(playWhenReady: Boolean, positionSec: Double): Boolean {
        if (isEcho() || !canControl) return false
        val tl = timeline ?: return false
        val roomPlaying = tl.state == "playing"
        if (playWhenReady == roomPlaying) return false
        holdReconcileUntil = nowMs() + HOLD_MS
        sink.command(if (playWhenReady) "play" else "pause", if (playWhenReady) null else positionSec, null)
        return true
    }

    /** The person seeked. Sent as a command when they may control the room and it is a real jump. */
    fun onLocalSeek(positionSec: Double): Boolean {
        if (isEcho() || !canControl) return false
        val tl = timeline ?: return false
        val expected = WtSync.positionAt(tl, serverNow())
        if (abs(positionSec - expected) < 1.5) return false
        holdReconcileUntil = nowMs() + HOLD_MS
        sink.command("seek", positionSec, null)
        return true
    }

    /** The person picked a speed from the panel. */
    fun onLocalRate(rate: Double): Boolean {
        if (!canControl || rate !in WtProtocol.RATES) return false
        val tl = timeline ?: return false
        if (abs(tl.rate - rate) < 0.001) return false
        sink.command("rate", null, rate)
        return true
    }
}
