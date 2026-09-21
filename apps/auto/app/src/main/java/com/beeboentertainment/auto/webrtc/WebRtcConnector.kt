package com.beeboentertainment.auto.webrtc

import android.content.Context
import com.beeboentertainment.auto.data.Http
import com.beeboentertainment.auto.hub.HubClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject
import org.webrtc.PeerConnection
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import java.util.UUID

/**
 * The high-level entry point for Stage 2: hand it a hub token and it brings up a
 * peer-to-peer link to the user's home PC, exposing progress as a [State] flow.
 *
 * This is what the app calls when [com.beeboentertainment.auto.hub.PcInfo.connectVia] is
 * `"signal"`. It wires the three lower layers together:
 *
 *   1. `GET /api/v1/ice` (Bearer userJwt)  -> ICE servers
 *   2. [SignalingClient] over `/signal`    -> SDP/ICE relay to the PC
 *   3. [WebRtcSession] as the offerer       -> the actual peer connection
 *
 * The PC is the **answerer**: this client sends the offer and expects the PC's
 * WebRTC component (a SEPARATE piece, not in this app) to reply with an answer
 * and its candidates through the same relay. Media then flows directly phone
 * <-> PC; the hub only ever saw the handshake.
 *
 * Usage:
 * ```
 * val connector = WebRtcConnector(context, userJwt)
 * lifecycleScope.launch { connector.connect() }
 * // observe connector.state; when Connected, connector.remoteVideo has the track
 * // …later…
 * connector.close()
 * ```
 */
class WebRtcConnector(
    context: Context,
    private val userJwt: String,
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

    // Only a watchdog lives here: a PC that never answers must not leave the
    // screen on "Connecting" forever.
    private val watchdogScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var watchdog: Job? = null

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
        watchdog = watchdogScope.launch {
            delay(CONNECT_TIMEOUT_MS)
            if (_state.value is State.Connecting) {
                fail("Your PC didn't answer. Make sure Beebo is running on it and try again.")
            }
        }

        val iceServers = try {
            fetchIceServers()
        } catch (t: Throwable) {
            fail(t.message?.takeIf { t is IllegalStateException }
                ?: "Couldn't reach the Beebo hub. Check the phone's internet connection.")
            return
        }
        if (terminated) return

        val session = WebRtcSession(appContext, iceServers, sessionEvents)
        this.session = session

        val signaling = SignalingClient(userJwt)
        this.signaling = signaling
        signaling.connect(sessionId, signalingListener)
    }

    /** Send a control message to the PC over the data channel. */
    fun sendControl(text: String): Boolean = session?.sendControl(text) ?: false

    /**
     * Build a renderer bound to the live session's EGL context. Returns null if
     * there is no session yet. See [WebRtcSession.createRenderer]'s device TODO.
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
        watchdog?.cancel()
        runCatching { watchdogScope.cancel() }
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

        override fun onFailure(reason: String) = fail(reason)

        override fun onRemoteVideoTrack(track: VideoTrack) {
            _remoteVideo.value = track
        }

        override fun onIceState(state: PeerConnection.IceConnectionState) {
            when (state) {
                PeerConnection.IceConnectionState.CONNECTED,
                PeerConnection.IceConnectionState.COMPLETED ->
                    if (!terminated) _state.value = State.Connected

                PeerConnection.IceConnectionState.FAILED -> fail(ICE_FAILED_MESSAGE)

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
            val req = Request.Builder()
                .url(HubClient.HUB_BASE_URL + "/api/v1/ice")
                .get()
                .header("Authorization", "Bearer $userJwt")
                .build()
            Http.client().newCall(req).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    error(HubClient.messageFor(resp.code, null))
                }
                WebRtcSession.parseIceServers(JSONObject(body))
            }
        }

    companion object {
        const val CONNECT_TIMEOUT_MS = 30_000L

        /**
         * Beebo connects peer-to-peer only; the hub hands out STUN, never a relay
         * (since 15 Sep). So a failed ICE check usually means the two networks
         * can't see each other directly, most often mobile data behind carrier NAT.
         */
        const val ICE_FAILED_MESSAGE =
            "Couldn't open a direct link to your PC. Beebo connects peer-to-peer with no relay, " +
                "so this works on the same Wi-Fi as the PC or where its router allows it. " +
                "Mobile data often can't."
    }
}
