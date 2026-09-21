package com.beeboentertainment.movie.party

import android.util.Log
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.hub.HubClient
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
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The device's line to the hub's watch-party room.
 *
 * A thin, transport-only wrapper over an OkHttp WebSocket: it reuses the core
 * app's shared OkHttp client (same pool, same TLS) and knows only the room
 * protocol's JSON envelopes — it has no opinion about players or drift.
 * [PartyController] is the brain on top.
 *
 * It adds a self-contained reconnect loop with exponential backoff: a room is a
 * long-lived thing that must survive a network handoff. Reconnect keeps the
 * [deviceName]/[role] the caller first connected with.
 *
 * Threading: OkHttp delivers socket callbacks on its own reader thread. This
 * class re-emits them onto [events] (a [SharedFlow]) and [connection] (a
 * [StateFlow]); collectors decide their own dispatcher. Senders are safe from
 * any thread and are no-ops while the socket is down.
 */
class RoomClient(
    private val hubJwt: String,
    private val http: OkHttpClient = BeeboApp.instance.api.okHttp,
    // Own scope so the reconnect loop outlives any single socket. Cancelled by
    // [leave]. IO because the only work here is socket I/O and JSON.
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {

    // Configured identically to HubClient's Json.
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    // replay = 0: events are live; a late collector should not be handed a stale
    // control. extraBufferCapacity keeps a burst (roster + several joins) from
    // suspending the socket thread.
    private val _events = MutableSharedFlow<RoomEvent>(
        replay = 0,
        extraBufferCapacity = 64,
    )
    val events: SharedFlow<RoomEvent> = _events.asSharedFlow()

    private val _connection = MutableStateFlow<RoomConnection>(RoomConnection.Disconnected)
    val connection: StateFlow<RoomConnection> = _connection.asStateFlow()

    private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null

    // Remembered so a reconnect re-joins as the same device/role.
    @Volatile private var deviceName: String = ""
    @Volatile private var role: RoomRole = RoomRole.VIEWER

    // Set by leave(): stops the reconnect loop from resurrecting a socket we
    // deliberately closed. Distinct from a transport drop, which SHOULD retry.
    @Volatile private var left = false

    /** Our own member id, learned from the roster. Handy for filtering/logging. */
    @Volatile var memberId: String = ""
        private set

    /**
     * Join the room as [deviceName] with [role] and start delivering to
     * [events]/[connection]. Returns immediately; the handshake runs on the
     * socket thread. Calling again while connected is a no-op — use [leave]
     * first to change identity.
     */
    fun connect(deviceName: String, role: RoomRole) {
        if (webSocket != null || reconnectJob != null) return
        this.deviceName = deviceName
        this.role = role
        left = false
        openSocket(attempt = 0)
    }

    /** Send a `control` command. Safe from any thread; dropped if the socket is down. */
    fun sendControl(action: String, positionMs: Long, videoId: String? = null): Boolean {
        val text = json.encodeToString(OutControl(action = action, positionMs = positionMs, videoId = videoId))
        return webSocket?.send(text) ?: false
    }

    /**
     * Send a `sync` beat. Safe from any thread; dropped if the socket is down.
     *
     * [videoId] is the host's currently loaded media id. Carrying it on every
     * beat is what lets a viewer that joined late converge on the right film
     * instead of waiting for a `load` that already happened.
     */
    fun sendSync(positionMs: Long, playing: Boolean, videoId: String? = null): Boolean {
        val text = json.encodeToString(
            OutSync(positionMs = positionMs, playing = playing, videoId = videoId)
        )
        return webSocket?.send(text) ?: false
    }

    /**
     * Send a generic application envelope of the given [type] carrying [payload]'s
     * fields, over the same socket as control/sync. The hub relays it to the rest
     * of the room and stamps `from` on the way out (we never send it), exactly like
     * a `control`. Used by the party games and the shared checklist. Safe from any
     * thread; dropped (returns false) if the socket is down.
     *
     * The wire shape is `{ "type": <type>, ...payload }`; the receiving end gets it
     * back as [RoomEvent.App]. [type] must stay in the "game_" / "checklist_"
     * families - that is what the hub relays and what [dispatch] surfaces (and an
     * older client that does not know the type simply ignores the envelope).
     */
    fun sendApp(type: String, payload: JsonObject): Boolean {
        val envelope = buildJsonObject {
            put("type", type)
            payload.forEach { (k, v) -> put(k, v) }
        }
        return webSocket?.send(envelope.toString()) ?: false
    }

    /**
     * Leave the room for good: send an optional `bye`, close the socket, and stop
     * reconnecting. Idempotent. After this the client is inert until the next
     * [connect]. Does NOT cancel [scope] — the same client can be reused.
     */
    fun leave() {
        left = true
        reconnectJob?.cancel()
        reconnectJob = null
        webSocket?.let { sock ->
            runCatching { sock.send(json.encodeToString(OutBye())) }
            sock.close(1000, "client left")
        }
        webSocket = null
        _connection.value = RoomConnection.Disconnected
    }

    // --------------------------------------------------------------- internals

    private fun openSocket(attempt: Int) {
        if (left) return
        _connection.value =
            if (attempt == 0) RoomConnection.Connecting else RoomConnection.Reconnecting(attempt)

        val request = roomUpgradeRequest(HubClient.HUB_BASE_URL, hubJwt, deviceName, role)

        webSocket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // The socket is up but not yet "Connected" — we hold that until
                // the roster lands, so a collector never sees Connected without a
                // roster. Backoff is reset on the roster, not here.
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                dispatch(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onDrop(attempt, reason.ifBlank { "room socket closed" })
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onDrop(attempt, t.message ?: "room transport failed")
            }
        })
    }

    private fun onDrop(attempt: Int, reason: String) {
        webSocket = null
        if (left) {
            _connection.value = RoomConnection.Disconnected
            return
        }
        Log.w(TAG, "room socket dropped ($reason); scheduling reconnect")
        scheduleReconnect(attempt + 1)
    }

    private fun scheduleReconnect(attempt: Int) {
        reconnectJob?.cancel()
        _connection.value = RoomConnection.Reconnecting(attempt)
        reconnectJob = scope.launch {
            // Exponential backoff, 1s -> 30s, capped.
            val backoffMs = (BASE_BACKOFF_MS * (1L shl (attempt - 1).coerceIn(0, 5)))
                .coerceAtMost(MAX_BACKOFF_MS)
            delay(backoffMs)
            if (!left) openSocket(attempt)
        }
    }

    private fun dispatch(text: String) {
        val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        val type = obj["type"]?.jsonPrimitive?.content ?: return
        when (type) {
            "roster" -> {
                val msg = decode<RosterMsg>(text) ?: return
                memberId = msg.you
                // The room is up and we know who we are: this is the real
                // "Connected", and the moment to reset backoff.
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
            else -> {
                // Application-level envelopes (party games, shared checklist) ride the
                // same relay. We recognise them by their type family and hand the whole
                // decoded object up as an App event; anything else is ignored so the hub
                // can keep adding envelope types without breaking an installed app.
                if (type.startsWith("game_") || type.startsWith("checklist_")) {
                    val from = obj["from"]?.jsonPrimitive?.content ?: ""
                    emit(RoomEvent.App(from, type, obj))
                }
            }
        }
    }

    private inline fun <reified T> decode(text: String): T? =
        runCatching { json.decodeFromString<T>(text) }.getOrNull()

    private fun emit(event: RoomEvent) {
        // tryEmit never suspends; the 64-slot buffer absorbs bursts. If it ever
        // overflows (a collector wedged for a long time) dropping the oldest
        // control is the right failure — the next sync beat re-locks the viewer.
        if (!_events.tryEmit(event)) {
            Log.w(TAG, "room event buffer full; dropped $event")
        }
    }

    private companion object {
        const val TAG = "RoomClient"
        const val BASE_BACKOFF_MS = 1_000L
        const val MAX_BACKOFF_MS = 30_000L
    }
}

/**
 * The WebSocket upgrade request for the hub's `/room`.
 *
 * /room lives on the same host as the hub's REST surface. The URL is built through
 * HttpUrl so query encoding is correct; OkHttp takes the https base directly for the
 * WebSocket upgrade. The login token goes in the Authorization header, never in the
 * URL: URLs are written down by every proxy, tunnel and crash report on the way.
 */
internal fun roomUpgradeRequest(baseUrl: String, hubJwt: String, deviceName: String, role: RoomRole): Request {
    val url = baseUrl.toHttpUrl().newBuilder()
        .encodedPath("/room")
        .addQueryParameter("name", deviceName)
        .addQueryParameter("role", role.wire)
        .build()
    return Request.Builder()
        .url(url)
        .header("Authorization", "Bearer $hubJwt")
        .build()
}
