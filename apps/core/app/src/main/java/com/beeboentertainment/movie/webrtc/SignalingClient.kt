package com.beeboentertainment.movie.webrtc

import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * The WebSocket half of the WebRTC receiver: the app's line to the hub's
 * signalling relay.
 *
 * The relay never touches media. It carries only the SDP/ICE handshake between
 * this device and the user's home PC, so both can learn each other's public
 * candidates and open a peer-to-peer connection that flows straight between
 * them.
 *
 * This class is a thin, transport-only wrapper. It knows the hub envelope
 * shapes (`session-open`, `peer-offline`, `signal`, and the two teardown
 * messages) and nothing about SDP — the inner `payload` is handed up verbatim
 * for [WebRtcSession] to interpret. It reuses the app's shared OkHttp client
 * (from ApiClient) so the WebSocket shares the same pool and TLS config as
 * every other call.
 *
 * Threading: all [Listener] callbacks arrive on OkHttp's WebSocket reader
 * thread, one at a time. Callers that touch UI or the PeerConnection must hop to
 * their own executor — [WebRtcSession] and [WebRtcConnector] already do.
 */
class SignalingClient(
    private val hubToken: String,
    private val baseUrl: String,
    private val http: OkHttpClient,
) {

    /** What the relay tells us, decoded to the four things a caller reacts to. */
    interface Listener {
        /** The relay accepted the connection; the PC is reachable. */
        fun onSessionOpen(sessionId: String)

        /** The relay says the PC is not online. The socket closes right after. */
        fun onPeerOffline()

        /** A handshake blob from the PC. [payload] is the PC's own JSON object. */
        fun onSignal(payload: JSONObject)

        /**
         * The session ended — a clean `session-closed`/`peer-gone`, a socket
         * close, or a transport failure. [reason] is a short human string;
         * [error] is set only for a transport failure. Fired exactly once.
         */
        fun onClosed(reason: String, error: Throwable?)
    }

    private var webSocket: WebSocket? = null
    private var listener: Listener? = null

    @Volatile private var closedEmitted = false

    /**
     * Open the relay socket for [sessionId] and start delivering to [listener].
     *
     * [sessionId] is any unique string the app picks for this attempt; the PC
     * learns it from the relay. Returns immediately — the handshake runs on the
     * WebSocket thread and surfaces through [listener].
     */
    fun connect(sessionId: String, listener: Listener) {
        this.listener = listener

        val request = signalUpgradeRequest(baseUrl, hubToken, sessionId)

        webSocket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                dispatch(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // Acknowledge the close handshake so the socket shuts down cleanly.
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                emitClosed(if (reason.isBlank()) "Signalling socket closed" else reason, null)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                emitClosed(t.message ?: "Signalling transport failed", t)
            }
        })
    }

    /**
     * Send a handshake blob to the PC. [payload] is wrapped in the relay's
     * `{"type":"signal","payload":…}` envelope. Safe to call from any thread;
     * a no-op if the socket is already gone.
     */
    fun send(payload: JSONObject) {
        val envelope = JSONObject()
            .put("type", "signal")
            .put("payload", payload)
        webSocket?.send(envelope.toString())
    }

    /** Close the relay socket. Idempotent. [Listener.onClosed] still fires once. */
    fun close() {
        // 1000 = normal closure. If the socket never opened this is a no-op.
        webSocket?.close(1000, "client closed")
        webSocket = null
    }

    // ---------------------------------------------------------------- internals

    private fun dispatch(text: String) {
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (obj.optString("type")) {
            "session-open" -> listener?.onSessionOpen(obj.optString("sessionId"))
            "peer-offline" -> listener?.onPeerOffline()
            "signal" -> {
                // The PC's blob is nested under "payload"; hand it up untouched.
                obj.optJSONObject("payload")?.let { listener?.onSignal(it) }
            }
            "session-closed", "peer-gone" -> emitClosed("Peer ended the session", null)
            else -> Unit // Unknown envelope types are ignored so the hub can grow.
        }
    }

    private fun emitClosed(reason: String, error: Throwable?) {
        // The relay can hand us more than one terminal signal (e.g. peer-gone
        // then a socket close); collapse them so the listener sees exactly one.
        if (closedEmitted) return
        closedEmitted = true
        listener?.onClosed(reason, error)
    }
}

/**
 * The WebSocket upgrade request for the hub's `/signal`.
 *
 * /signal lives on the same host as the REST surface. The URL is built through
 * HttpUrl so query encoding is correct; OkHttp accepts an http/https URL on a
 * normal Request and performs the WebSocket upgrade. The login token goes in the
 * Authorization header, never in the URL: URLs are written down by every proxy,
 * tunnel and crash report on the way.
 */
internal fun signalUpgradeRequest(baseUrl: String, hubToken: String, sessionId: String): Request {
    val url = baseUrl.toHttpUrl().newBuilder()
        .encodedPath("/signal")
        .addQueryParameter("session", sessionId)
        .build()
    return Request.Builder()
        .url(url)
        .header("Authorization", "Bearer $hubToken")
        .build()
}
