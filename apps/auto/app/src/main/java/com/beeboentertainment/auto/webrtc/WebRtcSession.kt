package com.beeboentertainment.auto.webrtc

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import java.nio.charset.StandardCharsets

/**
 * Owns one WebRTC peer connection to the home PC, acting as the **offerer**.
 *
 * Lifecycle, in order:
 *  1. [start] builds the [PeerConnectionFactory] and [PeerConnection] from the
 *     hub-supplied ICE servers, adds recv-only transceivers, opens a control
 *     data channel, then creates and sends the SDP offer.
 *  2. As ICE candidates are gathered they are sent out through [Events.onLocalSignal].
 *  3. The PC's answer and candidates arrive via [handleRemoteSignal].
 *  4. When the remote video track lands, [Events.onRemoteVideoTrack] fires; a
 *     screen can attach it to a renderer built by [createRenderer].
 *  5. [close] tears everything down and releases native memory.
 *
 * The wire shape of every blob this exchanges (chosen by us, opaque to the hub):
 *   offer/answer -> {"kind":"offer"|"answer","sdp":"<sdp text>"}
 *   candidate    -> {"kind":"candidate","sdpMid":..,"sdpMLineIndex":..,"candidate":..}
 *
 * Threading: WebRTC's native callbacks arrive on its own signalling thread.
 * Every mutation of the peer connection here happens on that thread or on the
 * caller's thread; the class does not add its own executor, so callers should
 * treat it as single-threaded and drive it from one place ([WebRtcConnector]).
 *
 * TODO(device): audio routing (speakerphone vs. car A2DP), and whether to keep
 * the audio transceiver at all, needs tuning against a real car head unit.
 */
