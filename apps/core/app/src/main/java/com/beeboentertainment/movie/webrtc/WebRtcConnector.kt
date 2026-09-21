package com.beeboentertainment.movie.webrtc

import android.content.Context
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import org.webrtc.PeerConnection
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import java.util.UUID

/**
 * The high-level entry point for the WebRTC receiver: hand it a hub token, a
 * base URL and the shared OkHttp client, and it brings up a peer-to-peer link to
 * the user's home PC, exposing progress as a [State] flow and the inbound remote
 * video as [remoteVideo].
 *
 * It wires the three lower layers together:
 *
 *   1. `GET /api/v1/ice` (Bearer hubToken)  -> ICE servers
 *   2. [SignalingClient] over `/signal`     -> SDP/ICE relay to the PC
 *   3. [WebRtcSession] as the offerer        -> the actual peer connection
 *
 * The PC is the **answerer**: this client sends the offer and expects the PC's
 * WebRTC component (a SEPARATE piece, not in this app) to reply with an answer
 * and its candidates through the same relay. Media then flows directly device
 * <-> PC; the hub only ever saw the handshake.
 *
 * Usage:
 * ```
 * val connector = WebRtcConnector(context, hubToken, baseUrl, apiClient.okHttp)
 * lifecycleScope.launch { connector.connect() }
 * // observe connector.state; when Connected, connector.remoteVideo has the track
 * // …later…
 * connector.close()
 * ```
 *
 * A later UI step attaches [remoteVideo] into the player screen (via a renderer
 * from [createRenderer] and `VideoTrack.addSink`); that wiring is intentionally
 * not done here.
 */
