package com.beeboentertainment.movie.party

import android.os.SystemClock
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import com.beeboentertainment.movie.data.SessionStore
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
import kotlin.math.abs

/**
 * The sync brain: it ties a [RoomClient] to a Media3 [Player] and keeps the two
 * ends of a watch party locked together.
 *
 * One device is the HOST — its player is the source of truth and the single
 * audio output. Every other device is a VIEWER: it shows muted video and chases
 * the host's timeline.
 *
 *  - As HOST it watches the local player and emits a `control` on every user
 *    play/pause/seek/load, plus a `sync` beat every ~3s so late or drifting
 *    viewers can re-lock.
 *  - As VIEWER it applies incoming `control`/`sync` to the local player, seeking
 *    only when drift exceeds a small threshold so playback stays smooth.
 *
 * ## Audio-delay offset (lip-sync with delayed audio)
 *
 * When the host's audio reaches the listener late (a Bluetooth / TV audio path
 * that buffers), the sound HEARD at wall-clock T is content the host emitted
 * roughly `audioDelayMs` earlier. So the passenger's muted video must show that
 * same slightly-earlier content to line up with the lips:
 *
 *     effectiveTarget = syncedPositionMs - session.audioDelayMs
 *
 * A POSITIVE [SessionStore.audioDelayMs] means "the audio is late": we pull the
 * local video position back by that many milliseconds so the picture waits for
 * the delayed sound. A negative value pushes the video ahead. The offset is
 * applied to every position we hand the local player — seeks and sync
 * corrections alike. The user tunes it live with [AudioDelaySlider]; only
 * viewers apply it (the host hears nothing local).
 *
 * ## Threading
 *
 * A Media3 [Player] is confined to its application looper (the main thread by
 * default). Everything here that touches [player] runs on [scope], which
 * defaults to the main dispatcher; [Player.Listener] callbacks arrive there too.
 * [RoomClient] delivers socket events on its own thread, but this class only ever
 * reads them inside a collector running on [scope], so the player is never
 * touched off-thread.
 */