class WebRtcSession(
    context: Context,
    private val iceServers: List<PeerConnection.IceServer>,
    private val events: Events,
) {

    /** Everything a screen or the connector reacts to. Called on WebRTC threads. */
    interface Events {
        /** A blob to hand to [SignalingClient.send] verbatim. */
        fun onLocalSignal(payload: JSONObject)

        /** The remote video track arrived. Attach it to a renderer to display it. */
        fun onRemoteVideoTrack(track: VideoTrack)

        /** ICE connection state changed. Terminal states drive [WebRtcConnector]. */
        fun onIceState(state: PeerConnection.IceConnectionState)

        /** A control message came over the data channel (UTF-8 text). Optional. */
        fun onDataChannelMessage(text: String) {}

        /** The session can't go on (native library missing, SDP rejected). [reason] is showable. */
        fun onFailure(reason: String) {}
    }

    private val appContext = context.applicationContext

    // One EglBase per session backs both the decoder factory and any renderer,
    // so decoded frames and the GL surface share a context. Released in close().
    // Created in start(), not here, so a device that cannot run WebRTC fails
    // through Events.onFailure instead of throwing from a constructor.
    @Volatile private var eglBase: EglBase? = null

    private var factory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var dataChannel: DataChannel? = null

    @Volatile private var closed = false

    // --------------------------------------------------------------- public API

    /**
     * Build the factory + connection and send the initial offer. Call once.
     * Never throws: this runs on the signalling socket's thread, where an
     * exception would take the app down. A device whose CPU the bundled native
     * library doesn't cover (the build ships arm64-v8a only, so x86 emulators)
     * throws UnsatisfiedLinkError here; that becomes [Events.onFailure].
     */
    fun start() {
        try {
            startOrThrow()
        } catch (t: Throwable) {
            events.onFailure(
                if (t is UnsatisfiedLinkError || t is NoClassDefFoundError) {
                    "This device can't run the peer-to-peer video link."
                } else {
                    "Couldn't start the peer-to-peer link: ${t.message ?: t.javaClass.simpleName}"
                }
            )
        }
    }

    private fun startOrThrow() {
        if (closed) return
        val eglBase = EglBase.create().also { this.eglBase = it }
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext)
                .createInitializationOptions()
        )

        val encoderFactory = DefaultVideoEncoderFactory(
            eglBase.eglBaseContext,
            /* enableIntelVp8Encoder = */ true,
            /* enableH264HighProfile = */ true,
        )
        val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)

        val factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()
        this.factory = factory

        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            // Unified Plan is the only sane choice with modern browsers/libwebrtc
            // and is what onTrack below assumes.
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            // Let the stack trickle candidates as they are found instead of
            // waiting for the full gather — faster connect through the relay.
            continualGatheringPolicy =
                PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            // TURN over TCP/TLS is the fallback when a symmetric NAT blocks the
            // peer-to-peer path; leave the policy at ALL so it can be used.
            iceTransportsType = PeerConnection.IceTransportsType.ALL
        }

        val connection = factory.createPeerConnection(rtcConfig, pcObserver)
            ?: error("PeerConnectionFactory returned no PeerConnection")
        peerConnection = connection

        // Receive-only video. No audio transceiver: the PC answerer sends none,
        // and in the car sound belongs to the media session, which Android Auto
        // and AAOS can govern while driving. A WebRTC audio track would play
        // straight to the default sink, outside those rules.
        connection.addTransceiver(
            MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
            RtpTransceiver.RtpTransceiverInit(
                RtpTransceiver.RtpTransceiverDirection.RECV_ONLY
            ),
        )

        // A lightweight ordered/reliable channel for control (pause, seek, etc.).
        // Created before the offer so it is negotiated in that same SDP.
        dataChannel = connection.createDataChannel(
            "control",
            DataChannel.Init().apply { ordered = true },
        )?.also { it.registerObserver(dataChannelObserver(it)) }

        createOffer(connection)
    }

    /**
     * Apply a handshake blob that came from the PC through the relay.
     * Understands the `kind` values this class emits: `answer` and `candidate`.
     */
    fun handleRemoteSignal(payload: JSONObject) {
        if (closed) return
        val connection = peerConnection ?: return
        when (payload.optString("kind")) {
            "answer" -> {
                val sdp = payload.optString("sdp")
                connection.setRemoteDescription(
                    logSdpObserver("setRemote(answer)"),
                    SessionDescription(SessionDescription.Type.ANSWER, sdp),
                )
            }
            "candidate" -> {
                val candidate = IceCandidate(
                    payload.optString("sdpMid"),
                    payload.optInt("sdpMLineIndex"),
                    payload.optString("candidate"),
                )
                connection.addIceCandidate(candidate)
            }
            // An "offer" here would mean the PC tried to be the offerer too;
            // this client is always the offerer, so ignore it.
            else -> Unit
        }
    }

    /** Send a UTF-8 control message to the PC over the data channel. */
    fun sendControl(text: String): Boolean {
        val channel = dataChannel ?: return false
        if (channel.state() != DataChannel.State.OPEN) return false
        val buffer = java.nio.ByteBuffer.wrap(text.toByteArray(StandardCharsets.UTF_8))
        return channel.send(DataChannel.Buffer(buffer, /* binary = */ false))
    }

    /**
     * Build a [SurfaceViewRenderer] wired to this session's EGL context. The
     * caller owns placing it in a layout; call [releaseRenderer] before [close].
     *
     * TODO(device): renderer init must run on the UI thread, and the renderer
     * must be release()d from the same thread that init()ed it. A Compose
     * AndroidView/DisposableEffect (or a View's onDetachedFromWindow) is the
     * right home for both — this helper only does the init call.
     */
    fun createRenderer(context: Context): SurfaceViewRenderer? {
        val egl = eglBase ?: return null
        return runCatching {
            SurfaceViewRenderer(context).apply {
                init(egl.eglBaseContext, null)
                setEnableHardwareScaler(true)
            }
        }.getOrNull()
    }

    /** Detach a track from a renderer and release it. Mirror of [createRenderer]. */
    fun releaseRenderer(renderer: SurfaceViewRenderer, track: VideoTrack?) {
        runCatching { track?.removeSink(renderer) }
        runCatching { renderer.release() }
    }

    /** Tear down the connection and free all native resources. Idempotent. */
    fun close() {
        if (closed) return
        closed = true
        runCatching { dataChannel?.dispose() }
        dataChannel = null
        runCatching { peerConnection?.dispose() }
        peerConnection = null
        runCatching { factory?.dispose() }
        factory = null
        runCatching { eglBase?.release() }
        eglBase = null
    }

    // --------------------------------------------------------------- internals

    private fun createOffer(connection: PeerConnection) {
        val constraints = MediaConstraints()
        connection.createOffer(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription) {
                connection.setLocalDescription(
                    logSdpObserver("setLocal(offer)"),
                    desc,
                )
                events.onLocalSignal(
                    JSONObject()
                        .put("kind", "offer")
                        .put("sdp", desc.description)
                )
            }

            override fun onSetSuccess() = Unit
            override fun onCreateFailure(error: String?) =
                events.onFailure("Couldn't prepare the peer-to-peer offer (${error ?: "unknown"}).")
            override fun onSetFailure(error: String?) =
                events.onFailure("Couldn't prepare the peer-to-peer offer (${error ?: "unknown"}).")
        }, constraints)
    }

    private val pcObserver = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            events.onLocalSignal(
                JSONObject()
                    .put("kind", "candidate")
                    .put("sdpMid", candidate.sdpMid)
                    .put("sdpMLineIndex", candidate.sdpMLineIndex)
                    .put("candidate", candidate.sdp)
            )
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            events.onIceState(state)
        }

        // Unified Plan delivers inbound media here, one call per track.
        override fun onTrack(transceiver: RtpTransceiver) {
            val track = transceiver.receiver?.track()
            if (track is VideoTrack) events.onRemoteVideoTrack(track)
            // Audio auto-plays through the default AudioTrack sink; nothing to
            // wire up here. See the audio-routing TODO on the class.
        }

        // The PC may open its own data channel instead of using ours.
        override fun onDataChannel(channel: DataChannel) {
            if (dataChannel == null) {
                dataChannel = channel
                channel.registerObserver(dataChannelObserver(channel))
            }
        }

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
        override fun onSignalingChange(state: PeerConnection.SignalingState?) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) = Unit
        override fun onAddStream(stream: MediaStream?) = Unit
        override fun onRemoveStream(stream: MediaStream?) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) = Unit
    }

    private fun dataChannelObserver(channel: DataChannel) = object : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) = Unit
        override fun onStateChange() = Unit
        override fun onMessage(buffer: DataChannel.Buffer) {
            if (buffer.binary) return
            val bytes = ByteArray(buffer.data.remaining())
            buffer.data.get(bytes)
            events.onDataChannelMessage(String(bytes, StandardCharsets.UTF_8))
        }
    }

    /**
     * An [SdpObserver] for set-description calls. A rejected answer used to be
     * swallowed and the screen sat on "Connecting" forever; now it fails.
     */
    private fun logSdpObserver(tag: String) = object : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription?) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String?) =
            events.onFailure("Your PC's answer couldn't be used ($tag: ${error ?: "unknown"}).")
        override fun onSetFailure(error: String?) =
            events.onFailure("Your PC's answer couldn't be used ($tag: ${error ?: "unknown"}).")
    }

    companion object {
        /**
         * Turn the hub's `/api/v1/ice` JSON (`{"iceServers":[{"urls":[…],
         * "username":…,"credential":…}]}`) into libwebrtc [PeerConnection.IceServer]s.
         *
         * `urls` may be a single string or an array; username/credential are
         * present only for TURN entries. Kept pure and static so it is unit-testable
         * without a device.
         */
        fun parseIceServers(iceJson: JSONObject): List<PeerConnection.IceServer> {
            val out = ArrayList<PeerConnection.IceServer>()
            val servers = iceJson.optJSONArray("iceServers") ?: return out
            for (i in 0 until servers.length()) {
                val entry = servers.optJSONObject(i) ?: continue
                val urls = readUrls(entry) ?: continue
                val builder = PeerConnection.IceServer.builder(urls)
                entry.optString("username").takeIf { it.isNotBlank() }
                    ?.let { builder.setUsername(it) }
                entry.optString("credential").takeIf { it.isNotBlank() }
                    ?.let { builder.setPassword(it) }
                out.add(builder.createIceServer())
            }
            return out
        }

        private fun readUrls(entry: JSONObject): List<String>? {
            when (val raw = entry.opt("urls")) {
                is String -> return listOf(raw)
                is JSONArray -> {
                    val list = ArrayList<String>(raw.length())
                    for (j in 0 until raw.length()) {
                        raw.optString(j).takeIf { it.isNotBlank() }?.let { list.add(it) }
                    }
                    return list.takeIf { it.isNotEmpty() }
                }
                else -> return null
            }
        }
    }
}
