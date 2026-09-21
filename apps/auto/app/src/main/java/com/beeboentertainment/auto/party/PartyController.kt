package com.beeboentertainment.auto.party

import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import com.beeboentertainment.auto.data.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The sync brain: it ties a [RoomClient] to Media3 players and keeps the two
 * ends of a watch party locked together.
 *
 * One device is the HOST — its player is the app's own media session (the one
 * Android Auto plays through), so it is the single audio output in the car.
 * Every other device is a VIEWER: it shows muted video and chases the host.
 *
 *  - As HOST it listens to [hostPlayer] and emits a `control` on play/pause
 *    (playWhenReady, so buffering is not mistaken for a pause), seek and a new
 *    title (`load`), plus a `sync` beat every 3s that also names the title so a
 *    late joiner catches up.
 *  - As VIEWER it applies the host's `control`/`sync` to [viewerPlayer] using
 *    the pure rules in [ViewerSync]. Commands from anyone the roster doesn't
 *    list as a host are ignored.
 *
 * Video is parked-only. While [setVideoBlocked] is true a viewer is held paused
 * and nothing from the room can start it; the next beat after unblocking
 * re-locks it to the host.
 *
 * Threading: Media3 players are main-thread-confined. Everything here that
 * touches a player runs on [scope] (main dispatcher by default).
 */