class PartyController(
    private val player: Player,
    private val session: SessionStore,
    private val room: RoomClient,
    // Defaults to the main dispatcher because Player is main-thread-confined.
    // Pass a lifecycle scope from the UI if you want it torn down automatically.
    private val scope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    /**
     * How a VIEWER should load a video the host switched to.
     *
     * The host broadcasts an IDENTITY (its `MediaItem.mediaId`) and never a
     * location, so resolving that id to something this device is allowed to
     * play is the app's job — that is a server lookup against the viewer's own
     * account, which this class has no business doing. Hence a hook. If null,
     * a switch only resets the beat and nothing is loaded.
     *
     * Called on [scope] (the player's thread), at most once per distinct id
     * (see [requestLoad]), and never for an id the local player already has.
     */
    private val onLoadVideo: ((videoId: String) -> Unit)? = null,
) {

    private val _state = MutableStateFlow<PartyState>(PartyState.Disconnected)
    val state: StateFlow<PartyState> = _state.asStateFlow()

    @Volatile private var role: RoomRole? = null
    private var roster: List<RoomMember> = emptyList()
    private var you: String = ""

    private var eventsJob: Job? = null
    private var connJob: Job? = null
    private var syncBeatJob: Job? = null

    // The host player's volume before we muted it as a viewer, restored on stop.
    private var savedVolume: Float? = null

    // The video id we last asked [onLoadVideo] for. Loading is asynchronous (a
    // server lookup, then a player swap) while sync beats keep arriving every
    // ~3s, so without this every beat would re-ask for the same film — and a
    // film this viewer cannot resolve would re-ask, and re-warn, forever.
    @Volatile private var requestedVideoId: String? = null

    // Last sync beat, kept so a correction can add the time elapsed since it
    // arrived (the host's clock has moved on while we processed it).
    private data class Beat(val positionMs: Long, val playing: Boolean, val atElapsedRealtime: Long)
    @Volatile private var lastBeat: Beat? = null

    // ------------------------------------------------------------------ control

    /**
     * Join the room as [deviceName] with [role] and start syncing. Call on the
     * player's thread (the main thread). Idempotent-ish: call [stop] before
     * switching role or identity.
     */
    fun start(deviceName: String, role: RoomRole) {
        stop() // clean any prior session first
        this.role = role

        if (role == RoomRole.VIEWER) {
            // A single audio source keeps sync sane: only the host feeds the
            // speakers, so viewers mute. volume = 0 leaves the transport running
            // (frames keep decoding) but silences the local track.
            savedVolume = player.volume
            player.volume = 0f
        }

        connJob = scope.launch {
            room.connection.collect { conn ->
                when (conn) {
                    is RoomConnection.Connected -> recomputeState()
                    else -> _state.value = PartyState.Disconnected
                }
            }
        }

        eventsJob = scope.launch {
            room.events.collect { handleEvent(it) }
        }

        if (role == RoomRole.HOST) startHosting()

        room.connect(deviceName, role)
    }

    /** Leave the room and stop syncing. Restores a muted viewer's volume. Idempotent. */
    fun stop() {
        syncBeatJob?.cancel(); syncBeatJob = null
        eventsJob?.cancel(); eventsJob = null
        connJob?.cancel(); connJob = null
        if (role == RoomRole.HOST) player.removeListener(hostListener)
        savedVolume?.let { player.volume = it }
        savedVolume = null
        lastBeat = null
        requestedVideoId = null
        role = null
        roster = emptyList()
        room.leave()
        _state.value = PartyState.Disconnected
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
            }
            is RoomEvent.MemberLeft -> {
                roster = roster.filterNot { it.id == e.id }
                recomputeState()
            }
            is RoomEvent.Control -> if (role == RoomRole.VIEWER) applyControl(e)
            is RoomEvent.Sync -> if (role == RoomRole.VIEWER) applySync(e)
            // Application envelopes (party games, shared checklist) share the room
            // socket but not this controller: they are delivered to whichever screen
            // asked for them via RoomMessenger. Deliberately ignored here so this
            // `when` stays exhaustive as the protocol grows.
            is RoomEvent.App -> Unit
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

    private fun startHosting() {
        player.addListener(hostListener)
        syncBeatJob = scope.launch {
            while (isActive) {
                // Only meaningful once the socket is up; sendSync is a no-op
                // otherwise, so an early beat costs nothing. The beat carries
                // what is loaded as well as where we are in it, so a viewer
                // that joined mid-film can still work out what to open — a
                // `load` control only fires at the moment of the switch.
                room.sendSync(player.currentPosition, player.isPlaying, currentVideoId())
                delay(SYNC_BEAT_MS)
            }
        }
    }

    // All callbacks arrive on the player's (main) thread. We read positions
    // straight off the player and fan them out to viewers verbatim — the host
    // timeline is the audio timeline; the audio-delay offset is a viewer-only
    // concern applied on the other end.
    private val hostListener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            room.sendControl(if (isPlaying) "play" else "pause", player.currentPosition)
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            // Only user/programmatic seeks are worth broadcasting; automatic
            // transitions come through onMediaItemTransition as a `load`.
            if (reason == Player.DISCONTINUITY_REASON_SEEK) {
                room.sendControl("seek", newPosition.positionMs)
            }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            room.sendControl("load", 0L, mediaItem?.mediaId)
        }
    }

    // ------------------------------------------------------------- viewer side

    private fun applyControl(e: RoomEvent.Control) {
        when (e.action) {
            "play" -> {
                seekAdjusted(e.positionMs)
                player.play()
            }
            "pause" -> {
                seekAdjusted(e.positionMs)
                player.pause()
            }
            "seek" -> seekAdjusted(e.positionMs)
            "load" -> {
                // An explicit switch: act on it even if we cannot read what
                // the local player currently has.
                requestLoad(e.videoId, force = true)
                // A fresh load resets the timeline; position rides in on the
                // following play/sync, so nothing to seek here.
                lastBeat = null
            }
            else -> Log.w(TAG, "unknown control action: ${e.action}")
        }
    }

    private fun applySync(e: RoomEvent.Sync) {
        // The host is on a different film: ask for the switch and let this beat
        // go. Its position describes content we do not have loaded, so seeking
        // the current item to it would only throw the picture somewhere random
        // before the swap lands.
        if (requestLoad(e.videoId)) {
            lastBeat = null
            return
        }

        lastBeat = Beat(e.positionMs, e.playing, SystemClock.elapsedRealtime())

        // Match the host's play/pause first so a paused viewer doesn't keep
        // drifting against a moving target.
        if (e.playing && !player.isPlaying) player.play()
        else if (!e.playing && player.isPlaying) player.pause()

        val target = effectiveTargetMs(e.positionMs, e.playing, SystemClock.elapsedRealtime())
        val drift = player.currentPosition - target
        // Seek only past the threshold: correcting sub-threshold jitter would
        // make playback stutter for no visible gain.
        if (abs(drift) > DRIFT_THRESHOLD_MS) {
            player.seekTo(target.coerceAtLeast(0L))
        }
    }

    /**
     * Ask the app to switch to the host's [videoId] if it is not what we already
     * have. Returns true when the host is on something else, whether or not we
     * are able to act on it — the caller uses that to skip a sync beat that
     * describes content we do not have loaded.
     *
     * Deliberately conservative about what counts as "different": a null/blank
     * id (an older host, or a host with nothing loaded) and an unknown LOCAL id
     * both mean "no information", and neither is allowed to trigger a switch or
     * to suppress syncing. Only a known mismatch does.
     */
    private fun requestLoad(videoId: String?, force: Boolean = false): Boolean {
        // No hook means nothing can act on a switch, so report "not different"
        // and let the old behaviour (sync against whatever is loaded) stand.
        val hook = onLoadVideo ?: return false
        val wanted = videoId?.takeIf { it.isNotBlank() } ?: return false

        // MediaController answers null when the timeline command is unavailable;
        // that is "we don't know", not "we have nothing".
        val local = runCatching { player.currentMediaItem?.mediaId }.getOrNull()
        if (local == wanted) {
            // Already there — clear any stale request so a LATER switch back to
            // this same film is asked for again.
            requestedVideoId = null
            return false
        }
        // Unknown local id + a repeating beat is not enough to act on; an
        // explicit `load` control ([force]) is.
        if (local.isNullOrBlank() && !force) return false

        // Ask once per distinct id: resolution is async and beats keep coming,
        // so re-asking would queue duplicate loads (and, for a film this viewer
        // cannot open, repeat the warning every three seconds).
        if (requestedVideoId != wanted) {
            requestedVideoId = wanted
            hook.invoke(wanted)
        }
        return true
    }

    /** What this player has loaded, for the host's beat. Null when unknown. */
    private fun currentVideoId(): String? =
        runCatching { player.currentMediaItem?.mediaId }.getOrNull()?.takeIf { it.isNotBlank() }

    /** Seek the local player to [syncedPositionMs] with the audio-delay offset applied. */
    private fun seekAdjusted(syncedPositionMs: Long) {
        player.seekTo(withAudioDelay(syncedPositionMs).coerceAtLeast(0L))
    }

    /**
     * Where the local video should be now to line up with the host's audio.
     *
     * Starts from the beat position, adds the wall-clock time elapsed since the
     * beat arrived if the host was playing (its clock kept moving), then applies
     * the audio-delay offset. See the class doc for the sign convention.
     */
    private fun effectiveTargetMs(beatPositionMs: Long, playing: Boolean, nowElapsed: Long): Long {
        val beat = lastBeat
        val elapsed = if (playing && beat != null) (nowElapsed - beat.atElapsedRealtime) else 0L
        return withAudioDelay(beatPositionMs + elapsed)
    }

    /** effective = synced - audioDelayMs. Positive delay pulls video back to meet late audio. */
    private fun withAudioDelay(syncedPositionMs: Long): Long =
        syncedPositionMs - session.audioDelayMs

    private companion object {
        const val TAG = "PartyController"
        const val SYNC_BEAT_MS = 3_000L
        const val DRIFT_THRESHOLD_MS = 250L
    }
}

/**
 * What the party is doing, for the UI to render. Mirrors the flow in
 * [PartyController.state].
 */
sealed class PartyState {
    object Disconnected : PartyState()

    /** In the room but not yet driving/following (no role set). */
    data class Connected(val you: String, val roster: List<RoomMember>) : PartyState()

    /** This device drives playback; it is the single audio output. */
    data class Hosting(val you: String, val roster: List<RoomMember>) : PartyState()

    /** This device chases the host and shows muted video. */
    data class Following(val you: String, val roster: List<RoomMember>) : PartyState()
}
