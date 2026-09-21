package com.beeboentertainment.movie.watchtogether

import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.server.ServerException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What the panel draws. Never holds the room code after joining except for the host's "copy invite". */
data class WtUi(
    val phase: Phase = Phase.IDLE,
    val room: WtRoom? = null,
    /** This person's participant id in the room. */
    val you: String? = null,
    val chat: List<WtChat> = emptyList(),
    val lastReaction: WtReaction? = null,
    val message: String? = null,
    val connected: Boolean = false,
) {
    enum class Phase { IDLE, JOINING, IN_ROOM, ENDED }

    val canControl: Boolean get() = room != null && WtProtocol.canControl(room, you)
    val isHost: Boolean get() = room != null && WtProtocol.isHost(room, you)
    val holdLine: String? get() = WtProtocol.holdLine(room?.hold)
}

/**
 * One person's membership of one room, for as long as the player is open: joins (or creates) it,
 * follows the server's event stream (falling back to polling if a network breaks streams),
 * keeps the player in step through [WtEngine], sends chat and reactions, and lets go on leaving.
 *
 * The room code lives only in this object's memory and in the requests that need it. It is never
 * logged or written to disk, and is dropped when the session ends.
 */
class WtSession(private val client: WtClient) {

    private val _ui = MutableStateFlow(WtUi())
    val ui: StateFlow<WtUi> = _ui.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val main = Handler(Looper.getMainLooper())
    private var code: String? = null
    private var engine: WtEngine? = null
    private var player: Player? = null
    private var eventsJob: Job? = null
    private var clockJob: Job? = null
    private var lastEventId: String? = null
    private var ticking = false
    private var onMedia: ((WtMedia) -> Unit)? = null

    /** Called when the host switches to another title (the player must open it). */
    fun setOnMedia(cb: ((WtMedia) -> Unit)?) { onMedia = cb }

    val roomCodeForInvite: String? get() = if (_ui.value.isHost) code else null

    /* -------------------------------- joining -------------------------------- */

    /** Join by a code (already normalized). Returns the room's media so the caller can open the title. */
    suspend fun join(rawCode: String): WtJoinResponse {
        val c = WtProtocol.normalizeCode(rawCode) ?: throw ServerException(404, "not_found", WtProtocol.message("not_found", null))
        _ui.value = _ui.value.copy(phase = WtUi.Phase.JOINING, message = null)
        try {
            val r = client.join(c)
            enter(c, r)
            return r
        } catch (e: Exception) {
            _ui.value = WtUi(phase = WtUi.Phase.IDLE, message = if (e is ServerException) WtProtocol.message(e.code, e.message) else e.message)
            throw e
        }
    }

    /** Start a room for the title being watched. The caller shares the invite. */
    suspend fun create(kind: String, id: String, title: String, everyoneControls: Boolean): WtJoinResponse {
        if (!WtProtocol.isMediaKind(kind) || !WtProtocol.isSafeMediaId(id)) throw ServerException(400, "bad_media", "That title cannot be shared.")
        _ui.value = _ui.value.copy(phase = WtUi.Phase.JOINING, message = null)
        try {
            val r = client.create(kind, id, com.beeboentertainment.movie.server.SafeText.clean(title, 120), if (everyoneControls) "everyone" else "host")
            val c = WtProtocol.normalizeCode(r.code) ?: throw ServerException(0, "bad_response", "This Beebo computer sent a room the app can't use.")
            enter(c, r)
            return r
        } catch (e: Exception) {
            _ui.value = WtUi(phase = WtUi.Phase.IDLE, message = if (e is ServerException) WtProtocol.message(e.code, e.message) else e.message)
            throw e
        }
    }

    private fun enter(c: String, r: WtJoinResponse) {
        code = c
        lastEventId = null
        _ui.value = WtUi(phase = WtUi.Phase.IN_ROOM, room = r.room.copy(code = ""), you = r.pid, chat = r.chat, connected = true)
        engine?.canControl = _ui.value.canControl
        engine?.onTimeline(r.room.timeline)
        startClock()
        startEvents()
    }

    /* -------------------------------- the player -------------------------------- */

    /** Hand over the player that shows the film. Safe to call before or after joining. */
    fun attach(p: Player) {
        detach()
        player = p
        val e = WtEngine(Media3Port(p), Sink(), { System.currentTimeMillis().toDouble() })
        engine = e
        e.canControl = _ui.value.canControl
        _ui.value.room?.let { e.onTimeline(it.timeline) }
        p.addListener(playerListener)
        ticking = true
        main.post(ticker)
    }