class PartyController(
    private val prefs: Prefs,
    private val room: RoomClient,
    /** The media session player, e.g. a MediaController to PlaybackService. Null = can't host. */
    private val hostPlayer: Player?,
    /** A local video player for watching. Null = can't view. */
    private val viewerPlayer: Player?,
    private val scope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    /**
     * Load the host's title on the viewer: resolve [videoId] (a browse-tree
     * mediaId) to a stream and set it on [viewerPlayer] with that mediaId.
     * Returns a sentence when it can't, null on success.
     */
    private val onLoadVideo: (suspend (videoId: String) -> String?)? = null,
) {

    private val _state = MutableStateFlow<PartyState>(PartyState.Disconnected)
    val state: StateFlow<PartyState> = _state.asStateFlow()

    /** The last thing worth telling the user (a load failure, a refused sign-in). */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    val canHost: Boolean get() = hostPlayer != null
    val canView: Boolean get() = viewerPlayer != null

    private var role: RoomRole? = null
    private var roster: List<RoomMember> = emptyList()
    private var you: String = ""

    private var eventsJob: Job? = null
    private var connJob: Job? = null
    private var syncBeatJob: Job? = null
    private var loadJob: Job? = null
    private var pendingVideoId: String? = null

    private var savedVolume: Float? = null

    @Volatile private var videoBlocked = true

    // ------------------------------------------------------------------ control

    /** Join as [role]. Call on the main thread. Switching role restarts cleanly. */
    fun start(deviceName: String, role: RoomRole) {
        stop()
        val player = if (role == RoomRole.HOST) hostPlayer else viewerPlayer
        if (player == null) {
            _notice.value = if (role == RoomRole.HOST) {
                "This device can't host: Beebo Auto's player isn't ready yet. Try again in a moment."
            } else {
                "This device can't show video."
            }
            return
        }
        this.role = role
        _notice.value = null

        if (role == RoomRole.VIEWER) {
            // One audio source keeps sync sane: only the host feeds the car.
            savedVolume = player.volume
            player.volume = 0f
            if (videoBlocked) player.pause()
        }

        connJob = scope.launch {
            room.connection.collect { conn ->
                when (conn) {
                    is RoomConnection.Connected -> recomputeState()
                    is RoomConnection.Connecting -> _state.value = PartyState.Joining("Joining the party…")
                    is RoomConnection.Reconnecting ->
                        _state.value = PartyState.Joining("Lost the hub. Reconnecting (try ${conn.attempt})…")
                    is RoomConnection.Failed -> {
                        _state.value = PartyState.Disconnected
                        _notice.value = conn.reason
                    }
                    RoomConnection.Disconnected -> _state.value = PartyState.Disconnected
                }
            }
        }
        eventsJob = scope.launch { room.events.collect { handleEvent(it) } }

        if (role == RoomRole.HOST) startHosting(player)
        room.connect(deviceName, role)
    }

    /** Leave the room and stop syncing. Restores a muted viewer's volume. Idempotent. */
    fun stop() {
        syncBeatJob?.cancel(); syncBeatJob = null
        eventsJob?.cancel(); eventsJob = null
        connJob?.cancel(); connJob = null
        loadJob?.cancel(); loadJob = null
        pendingVideoId = null
        hostPlayer?.removeListener(hostListener)
        savedVolume?.let { v -> viewerPlayer?.volume = v }
        savedVolume = null
        role = null
        roster = emptyList()
        room.leave()
        _state.value = PartyState.Disconnected
    }

    /**
     * Whether video may play on this device right now (see drive/VideoGate).
     * Blocking pauses a viewer at once; unblocking lets the next host beat
     * resume it. Hosting is audio and is not affected.
     */
    fun setVideoBlocked(blocked: Boolean) {
        videoBlocked = blocked
        if (blocked) viewerPlayer?.let { if (it.playWhenReady) it.pause() }
    }

    // ------------------------------------------------------------------- events

    private fun handleEvent(e: RoomEvent) {
        when (e) {
            is RoomEvent.Roster -> {
                you = e.you
                roster = e.members
                recomputeState()
            }
            is RoomEvent.MemberJoined -> {
                roster = roster.filterNot { it.id == e.member.id } + e.member
                recomputeState()
                // Tell a newcomer what's on without waiting for the next beat.
                if (role == RoomRole.HOST) hostPlayer?.let { sendBeat(it) }
            }
            is RoomEvent.MemberLeft -> {
                roster = roster.filterNot { it.id == e.id }
                recomputeState()
            }
            is RoomEvent.Control -> if (role == RoomRole.VIEWER && ViewerSync.acceptsFrom(e.from, you, roster)) {
                val p = viewerPlayer ?: return
                ViewerSync.onControl(local(p), e.action, e.positionMs, e.videoId, prefs.audioDelayMs, videoBlocked)
                    ?.let { apply(p, it) }
                    ?: Log.d(TAG, "ignoring control action ${e.action}")
            }
            is RoomEvent.Sync -> if (role == RoomRole.VIEWER && ViewerSync.acceptsFrom(e.from, you, roster)) {
                val p = viewerPlayer ?: return
                apply(p, ViewerSync.onSync(local(p), e.positionMs, e.playing, e.videoId, prefs.audioDelayMs, videoBlocked))
            }
        }
    }

    private fun recomputeState() {
        _state.value = when (role) {
            RoomRole.HOST -> PartyState.Hosting(you, roster)
            RoomRole.VIEWER -> PartyState.Following(you, roster)
            null -> PartyState.Connected(you, roster)
        }
    }

    // --------------------------------------------------------------- host side

    private fun startHosting(player: Player) {
        player.addListener(hostListener)
        syncBeatJob = scope.launch {
            while (isActive) {
                sendBeat(player)
                delay(SYNC_BEAT_MS)
            }
        }
    }

    private fun sendBeat(player: Player) {
        room.sendSync(player.currentPosition, player.playWhenReady, player.currentMediaItem?.mediaId)
    }

    private val hostListener = object : Player.Listener {
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            val p = hostPlayer ?: return
            room.sendControl(if (playWhenReady) "play" else "pause", p.currentPosition)
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK) {
                room.sendControl("seek", newPosition.positionMs)
            }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            val id = mediaItem?.mediaId ?: return
            room.sendControl("load", 0L, id)
        }
    }

    // ------------------------------------------------------------- viewer side

    private fun local(p: Player) = ViewerSync.Local(
        positionMs = p.currentPosition,
        playWhenReady = p.playWhenReady,
        videoId = p.currentMediaItem?.mediaId,
        pendingVideoId = pendingVideoId,
    )

    private fun apply(p: Player, plan: ViewerSync.Plan) {
        if (plan.isNoop) return
        plan.loadVideoId?.let { load(it) }
        plan.seekToMs?.let { p.seekTo(it) }
        when (plan.play) {
            true -> if (!videoBlocked) p.play()
            false -> p.pause()
            null -> Unit
        }
    }

    private fun load(videoId: String) {
        val loader = onLoadVideo ?: return
        pendingVideoId = videoId
        loadJob?.cancel()
        loadJob = scope.launch {
            val problem = try {
                loader(videoId)
            } catch (c: kotlinx.coroutines.CancellationException) {
                throw c
            } catch (t: Throwable) {
                t.message ?: "Couldn't load the host's film."
            }
            if (pendingVideoId == videoId) pendingVideoId = null
            _notice.value = problem
        }
    }

    private companion object {
        const val TAG = "PartyController"
        const val SYNC_BEAT_MS = 3_000L
    }
}

/** What the party is doing, for the UI. Mirrors [PartyController.state]. */
sealed class PartyState {
    object Disconnected : PartyState()

    /** Opening or re-opening the room socket. */
    data class Joining(val message: String) : PartyState()

    data class Connected(val you: String, val roster: List<RoomMember>) : PartyState()

    /** This device drives playback; the car plays its audio. */
    data class Hosting(val you: String, val roster: List<RoomMember>) : PartyState()

    /** This device chases the host and shows muted video. */
    data class Following(val you: String, val roster: List<RoomMember>) : PartyState()
}
