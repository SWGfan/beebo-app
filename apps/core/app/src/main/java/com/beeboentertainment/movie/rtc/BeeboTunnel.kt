package com.beeboentertainment.movie.rtc

import android.content.Context
import android.util.Log
import org.json.JSONObject
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.io.IOException
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A peer-to-peer data channel to the home PC: one attempt, one [TunnelLink].
 *
 * This is what makes away-from-home work for people whose router will not open a
 * port - which, as of testing, includes every Rogers gateway, because it exposes
 * no UPnP service capable of creating a mapping at all. It is not a fallback for
 * an edge case; for a large share of customers it is the only way in.
 *
 * The PC half is the host agent (desktop/apps/desktop/resources/beebo-rtc-host). It polls the
 * Worker for offers, answers, and bridges a data channel labelled "http" to the home server.
 * This class does exactly what the browser viewer page does in `connect()`:
 *  1. creates the PeerConnection and the "http" channel (we create it; the PC waits for it),
 *  2. offers through the Worker, sending ICE candidates as they appear (ones found before the
 *     Worker has given us a viewer id are kept, not dropped),
 *  3. polls for the answer and the PC's candidates, holding candidates until the answer is
 *     applied (adding one earlier is rejected and the candidate is lost),
 *  4. gives up on no answer after [ANSWER_WAIT_MS], and on no open channel after
 *     [DIRECT_WAIT_MS], with the reason the viewer page would show.
 * Then, once open, it says hello (protocol 2) and learns what the PC's agent can do.
 *
 * Wire format: [TunnelProtocol]. HTTP over it, reconnects and resuming: [TunnelClient].
 *
 * Nothing here runs on the main thread. Network calls never run on WebRTC's own callback
 * thread either (that would stall the connection): they go to [io].
 */