class WebRtcConnector(
    context: Context,
    private val hubToken: String,
    private val baseUrl: String,
    private val http: OkHttpClient,
) {

    /** Where the connection is. A cold [state] starts at [Idle]. */
    sealed class State {
        object Idle : State()
        object Connecting : State()
        object Connected : State()

        /** The relay reported the PC is not online. Terminal. */
        object PeerOffline : State()

        /** Something failed; [reason] is worth showing. Terminal. */
        data class Failed(val reason: String) : State()
    }

    private val appContext = context.applicationContext

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    // The inbound PC video track, once it arrives. A screen collects this and
    // attaches it to a renderer from [createRenderer].
    private val _remoteVideo = MutableStateFlow<VideoTrack?>(null)
    val remoteVideo: StateFlow<VideoTrack?> = _remoteVideo.asStateFlow()

    private var signaling: SignalingClient? = null
    private var session: WebRtcSession? = null

    @Volatile private var terminated = false

    /** The sessionId used for the current attempt; handy for logging/tests. */
    var sessionId: String = ""
        private set

    /**
     * Fetch ICE servers and open the relay. Suspends only for the ICE HTTP call;
     * the handshake itself runs on the signalling/WebRTC threads and drives
     * [state]. Pass a [sessionId] to reuse one, or let it be generated.
     *
     * Never throws — a failure to fetch ICE lands in [state] as [State.Failed].
     */
    suspend fun connect(sessionId: String = UUID.randomUUID().toString()) {
        this.sessionId = sessionId
        _state.value = State.Connecting

        val iceServers = try {
            fetchIceServers()
        } catch (t: Throwable) {
            fail(t.message ?: "Could not fetch connection details from the hub.")
            return
        }
        if (terminated) return

        val session = WebRtcSession(appContext, iceServers, sessionEvents)
        this.session = session

        val signaling = SignalingClient(hubToken, baseUrl, http)
        this.signaling = signaling
        signaling.connect(sessionId, signalingListener)
    }

    /** Send a control message to the PC over the data channel. */
    fun sendControl(text: String): Boolean = session?.sendControl(text) ?: false

    /**
     * Build a renderer bound to the live session's EGL context. Returns null if
     * there is no session yet. Renderer init/release must run on the UI thread —
     * see [WebRtcSession.createRenderer].
     */
    fun createRenderer(context: Context): SurfaceViewRenderer? =
        session?.createRenderer(context)

    /** Release a renderer created by [createRenderer]. */
    fun releaseRenderer(renderer: SurfaceViewRenderer, track: VideoTrack?) {
        session?.releaseRenderer(renderer, track)
    }

    /** Tear everything down. Idempotent; safe from any thread. */
    fun close() {
        if (terminated) return
        terminated = true
        runCatching { signaling?.close() }
        signaling = null
        runCatching { session?.close() }
        session = null
        _remoteVideo.value = null
    }

    // --------------------------------------------------------------- internals

    private val signalingListener = object : SignalingClient.Listener {
        override fun onSessionOpen(sessionId: String) {
            // Relay accepted us and the PC is reachable — start the offer.
            session?.start()
        }

        override fun onPeerOffline() {
            _state.value = State.PeerOffline
            close()
        }

        override fun onSignal(payload: JSONObject) {
            session?.handleRemoteSignal(payload)
        }

        override fun onClosed(reason: String, error: Throwable?) {
            // A close after we are already Connected/terminal is expected teardown.
            if (_state.value is State.Connected || terminated ||
                _state.value is State.PeerOffline
            ) {
                return
            }
            fail(reason)
        }
    }

    private val sessionEvents = object : WebRtcSession.Events {
        override fun onLocalSignal(payload: JSONObject) {
            signaling?.send(payload)
        }

        override fun onRemoteVideoTrack(track: VideoTrack) {
            _remoteVideo.value = track
        }

        override fun onIceState(state: PeerConnection.IceConnectionState) {
            when (state) {
                PeerConnection.IceConnectionState.CONNECTED,
                PeerConnection.IceConnectionState.COMPLETED ->
                    if (!terminated) _state.value = State.Connected

                PeerConnection.IceConnectionState.FAILED ->
                    fail("The peer-to-peer connection could not be established.")

                PeerConnection.IceConnectionState.CLOSED,
                PeerConnection.IceConnectionState.DISCONNECTED -> {
                    // DISCONNECTED can be transient; only fail if we never got up.
                    if (_state.value !is State.Connected && !terminated) {
                        fail("The connection to your PC dropped.")
                    }
                }

                else -> Unit
            }
        }
    }

    private fun fail(reason: String) {
        if (terminated) return
        _state.value = State.Failed(reason)
        close()
    }

    /** `GET /api/v1/ice` with the hub bearer token, parsed to IceServers. */
    private suspend fun fetchIceServers(): List<PeerConnection.IceServer> =
        withContext(Dispatchers.IO) {
            val target = UrlUtils.endpoint(baseUrl, "/api/v1/ice")
                ?: error("No server address configured for the WebRTC connection.")
            val req = Request.Builder()
                .url(target)
                .get()
                .header("Authorization", "Bearer $hubToken")
                .build()
            http.newCall(req).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    error("The hub could not provide connection servers (HTTP ${resp.code}).")
                }
                WebRtcSession.parseIceServers(JSONObject(body))
            }
        }

    companion object {
        /**
         * Build and start a [WebRtcConnector] from persisted session state.
         *
         * Reads the hub token and base URL from [SessionStore] and reuses the
         * app's shared OkHttp client (from [ApiClient]). Returns null when the
         * app is not configured/signed in for a remote session (no hub token or
         * no base URL). The returned connector has already had [connect] driven,
         * so callers only need to observe [state] / [remoteVideo] and eventually
         * call [close].
         */
        suspend fun startRemoteSession(
            context: Context,
            sessionId: String? = null,
        ): WebRtcConnector? {
            val session = SessionStore(context)
            // hubToken is the JWT the hub relay authenticates the /signal socket
            // and /api/v1/ice with. Assumed to be provided by SessionStore.
            val hubToken = session.hubToken?.takeIf { it.isNotBlank() } ?: return null
            val baseUrl = session.baseUrl?.takeIf { it.isNotBlank() } ?: return null
            val http = ApiClient(session).okHttp

            val connector = WebRtcConnector(context, hubToken, baseUrl, http)
            connector.connect(sessionId ?: UUID.randomUUID().toString())
            return connector
        }
    }
}
