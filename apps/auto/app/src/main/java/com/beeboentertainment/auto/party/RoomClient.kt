package com.beeboentertainment.auto.party

import android.util.Log
import com.beeboentertainment.auto.data.Http
import com.beeboentertainment.auto.hub.HubClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The phone/tablet's line to the hub's watch-party room.
 *
 * A thin, transport-only wrapper over an OkHttp WebSocket, modelled on
 * [com.beeboentertainment.auto.webrtc.SignalingClient]: it reuses the app's shared
 * OkHttp client from [Http] and knows only the room protocol's JSON envelopes —
 * it has no opinion about players or drift. [PartyController] is the brain on top.
 *
 * It reconnects with exponential backoff, because a room must survive a tunnel
 * or a hop between cell and Wi-Fi, keeping the [deviceName]/[role] the caller
 * first connected with. It does NOT retry when the hub refuses the sign-in
 * (close code 4001) or the request (4002): those end in [RoomConnection.Failed]
 * with a sentence to show, rather than a silent loop against a dead token.
 *
 * Every socket belongs to a generation. [leave] and [connect] start a new one,
 * and callbacks from an older socket are ignored — OkHttp delivers onClosed for
 * the socket we just closed some time later, and before this guard that late
 * callback wiped out the fresh socket and scheduled a duplicate reconnect
 * whenever a party switched role (stop() then start()).
 *
 * Threading: OkHttp delivers socket callbacks on its own reader thread. This
 * class re-emits them onto [events] (a [SharedFlow]) and [connection] (a
 * [StateFlow]); collectors decide their own dispatcher. Senders are safe from
 * any thread and are no-ops while the socket is down.
 *
 * The room protocol is documented in WATCH-PARTY.md.
 */