    fun detach() {
        ticking = false
        main.removeCallbacks(ticker)
        player?.removeListener(playerListener)
        player = null
        engine = null
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (!ticking) return
            engine?.tick()
            main.postDelayed(this, 250)
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            if (reason == Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST) {
                engine?.onLocalPlayWhenReady(playWhenReady, (player?.currentPosition ?: 0L) / 1000.0)
            }
        }

        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK) engine?.onLocalSeek(newPosition.positionMs / 1000.0)
        }
    }

    private class Media3Port(private val p: Player) : WtPlayerPort {
        override fun positionSec() = p.currentPosition.coerceAtLeast(0L) / 1000.0
        override fun isPaused() = !p.playWhenReady
        override fun rate() = p.playbackParameters.speed.toDouble()
        override fun isReady() = p.playbackState == Player.STATE_READY
        override fun durationSec() = p.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it / 1000.0 } ?: 0.0
        override fun play() { p.play() }
        override fun pause() { p.pause() }
        override fun seekToSec(sec: Double) { p.seekTo((sec * 1000).toLong().coerceAtLeast(0L)) }
        override fun setRate(rate: Double) { p.playbackParameters = PlaybackParameters(rate.toFloat()) }
    }

    private inner class Sink : WtSink {
        override fun command(type: String, pos: Double?, rate: Double?) {
            val c = code ?: return
            scope.launch {
                try {
                    val ack = withContext(Dispatchers.IO) { client.command(c, type, pos, rate, WtClient.newCommandId()) }
                    ack.timeline?.let { engine?.onTimeline(it) }
                } catch (e: ServerException) {
                    // Not allowed, stale, rate limited: the room's own state stands and the next beat re-syncs.
                    if (e.code == "not_allowed") say(WtProtocol.message(e.code, e.message))
                } catch (_: Exception) { }
            }
        }

        override fun ready(ready: Boolean, appliedSeq: Long, durationSec: Double) {
            val c = code ?: return
            scope.launch { runCatching { withContext(Dispatchers.IO) { client.ready(c, ready, appliedSeq, durationSec) } } }
        }
    }

    /* -------------------------------- clock -------------------------------- */

    /** Six quick pings on joining, then one every 20 s; the lowest round trip wins. */
    private fun startClock() {
        clockJob?.cancel()
        clockJob = scope.launch {
            val samples = ArrayDeque<WtSync.Sample>()
            var prev: Double? = null
            var n = 0
            while (code != null) {
                try {
                    val t0 = System.currentTimeMillis().toDouble()
                    val r = withContext(Dispatchers.IO) { client.ping(t0) }
                    val t3 = System.currentTimeMillis().toDouble()
                    samples.addLast(WtSync.offsetSample(t0, r.t1, r.t2, t3))
                    while (samples.size > 8) samples.removeFirst()
                    WtSync.bestOffset(samples.toList(), prev)?.let { prev = it.offset; engine?.setOffset(it.offset) }
                } catch (e: CancellationException) { throw e } catch (_: Exception) { }
                n++
                delay(if (n < 6) 300L else 20_000L)
            }
        }
    }

    /* -------------------------------- events -------------------------------- */

    private fun startEvents() {
        eventsJob?.cancel()
        eventsJob = scope.launch {
            var failures = 0
            var pollRounds = 0
            while (code != null && _ui.value.phase == WtUi.Phase.IN_ROOM) {
                val c = code ?: break
                try {
                    if (failures >= 3) {
                        // Streams keep breaking on this network (a proxy that buffers them): ask once a second instead,
                        // and try the stream again every half minute.
                        pollOnce(c)
                        delay(1_000)
                        pollRounds++
                        if (pollRounds % 30 == 0) failures = 0
                        continue
                    }
                    var got = false
                    client.events(c, lastEventId).collect { e ->
                        got = true
                        e.id?.let { lastEventId = it }
                        handle(WtProtocol.decode(e))
                    }
                    failures = if (got) 0 else failures + 1
                    delay(1_000)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: UnauthorizedException) {
                    end("Your sign-in ended.")
                } catch (e: ServerException) {
                    if (e.status == 404 || e.status == 403) end(WtProtocol.message(e.code.ifBlank { "not_found" }, e.message))
                    else { failures++; _ui.value = _ui.value.copy(connected = false); delay(2_000) }
                } catch (_: Exception) {
                    failures++
                    _ui.value = _ui.value.copy(connected = false)
                    delay(2_000)
                }
            }
        }
    }

    private suspend fun pollOnce(c: String) {
        val r = withContext(Dispatchers.IO) { client.poll(c, lastEventId) }
        _ui.value = _ui.value.copy(connected = true)
        applyRoom(r.room, r.pid)
        r.chat.forEach { m -> if (m.eventId > 0) lastEventId = m.eventId.toString(); addChat(m) }
    }

    private fun handle(e: WtProtocol.Event?) {
        when (e) {
            is WtProtocol.Event.State -> { _ui.value = _ui.value.copy(connected = true); applyRoom(e.room, e.room.you) }
            is WtProtocol.Event.Chat -> addChat(e.message)
            is WtProtocol.Event.Reaction -> _ui.value = _ui.value.copy(lastReaction = e.reaction)
            is WtProtocol.Event.Media -> onMedia?.invoke(e.change.media)
            is WtProtocol.Event.Closed -> end(if (e.reason == "closed_by_host") "The host ended the room." else "The room ended.")
            WtProtocol.Event.Kicked -> end("You were removed from the room.")
            null -> Unit
        }
    }

    private fun applyRoom(room: WtRoom, you: String?) {
        val now = _ui.value
        val pid = you ?: now.you
        _ui.value = now.copy(room = room.copy(code = ""), you = pid)
        engine?.canControl = _ui.value.canControl
        engine?.onTimeline(room.timeline)
    }

    private fun addChat(m: WtChat) {
        _ui.value = _ui.value.copy(chat = WtProtocol.addChat(_ui.value.chat, m))
    }

    private fun say(text: String) { _ui.value = _ui.value.copy(message = text) }

    fun clearMessage() { _ui.value = _ui.value.copy(message = null) }

    /* -------------------------------- what the panel does -------------------------------- */

    fun sendChat(text: String) {
        val c = code ?: return
        val clean = WtProtocol.cleanOutgoing(text) ?: return
        scope.launch {
            try { withContext(Dispatchers.IO) { client.chat(c, clean) } } catch (e: UnauthorizedException) { } catch (e: ServerException) { say(WtProtocol.message(e.code, e.message)) } catch (_: Exception) { }
        }
    }

    fun react(emoji: String) {
        val c = code ?: return
        if (emoji !in WtProtocol.REACTIONS) return
        scope.launch { runCatching { withContext(Dispatchers.IO) { client.react(c, emoji) } } }
    }

    fun setRate(rate: Double) { engine?.onLocalRate(rate) }

    /** The app is about to load a new title into the player: that is not the person pressing play. */
    fun noteProgrammaticChange() { engine?.suppressLocal(3_000.0) }

    fun setSettings(control: String? = null, wait: Boolean? = null, chat: Boolean? = null) {
        val c = code ?: return
        scope.launch { runCatching { withContext(Dispatchers.IO) { client.settings(c, control, wait, chat) } } }
    }

    fun makeHost(pid: String) { val c = code ?: return; scope.launch { runCatching { withContext(Dispatchers.IO) { client.transfer(c, pid) } } } }
    fun remove(pid: String) { val c = code ?: return; scope.launch { runCatching { withContext(Dispatchers.IO) { client.kick(c, pid) } } } }

    /** Leave (or, as host, keep the room open for the others). */
    fun leave() {
        val c = code
        end(null)
        if (c != null) CoroutineScope(Dispatchers.IO).launch { runCatching { client.leave(c) } }
    }

    /** End the room for everyone (host only; the server refuses anyone else). */
    fun endForEveryone() {
        val c = code
        end(null)
        if (c != null) CoroutineScope(Dispatchers.IO).launch { runCatching { client.close(c) } }
    }

    private fun end(message: String?) {
        code = null
        eventsJob?.cancel(); clockJob?.cancel()
        _ui.value = WtUi(phase = if (message != null) WtUi.Phase.ENDED else WtUi.Phase.IDLE, message = message)
    }

    /** The player is closing: forget everything (leaves the room if still in one). */
    fun close() {
        if (code != null) leave()
        detach()
        scope.coroutineContext[Job]?.cancel()
    }
}
