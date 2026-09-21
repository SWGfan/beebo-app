package com.beeboentertainment.auto.webrtc

import com.beeboentertainment.auto.data.Http
import com.beeboentertainment.auto.hub.HubClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * The WebSocket half of Stage 2: the phone's line to the hub's signalling relay.
 *
 * The relay never touches media. It carries only the SDP/ICE handshake between
 * this phone and the user's home PC, so both can learn each other's public
 * candidates and open a peer-to-peer connection that flows straight between
 * them. See the signalling contract in WEBRTC-STAGE2.md.
 *
 * This class is a thin, transport-only wrapper. It knows the four hub envelope
 * shapes (`session-open`, `peer-offline`, `signal`, and the two teardown
 * messages) and nothing about SDP — the inner `payload` is handed up verbatim
 * for [WebRtcSession] to interpret. It reuses the app's shared OkHttp client
 * from [Http] so the WebSocket shares the same pool and TLS config as every
 * other call.
 *
 * Threading: all [Listener] callbacks arrive on OkHttp's WebSocket reader
 * thread, one at a time. Callers that touch UI or the PeerConnection must hop to
 * their own executor — [WebRtcSession] and [WebRtcConnector] already do.
 */
class SignalingClient(
    private val userJwt: String,
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

    // The hub's {"type":"error"} sent just before it closes the socket, if any.
    @Volatile private var lastServerError: String? = null

    /**
     * Open the relay socket for [sessionId] and start delivering to [listener].
     *
     * [sessionId] is any unique string the app picks for this attempt; the PC
     * learns it from the relay. Returns immediately — the handshake runs on the
     * WebSocket thread and surfaces through [listener].
     */
    fun connect(sessionId: String, listener: Listener) {
        this.listener = listener

        // /signal lives on the same host as the hub's REST surface, reached over
        // wss. Build the URL through HttpUrl so query encoding is correct, then
        // flip the scheme (OkHttp accepts ws/wss on a normal Request for the
        // WebSocket upgrade).
        val url = HubClient.HUB_BASE_URL.toHttpUrl().newBuilder()
            .encodedPath("/signal")
            .addQueryParameter("session", sessionId)
            .build()

        // The login token goes in a header on the upgrade, never in the URL: URLs
        // are written down by every proxy, tunnel and crash report on the way.
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $userJwt")
            .build()

        webSocket = Http.client().newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                dispatch(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // Acknowledge the close handshake so the socket shuts down cleanly.
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                emitClosed(describeClose(code, reason, lastServerError), null)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                emitClosed(
                    if (response?.code == 401 || response?.code == 403) describeClose(4001, "", null)
                    else "Couldn't reach the Beebo hub. Check the phone's internet connection.",
                    t,
                )
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

    /** Close the relay socket. Idempotent. [onClosed] still fires once. */
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
            "session-closed", "peer-gone" -> emitClosed("Your PC ended the session.", null)
            "error" -> lastServerError = obj.optString("error").takeIf { it.isNotBlank() }
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

    companion object {
        /**
         * A sentence for the hub closing the signalling socket. The hub's codes:
         * 4001 unauthorized, 4002 bad request, 4004 PC offline.
         */
        fun describeClose(code: Int, reason: String, serverError: String?): String = when (code) {
            4001 -> "Your Beebo account sign-in has expired. Sign in again."
            4002 -> "The hub couldn't use this connection request" +
                (serverError?.takeIf { it.isNotBlank() }?.let { " ($it)." } ?: ".")
            4004 -> "Your PC isn't connected to the Beebo hub right now."
            1000, 1001 -> "The connection to the hub closed."
            else -> reason.takeIf { it.isNotBlank() }?.let { "The hub closed the connection: $it" }
                ?: "The connection to the hub closed unexpectedly."
        }
    }
}