class RoomClient(
    private val hubJwt: String,
    // Own scope so the reconnect loop outlives any single socket. IO because the
    // only work here is socket I/O and JSON.
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val _events = MutableSharedFlow<RoomEvent>(
        replay = 0,
        extraBufferCapacity = 64,
    )
    val events: SharedFlow<RoomEvent> = _events.asSharedFlow()

    private val _connection = MutableStateFlow<RoomConnection>(RoomConnection.Disconnected)
    val connection: StateFlow<RoomConnection> = _connection.asStateFlow()

    private val lock = Any()
    private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var generation = 0

    @Volatile private var deviceName: String = ""
    @Volatile private var role: RoomRole = RoomRole.VIEWER

    // The last {"type":"error"} the hub sent before closing, if any.
    @Volatile private var lastServerError: String? = null

    /** Our own member id, learned from the roster. */
    @Volatile var memberId: String = ""
        private set

    /**
     * Join the room as [deviceName] with [role]. Returns immediately. Calling
     * again while a socket is up or a reconnect is pending is a no-op — use
     * [leave] first to change identity.
     */
    fun connect(deviceName: String, role: RoomRole) {
        val gen = synchronized(lock) {
            if (webSocket != null || reconnectJob != null) return
            this.deviceName = deviceName
            this.role = role
            generation += 1
            generation
        }
        openSocket(gen, attempt = 0)
    }

    /** Send a `control` command. Safe from any thread; dropped if the socket is down. */
    fun sendControl(action: String, positionMs: Long, videoId: String? = null): Boolean {
        val text = json.encodeToString(OutControl(action = action, positionMs = positionMs, videoId = videoId))
        return currentSocket()?.send(text) ?: false
    }

    /** Send a `sync` beat. Safe from any thread; dropped if the socket is down. */
    fun sendSync(positionMs: Long, playing: Boolean, videoId: String? = null): Boolean {
        val text = json.encodeToString(OutSync(positionMs = positionMs, playing = playing, videoId = videoId))
        return currentSocket()?.send(text) ?: false
    }

    /**
     * Leave the room for good: send `bye`, close the socket, stop reconnecting.
     * Idempotent. The same client can [connect] again afterwards.
     */
    fun leave() {
        val sock = synchronized(lock) {
            generation += 1 // orphan every callback from the socket being closed
            reconnectJob?.cancel()
            reconnectJob = null
            val s = webSocket
            webSocket = null
            s
        }
        sock?.let {
            runCatching { it.send(json.encodeToString(OutBye())) }
            it.close(1000, "client left")
        }
        memberId = ""
        _connection.value = RoomConnection.Disconnected
    }

    // --------------------------------------------------------------- internals

    private fun currentSocket(): WebSocket? = synchronized(lock) { webSocket }

    private fun isCurrent(gen: Int): Boolean = synchronized(lock) { gen == generation }

    private fun openSocket(gen: Int, attempt: Int) {
        if (!isCurrent(gen)) return
        _connection.value =
            if (attempt == 0) RoomConnection.Connecting else RoomConnection.Reconnecting(attempt)
        lastServerError = null

        val url = HubClient.HUB_BASE_URL.toHttpUrl().newBuilder()
            .encodedPath("/room")
            .addQueryParameter("name", deviceName)
            .addQueryParameter("role", role.wire)
            .build()

        // The login token goes in a header on the upgrade, never in the URL: URLs
        // are written down by every proxy, tunnel and crash report on the way.
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $hubJwt")
            .build()

        val sock = Http.client().newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (isCurrent(gen)) dispatch(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onDrop(gen, attempt, code, reason.ifBlank { "room socket closed" })
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // A refused upgrade (e.g. a proxy answering 401/403) has a response.
                val code = when (response?.code) {
                    401, 403 -> CLOSE_UNAUTHORIZED
                    else -> 0
                }
                onDrop(gen, attempt, code, t.message ?: "room transport failed")
            }
        })
        val stale = synchronized(lock) {
            if (gen == generation) { webSocket = sock; false } else true
        }
        // leave() ran while we were building the socket: don't leak it.
        if (stale) sock.cancel()
    }

    private fun onDrop(gen: Int, attempt: Int, code: Int, reason: String) {
        synchronized(lock) {
            if (gen != generation) return // an old socket's late callback
            webSocket = null
        }
        val problem = closeProblem(code, lastServerError)
        if (problem != null) {
            Log.w(TAG, "room refused ($code): $reason")
            synchronized(lock) { generation += 1 }
            _connection.value = RoomConnection.Failed(problem)
            return
        }
        Log.w(TAG, "room socket dropped ($reason); scheduling reconnect")
        scheduleReconnect(gen, attempt + 1)
    }

    private fun scheduleReconnect(gen: Int, attempt: Int) {
        synchronized(lock) {
            if (gen != generation) return
            reconnectJob?.cancel()
            _connection.value = RoomConnection.Reconnecting(attempt)
            reconnectJob = scope.launch {
                delay(backoffMs(attempt))
                synchronized(lock) {
                    if (gen != generation) return@launch
                    reconnectJob = null
                }
                openSocket(gen, attempt)
            }
        }
    }

    private fun dispatch(text: String) {
        val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        val type = obj["type"]?.jsonPrimitive?.content ?: return
        when (type) {
            "roster" -> {
                val msg = decode<RosterMsg>(text) ?: return
                memberId = msg.you
                _connection.value = RoomConnection.Connected
                emit(RoomEvent.Roster(msg.you, msg.members))
            }
            "member-joined" -> {
                val m = decode<MemberJoinedMsg>(text)?.member ?: return
                emit(RoomEvent.MemberJoined(m))
            }
            "member-left" -> {
                val id = decode<MemberLeftMsg>(text)?.id ?: return
                if (id.isNotBlank()) emit(RoomEvent.MemberLeft(id))
            }
            "control" -> {
                val c = decode<ControlMsg>(text) ?: return
                emit(RoomEvent.Control(c.from, c.action, c.positionMs, c.videoId))
            }
            "sync" -> {
                val s = decode<SyncMsg>(text) ?: return
                emit(RoomEvent.Sync(s.from, s.positionMs, s.playing, s.videoId))
            }
            "error" -> lastServerError = decode<ErrorMsg>(text)?.error
            else -> Unit // Unknown envelopes are ignored so the hub can grow.
        }
    }

    private inline fun <reified T> decode(text: String): T? =
        runCatching { json.decodeFromString<T>(text) }.getOrNull()

    private fun emit(event: RoomEvent) {
        if (!_events.tryEmit(event)) {
            Log.w(TAG, "room event buffer full; dropped $event")
        }
    }

    companion object {
        private const val TAG = "RoomClient"
        private const val BASE_BACKOFF_MS = 1_000L
        private const val MAX_BACKOFF_MS = 30_000L

        /** The hub's close code for a missing, expired or wrong token. */
        const val CLOSE_UNAUTHORIZED = 4001

        /** The hub's close code for a request it can't use. */
        const val CLOSE_BAD_REQUEST = 4002

        /** Exponential backoff for reconnect [attempt] (1-based): 1s, 2s, 4s … 30s. */
        fun backoffMs(attempt: Int): Long =
            (BASE_BACKOFF_MS * (1L shl (attempt - 1).coerceIn(0, 5))).coerceAtMost(MAX_BACKOFF_MS)

        /**
         * A sentence for a close that retrying won't fix, or null when the drop
         * is worth a reconnect (network loss, hub restart, normal close).
         */
        fun closeProblem(code: Int, serverError: String?): String? = when (code) {
            CLOSE_UNAUTHORIZED ->
                "Your Beebo account sign-in has expired. Sign in again to join the party."
            CLOSE_BAD_REQUEST ->
                "The hub couldn't use this party request" +
                    (serverError?.takeIf { it.isNotBlank() }?.let { " ($it)." } ?: ".")
            else -> null
        }
    }
}