class BeeboTunnel private constructor(
    private val signaller: BeeboSignaller,
    private val token: String,
    private val iceServers: List<PeerConnection.IceServer>,
    private val listener: TunnelLinkListener,
    private val name: String,
    private val beeboRelayHosts: Set<String>,
) : TunnelLink {

    companion object {
        private const val TAG = "BeeboTunnel"
        // The house polls its mailbox every 8 seconds when idle, and a busy or sleepy
        // computer can take a few seconds more to answer. 20 s was close enough to that
        // to fail on a real house (2026-09-17); 35 s costs nothing when it works.
        const val ANSWER_WAIT_MS = 35_000L
        const val DIRECT_WAIT_MS = ReconnectBackoff.HONEST_FAILURE_MS
        private const val HELLO_WAIT_MS = 2_500L
        private const val STATS_WAIT_MS = 1_500L
        private const val POLL_MS = 700L
        private const val MAX_BUFFERED = 1L shl 20
        /** After ICE reports "disconnected", how long it may take to come back by itself. */
        private const val DISCONNECT_GRACE_MS = 6_000L

        private val initialized = AtomicBoolean(false)
        @Volatile private var sharedFactory: PeerConnectionFactory? = null

        /** One factory for the process: no audio or video devices, only data channels. */
        @Synchronized
        private fun factory(context: Context): PeerConnectionFactory {
            if (initialized.compareAndSet(false, true)) {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                        .createInitializationOptions()
                )
            }
            return sharedFactory ?: PeerConnectionFactory.builder().createPeerConnectionFactory().also { sharedFactory = it }
        }

        /**
         * Open a tunnel, blocking up to ~25 s. Returns the open link, or throws
         * [TunnelConnectException] with the reason in plain words. [Offered.relayServers] is filled
         * in if the PC's answer offered a relay, even when this attempt failed, so the caller can
         * try once more through it.
         */
        fun open(
            context: Context,
            signaller: BeeboSignaller,
            token: String,
            iceServers: List<PeerConnection.IceServer>,
            listener: TunnelLinkListener,
            name: String,
            offered: Offered,
            /** Hosts of the Beebo Relay servers in [iceServers], to say "Through Beebo Relay". */
            beeboRelayHosts: Set<String> = emptySet(),
        ): BeeboTunnel {
            val t = BeeboTunnel(signaller, token, iceServers, listener, name, beeboRelayHosts)
            try {
                t.connect(factory(context), offered)
                return t
            } catch (e: Exception) {
                t.close()
                throw e
            }
        }

        /** Plain ICE server values ([BeeboRelay]) as WebRTC's own. */
        fun iceServers(specs: List<IceSpec>): List<PeerConnection.IceServer> = specs.map { s ->
            val b = PeerConnection.IceServer.builder(s.urls)
            s.username?.let { b.setUsername(it) }
            s.credential?.let { b.setPassword(it) }
            b.createIceServer()
        }
    }

    /** What the PC's answer carried besides the SDP. */
    class Offered { @Volatile var relayServers: List<PeerConnection.IceServer> = emptyList() }

    private val io = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "beebo-rtc-io").apply { isDaemon = true } }

    private var connection: PeerConnection? = null
    private var channel: DataChannel? = null
    @Volatile private var viewerId: String? = null
    private val earlyCandidates = mutableListOf<IceCandidate>()
    private val remoteReady = AtomicBoolean(false)
    private val pendingRemote = mutableListOf<IceCandidate>()
    private var pollTask: ScheduledFuture<*>? = null
    private var pathCheckTask: ScheduledFuture<*>? = null
    private val pathRevision = java.util.concurrent.atomic.AtomicInteger(0)
    @Volatile private var candidatePath: TunnelPath = TunnelPath.UNKNOWN
    @Volatile private var beeboAddresses: Set<String> = emptySet()
    private var disconnectTask: ScheduledFuture<*>? = null

    private val answered = CountDownLatch(1)
    private val opened = CountDownLatch(1)
    private val helloLatch = CountDownLatch(1)
    @Volatile private var failure: TunnelConnectException? = null
    private val open = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)
    private val reportedClosed = AtomicBoolean(false)

    @Volatile override var features: TunnelProtocol.HostFeatures = TunnelProtocol.HostFeatures.LEGACY
        private set
    @Volatile override var relayed: Boolean = false
        private set
    @Volatile override var path: TunnelPath = TunnelPath.UNKNOWN
        private set

    override val isOpen: Boolean get() = open.get() && !closed.get()

    // ------------------------------------------------------------------ connect

    private fun connect(factory: PeerConnectionFactory, offered: Offered) {
        // Resolve only the relay hosts supplied by the authenticated account service, off the UI thread.
        beeboAddresses = beeboRelayHosts.flatMap { host ->
            runCatching { java.net.InetAddress.getAllByName(host).mapNotNull { it.hostAddress } }.getOrDefault(emptyList())
        }.toSet()
        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            iceTransportsType = PeerConnection.IceTransportsType.ALL
        }
        val pc = factory.createPeerConnection(config, observer)
            ?: throw TunnelConnectException("Couldn't start a connection on this phone.", code = "pc_failed")
        connection = pc
        val dc = pc.createDataChannel(TunnelProtocol.CHANNEL_LABEL, DataChannel.Init().apply { ordered = true })
            ?: throw TunnelConnectException("Couldn't open a data channel on this phone.", code = "dc_failed")
        channel = dc
        dc.registerObserver(channelObserver(dc))

        val offerSdp = createOffer(pc)
        try {
            val id = signaller.offer(token, offerSdp)
            val early = synchronized(earlyCandidates) { viewerId = id; earlyCandidates.toList().also { earlyCandidates.clear() } }
            runIo { early.forEach { c -> runCatching { signaller.sendCandidate(token, id, c) } } }
            pollTask = io.scheduleWithFixedDelay({ poll(id, offered) }, 0, POLL_MS, TimeUnit.MILLISECONDS)
        } catch (e: BeeboSignaller.SignalException) {
            throw when {
                e.code == "host_offline" -> TunnelConnectException(RemoteMessages.hostOffline(name), code = "host_offline")
                e.status == 401 -> TunnelConnectException(RemoteMessages.SIGNED_OUT, code = "token_expired")
                else -> TunnelConnectException("Couldn't set up the connection (${e.code}).", code = e.code)
            }
        } catch (e: IOException) {
            throw TunnelConnectException(RemoteMessages.UNREACHABLE, code = "unreachable")
        }

        if (!answered.await(ANSWER_WAIT_MS, TimeUnit.MILLISECONDS)) {
            failure?.let { throw it }
            throw TunnelConnectException(RemoteMessages.noAnswer(name), code = "no_answer")
        }
        if (!opened.await(DIRECT_WAIT_MS, TimeUnit.MILLISECONDS) || !open.get()) {
            failure?.let { throw it }
            throw TunnelConnectException(RemoteMessages.noDirectPath(name), code = "no_direct_path")
        }
        pollTask?.cancel(false)

        // Protocol 2? An older agent never answers, and gets version 1 requests.
        runCatching { sendText(TunnelProtocol.hello()) }
        helloLatch.await(HELLO_WAIT_MS, TimeUnit.MILLISECONDS)
        checkPath(pc)
        Log.i(TAG, "tunnel open to $name.beebo.tv: proto ${features.proto}, relayed=$relayed, path=$path")
    }

    /**
     * Direct, through Beebo Relay, or through another relay: the selected candidate pair's types,
     * from getStats once connected. Waits at most [STATS_WAIT_MS]; unknown if it can't tell.
     */
    private fun checkPath(pc: PeerConnection) {
        val revision = pathRevision.get()
        val done = CountDownLatch(1)
        var found = TunnelPath.UNKNOWN
        runCatching {
            pc.getStats { report ->
                runCatching {
                    val stats = report.statsMap.values.map { s -> TunnelPathRule.Stat(s.id, s.type, s.members) }
                    found = TunnelPathRule.fromStats(stats, beeboRelayHosts, iceServers.flatMap { it.urls })
                }
                done.countDown()
            }
        }.onFailure { done.countDown() }
        done.await(STATS_WAIT_MS, TimeUnit.MILLISECONDS)
        if (closed.get() || pathRevision.get() != revision) return
        // A fresh selected-pair event outranks stats still describing the previous route.
        val selected = candidatePath
        val result = when {
            selected.isRelay && !found.isRelay -> selected
            selected == TunnelPath.DIRECT && found.isRelay -> selected
            selected == TunnelPath.BEEBO_RELAY && found == TunnelPath.RELAY -> selected
            found != TunnelPath.UNKNOWN -> found
            else -> selected
        }
        publishPath(result)
    }

    private fun publishPath(next: TunnelPath) {
        if (closed.get()) return
        if (path == next) return
        path = next
        relayed = next.isRelay
        runCatching { listener.onPathChanged(this) }
    }

    private fun createOffer(pc: PeerConnection): String {
        val done = CountDownLatch(1)
        var sdp: SessionDescription? = null
        var error: String? = null
        pc.createOffer(object : SdpAdapter() {
            override fun onCreateSuccess(desc: SessionDescription) {
                pc.setLocalDescription(object : SdpAdapter() {
                    override fun onSetSuccess() { sdp = desc; done.countDown() }
                    override fun onSetFailure(p0: String?) { error = p0; done.countDown() }
                }, desc)
            }
            override fun onCreateFailure(p0: String?) { error = p0; done.countDown() }
        }, MediaConstraints())
        if (!done.await(10, TimeUnit.SECONDS) || sdp == null) {
            throw TunnelConnectException("Couldn't prepare a connection on this phone (${error ?: "timeout"}).", code = "offer_failed")
        }
        return sdp!!.description
    }

    /** The Worker has no push channel, so the answer and the PC's candidates are polled for. */
    private fun poll(id: String, offered: Offered) {
        if (closed.get() || open.get()) return
        val msgs = try { signaller.poll(id) } catch (_: Exception) { return }   // a blip; next tick
        for (m in msgs) {
            when (m.optString("type")) {
                "answer" -> {
                    BeeboSignaller.parseRelayServers(m.optJSONArray("iceServers")).takeIf { it.isNotEmpty() }
                        ?.let { offered.relayServers = it }
                    answered.countDown()
                    connection?.setRemoteDescription(object : SdpAdapter() {
                        override fun onSetSuccess() {
                            remoteReady.set(true)
                            val queued = synchronized(pendingRemote) { pendingRemote.toList().also { pendingRemote.clear() } }
                            queued.forEach { connection?.addIceCandidate(it) }
                        }
                        override fun onSetFailure(p0: String?) {
                            fail(TunnelConnectException("Your home computer's answer couldn't be used ($p0).", code = "bad_answer"))
                        }
                    }, SessionDescription(SessionDescription.Type.ANSWER, m.optString("sdp")))
                }
                "candidate" -> {
                    val c = m.opt("candidate")
                    val cand = when (c) {
                        is JSONObject -> IceCandidate(c.optString("sdpMid", "0"), c.optInt("sdpMLineIndex", 0), c.optString("candidate"))
                        is String -> IceCandidate("0", 0, c)
                        else -> null
                    } ?: continue
                    if (cand.sdp.isNullOrBlank()) continue
                    if (remoteReady.get()) connection?.addIceCandidate(cand)
                    else synchronized(pendingRemote) { pendingRemote.add(cand) }
                }
            }
        }
    }

    private fun fail(e: TunnelConnectException) {
        if (failure == null) failure = e
        answered.countDown()
        opened.countDown()
    }

    // ---------------------------------------------------------------- observers

    private val observer = object : PeerConnection.Observer {
        override fun onIceCandidate(c: IceCandidate) {
            val id = synchronized(earlyCandidates) { viewerId ?: run { earlyCandidates.add(c); null } } ?: return
            runIo { runCatching { signaller.sendCandidate(token, id, c) } }
        }

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            when (state) {
                PeerConnection.PeerConnectionState.CONNECTED -> { disconnectTask?.cancel(false); disconnectTask = null }
                PeerConnection.PeerConnectionState.FAILED -> {
                    fail(TunnelConnectException(RemoteMessages.noDirectPath(name), code = "ice_failed"))
                    lost()
                }
                PeerConnection.PeerConnectionState.DISCONNECTED -> if (open.get() && disconnectTask == null) {
                    // Often back within a second or two (a brief radio fade); give it a moment.
                    disconnectTask = runCatching { io.schedule({ lost() }, DISCONNECT_GRACE_MS, TimeUnit.MILLISECONDS) }.getOrNull()
                }
                PeerConnection.PeerConnectionState.CLOSED -> lost()
                else -> {}
            }
        }

        override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) {
            pathRevision.incrementAndGet()
            candidatePath = TunnelPathRule.fromCandidates(event.local?.sdp, event.remote?.sdp, beeboAddresses)
            publishPath(candidatePath)
            // Debounce ICE changes; no per-frame polling and no network work on WebRTC's callback.
            pathCheckTask?.cancel(false)
            pathCheckTask = runCatching { io.schedule({ connection?.let { checkPath(it) } }, 750, TimeUnit.MILLISECONDS) }.getOrNull()
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
        override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
        override fun onIceConnectionReceivingChange(p0: Boolean) {}
        override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
        override fun onAddStream(p0: MediaStream?) {}
        override fun onRemoveStream(p0: MediaStream?) {}
        override fun onDataChannel(p0: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
    }

    private fun channelObserver(dc: DataChannel) = object : DataChannel.Observer {
        override fun onStateChange() {
            when (dc.state()) {
                DataChannel.State.OPEN -> { open.set(true); opened.countDown() }
                DataChannel.State.CLOSING, DataChannel.State.CLOSED -> lost()
                else -> {}
            }
        }

        override fun onMessage(buffer: DataChannel.Buffer) {
            try {
                val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                if (buffer.binary) {
                    listener.onBinary(this@BeeboTunnel, bytes)
                } else {
                    val text = String(bytes, Charsets.UTF_8)
                    val m = TunnelProtocol.parseText(text)
                    if (m is TunnelProtocol.Incoming.Hello) { features = m.features; helloLatch.countDown() }
                    else listener.onText(this@BeeboTunnel, text)
                }
            } catch (e: Exception) {
                // A malformed frame must never take the tunnel down.
                Log.w(TAG, "bad frame", e)
            }
        }

        override fun onBufferedAmountChange(p0: Long) {}
    }

    // ------------------------------------------------------------------ sending

    private fun sendText(text: String) = send(TunnelProtocol.Frame.Text(text))

    override fun send(frame: TunnelProtocol.Frame) {
        val dc = channel ?: throw IOException("The connection to your home computer closed.")
        // The PC pauses above 1 MB buffered; do the same so an upload can't stall a film.
        var waited = 0
        while (isOpen && dc.bufferedAmount() > MAX_BUFFERED && waited < 30_000) {
            try { Thread.sleep(10) } catch (e: InterruptedException) { Thread.currentThread().interrupt(); throw IOException("Interrupted") }
            waited += 10
        }
        if (!isOpen) throw IOException("The connection to your home computer closed.")
        val ok = when (frame) {
            is TunnelProtocol.Frame.Text -> dc.send(DataChannel.Buffer(ByteBuffer.wrap(frame.text.toByteArray(Charsets.UTF_8)), false))
            is TunnelProtocol.Frame.Binary -> dc.send(DataChannel.Buffer(ByteBuffer.wrap(frame.bytes), true))
        }
        if (!ok) throw IOException("The connection to your home computer closed.")
    }

    // -------------------------------------------------------------------- close

    /** The link went away on its own: tell the client once, then clean up. */
    private fun lost() {
        val wasOpen = open.getAndSet(false)
        opened.countDown()
        if (wasOpen && reportedClosed.compareAndSet(false, true)) {
            runIo { runCatching { listener.onClosed(this) } }
        }
        close()
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val wasOpen = open.getAndSet(false)
        pollTask?.cancel(false)
        disconnectTask?.cancel(false)
        pathCheckTask?.cancel(false)
        // Never tear WebRTC down from its own callback thread: do it on ours.
        runIo {
            if (wasOpen && reportedClosed.compareAndSet(false, true)) runCatching { listener.onClosed(this) }
            runCatching { channel?.unregisterObserver() }
            runCatching { channel?.close() }
            runCatching { connection?.close() }
            runCatching { channel?.dispose() }
            runCatching { connection?.dispose() }
            channel = null
            connection = null
        }
        io.shutdown()
    }

    /** Work for our own thread; quietly dropped once the tunnel is closed. */
    private fun runIo(block: () -> Unit) {
        try { io.execute(block) } catch (_: java.util.concurrent.RejectedExecutionException) {}
    }

    /** SdpObserver with nothing to do by default. */
    private open class SdpAdapter : SdpObserver {
        override fun onCreateSuccess(p0: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(p0: String?) {}
        override fun onSetFailure(p0: String?) {}
    }
}
