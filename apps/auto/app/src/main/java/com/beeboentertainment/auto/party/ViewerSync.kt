package com.beeboentertainment.auto.party

import kotlin.math.abs

/**
 * The watch-party viewer's decisions, with no player in sight: given what the
 * local player is doing and what the host said, what should change?
 *
 * [PartyController] reads the player, asks here, and applies the [Plan]. Kept
 * pure so the sync rules — drift threshold, audio-delay sign, who counts as the
 * host, and "never play while video is blocked" — run as JVM unit tests.
 */
object ViewerSync {

    /** Below this much drift a viewer does not seek; chasing jitter stutters. */
    const val DRIFT_THRESHOLD_MS = 250L

    /** What the local (viewer) player is doing now. */
    data class Local(
        val positionMs: Long,
        val playWhenReady: Boolean,
        /** mediaId of what is loaded, or null for nothing. */
        val videoId: String?,
        /** A video the viewer already asked to load and is still resolving. */
        val pendingVideoId: String? = null,
    )

    /**
     * What to do. Every field null means "leave it alone".
     * [play] true = play, false = pause.
     */
    data class Plan(
        val seekToMs: Long? = null,
        val play: Boolean? = null,
        val loadVideoId: String? = null,
    ) {
        val isNoop: Boolean get() = seekToMs == null && play == null && loadVideoId == null
    }

    /**
     * Where the viewer's picture should be for host position [syncedPositionMs].
     * The car plays the host's audio over Bluetooth, which lags; a POSITIVE
     * [audioDelayMs] pulls the picture back to meet the late sound.
     */
    fun target(syncedPositionMs: Long, audioDelayMs: Int): Long =
        (syncedPositionMs - audioDelayMs).coerceAtLeast(0L)

    /**
     * Whether a control/sync from member [from] should be obeyed. Only hosts
     * drive a party. When the roster names no host at all (an older host build,
     * or the roster hasn't arrived) anyone but ourselves is accepted, which is
     * how the protocol behaved before.
     */
    fun acceptsFrom(from: String, you: String, roster: List<RoomMember>): Boolean {
        if (from.isNotBlank() && from == you) return false
        val hosts = roster.filter { it.role.equals("host", ignoreCase = true) }.map { it.id }
        return hosts.isEmpty() || from in hosts
    }

    /** A drift-correction beat from the host. */
    fun onSync(
        local: Local,
        hostPositionMs: Long,
        hostPlaying: Boolean,
        hostVideoId: String?,
        audioDelayMs: Int,
        blocked: Boolean,
    ): Plan {
        val load = hostVideoId?.takeIf { it.isNotBlank() && it != local.videoId && it != local.pendingVideoId }
        if (load != null) {
            // Positions are meaningless across titles; the next beat re-locks.
            return Plan(loadVideoId = load, play = if (blocked) false.takeIf { local.playWhenReady } else null)
        }
        if (blocked) return Plan(play = false.takeIf { local.playWhenReady })

        val play = when {
            hostPlaying && !local.playWhenReady -> true
            !hostPlaying && local.playWhenReady -> false
            else -> null
        }
        val want = target(hostPositionMs, audioDelayMs)
        val seek = want.takeIf { abs(local.positionMs - it) > DRIFT_THRESHOLD_MS }
        return Plan(seekToMs = seek, play = play)
    }

    /** A play/pause/seek/load command from the host. Null for actions a party ignores (e.g. games). */
    fun onControl(
        local: Local,
        action: String,
        positionMs: Long,
        videoId: String?,
        audioDelayMs: Int,
        blocked: Boolean,
    ): Plan? {
        val want = target(positionMs, audioDelayMs)
        val drifted = abs(local.positionMs - want) > DRIFT_THRESHOLD_MS
        return when (action) {
            "play" ->
                if (blocked) Plan(play = false.takeIf { local.playWhenReady })
                else Plan(seekToMs = want.takeIf { drifted }, play = true)
            "pause" -> Plan(seekToMs = want.takeIf { drifted }, play = false)
            "seek" -> Plan(seekToMs = want)
            "load" -> {
                val id = videoId?.takeIf { it.isNotBlank() && it != local.videoId && it != local.pendingVideoId }
                Plan(loadVideoId = id, play = if (blocked && local.playWhenReady) false else null)
            }
            else -> null
        }
    }
}
