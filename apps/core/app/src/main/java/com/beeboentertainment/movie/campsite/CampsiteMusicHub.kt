package com.beeboentertainment.movie.campsite

import android.util.Log
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The live side of Campsite synced music: one WebSocket per guest browser, all fed by one
 * [CampsiteMusicEngine].
 *
 * What travels:
 *  - server to guest: `hello`, `state` (the engine snapshot, for a change or a late joiner) and
 *    `pong` (a clock-sync reply stamped with the host clock on receipt and on send);
 *  - guest to server: `ping` (clock sync) and `status` (what this phone is doing, for the host
 *    screen and the "everyone ready" start gate).
 * Nothing a guest sends can change what plays or who plays what. Every message is size-limited
 * (see [CampsiteWebSocket.MAX_INCOMING_BYTES]), rate-limited by a token bucket, and validated
 * field by field; a guest that misbehaves is disconnected, not argued with.
 *
 * Identity is the guest's join cookie, checked by [CampsiteServer] before it hands the socket
 * over. The hub only ever sees a short hash of it ([guestIdFor]) and never sends the token
 * anywhere.
 */
internal class CampsiteMusicHub(
    private val trackFile: (String) -> File?,
    private val script: () -> String = { "" },
    private val touchGuest: (String) -> Unit = {},
    private val clockMs: () -> Double = MonotonicClock(),
    autoTick: Boolean = true,
) {
    val engine = CampsiteMusicEngine(clockMs)

    /** Monotonic host clock in fractional milliseconds since this hub was created. */
    class MonotonicClock : () -> Double {
        private val origin = System.nanoTime()
        override fun invoke(): Double = (System.nanoTime() - origin) / 1_000_000.0
    }

    /** What the host screen shows about one connected guest phone. */
    data class GuestView(
        val id: String,
        val name: String,
        val role: MusicRole,
        val unlocked: Boolean,
        val ready: Boolean,
        val state: String,
        val errorMs: Double,
        val driftMs: Double,
        val rttMs: Double,
    ) {
        /** Green: estimated within 30 ms while playing. */
        val inSync: Boolean get() = unlocked && errorMs + kotlin.math.abs(driftMs) <= SYNC_GOOD_MS
    }

    private sealed class Outgoing {
        class Text(val build: () -> String) : Outgoing()
        object Snapshot : Outgoing()
        object Ping : Outgoing()
        class Pong(val payload: ByteArray) : Outgoing()
        class Close(val code: Int) : Outgoing()
    }

    private inner class Conn(val guestId: String, val name: String, val socket: Socket) {
        val outbox = LinkedBlockingQueue<Outgoing>(OUTBOX_LIMIT)
        val closed = AtomicBoolean(false)
        val snapshotPending = AtomicBoolean(false)
        // Token bucket for inbound messages.
        private var tokens = BUCKET_CAPACITY
        private var refilledAt = System.nanoTime()
        var badMessages = 0

        @Volatile var unlocked = false
        @Volatile var readyTrack: String? = null
        @Volatile var state = "connecting"
        @Volatile var errorMs = Double.POSITIVE_INFINITY
        @Volatile var driftMs = 0.0
        @Volatile var rttMs = 0.0

        fun takeToken(): Boolean {
            val now = System.nanoTime()
            tokens = minOf(BUCKET_CAPACITY, tokens + (now - refilledAt) / 1e9 * BUCKET_REFILL_PER_S)
            refilledAt = now
            if (tokens < 1.0) return false
            tokens -= 1.0
            return true
        }

        /** Never blocks: a phone that cannot keep up is dropped rather than allowed to stall the rest. */
        fun send(item: Outgoing) {
            if (closed.get()) return
            if (!outbox.offer(item)) close(CampsiteWebSocket.CLOSE_POLICY)
        }

        fun sendSnapshot() {
            if (snapshotPending.compareAndSet(false, true)) send(Outgoing.Snapshot)
        }

        fun close(code: Int) {
            if (!closed.compareAndSet(false, true)) return
            outbox.clear()
            outbox.offer(Outgoing.Close(code))
        }
    }

    private val conns = ConcurrentHashMap<String, Conn>()
    private val io = Executors.newCachedThreadPool { r -> Thread(r, "campsite-music-io").also { it.isDaemon = true } }
    private var ticker: ScheduledExecutorService? = null
    private val broadcastLock = Any()
    private var lastBroadcastRev = -1
    @Volatile private var shutDown = false
    private val autoTickEnabled = autoTick

    // ---- serving pages and files -------------------------------------------------------------

    /** The guest-side script, inlined into the Music page by [CampsiteMusicPage]. */
    fun scriptText(): String = script()

    /** A queued track's file for a guest download, or null. Guests can only ever fetch what is in the queue. */
    fun fileForGuest(trackId: String): File? =
        if (trackId.matches(CampsiteMusicEngine.ID_PATTERN) && engine.isQueued(trackId)) trackFile(trackId) else null

    fun guestIdFor(token: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
        return digest.take(6).joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
    }

    // ---- host commands (always followed by an immediate broadcast) ---------------------------

    fun load(tracks: List<MusicTrackInfo>, startIndex: Int = 0) { engine.load(tracks, startIndex); afterCommand() }
    fun play() { engine.play(); afterCommand() }
    fun pause() { engine.pause(); afterCommand() }
    fun seek(positionMs: Long) { engine.seek(positionMs); afterCommand() }
    fun next() { engine.next(); afterCommand() }
    fun previous() { engine.previous(); afterCommand() }
    fun jump(index: Int) { engine.jump(index); afterCommand() }
    fun stopMusic() { engine.stop(); afterCommand() }
    fun setRole(guestId: String, role: MusicRole) { engine.setRole(guestId, role); afterCommand() }

    private fun afterCommand() { ensureTicker(); broadcastIfChanged() }

    fun guests(): List<GuestView> {
        val current = engine.currentTrackId()
        return conns.values.filter { !it.closed.get() }.sortedBy { it.name.lowercase() }.map {
            GuestView(it.guestId, it.name, engine.roleOf(it.guestId), it.unlocked,
                current != null && it.readyTrack == current, it.state, it.errorMs, it.driftMs, it.rttMs)
        }
    }

    // ---- connections -------------------------------------------------------------------------

    /**
     * Runs one guest's socket to completion on the calling thread (a worker of [CampsiteServer]).
     * The handshake reply is written here; the caller has already checked cookie, origin and the
     * upgrade headers.
     */
    fun serve(socket: Socket, input: InputStream, out: OutputStream, clientKey: String, guestToken: String, guestName: String, cookieName: String) {
        if (shutDown || conns.size >= MAX_CONNECTIONS) {
            out.write("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray()); out.flush()
            return
        }
        out.write(CampsiteWebSocket.handshakeResponse(clientKey)); out.flush()
        val guestId = guestIdFor(guestToken)
        val conn = Conn(guestId, guestName.filter { !it.isISOControl() }.trim().take(24).ifBlank { "Guest" }, socket)
        // One live socket per guest: a second tab or a reconnect replaces the first.
        conns.put(guestId, conn)?.close(CampsiteWebSocket.CLOSE_NORMAL)
        socket.soTimeout = READ_TIMEOUT_MS
        val writer = io.submit { writeLoop(conn, out) }
        try {
            conn.send(Outgoing.Text { helloJson(conn) })
            conn.sendSnapshot()
            ensureTicker()
            readLoop(conn, input, cookieName)
        } finally {
            conn.close(CampsiteWebSocket.CLOSE_NORMAL)
            runCatching { writer.get(2, TimeUnit.SECONDS) }
            conns.remove(guestId, conn)
            drain(socket, input)
            runCatching { socket.close() }
        }
    }

    /**
     * After we sent a close frame, keep reading for a moment. Closing a socket that still has unread
     * data makes TCP send a reset, and a reset can make the browser throw away the close frame it
     * has already received - so it would report a dropped connection instead of our reason.
     */
    private fun drain(socket: Socket, input: InputStream) {
        runCatching {
            socket.soTimeout = 300
            val buffer = ByteArray(1024)
            val until = System.currentTimeMillis() + 1_500
            var total = 0
            while (System.currentTimeMillis() < until && total < 256 * 1024) {
                val n = input.read(buffer)
                if (n < 0) break
                total += n
            }
        }
    }

    private fun helloJson(c: Conn): String =
        "{\"t\":\"hello\",\"v\":${CampsiteMusicEngine.PROTOCOL_VERSION},\"guest\":\"${c.guestId}\",\"serverNow\":${wireMs(clockMs())}}"

    private fun readLoop(conn: Conn, input: InputStream, cookieName: String) {
        val reader = CampsiteWebSocket.Reader(input)
        var lastRx = System.nanoTime()
        while (!conn.closed.get() && !shutDown) {
            val item = try {
                reader.next()
            } catch (e: CampsiteWebSocket.ProtocolException) {
                Log.d(TAG, "guest ${conn.guestId}: ${e.message}")
                conn.close(e.closeCode); return
            } catch (e: IOException) {
                return
            }
            val received = clockMs()
            when (item) {
                null -> return
                CampsiteWebSocket.Idle -> {
                    if ((System.nanoTime() - lastRx) / 1_000_000L > IDLE_LIMIT_MS) { conn.close(CampsiteWebSocket.CLOSE_GOING_AWAY); return }
                    conn.send(Outgoing.Ping)
                }
                is CampsiteWebSocket.Message -> {
                    lastRx = System.nanoTime()
                    touchGuest(cookieName)
                    if (!conn.takeToken()) { conn.close(CampsiteWebSocket.CLOSE_POLICY); return }
                    when (item.opcode) {
                        CampsiteWebSocket.OP_PING -> conn.send(Outgoing.Pong(item.payload))
                        CampsiteWebSocket.OP_PONG -> Unit
                        CampsiteWebSocket.OP_CLOSE -> { conn.close(CampsiteWebSocket.CLOSE_NORMAL); return }
                        CampsiteWebSocket.OP_TEXT -> if (!handleText(conn, item.text, received)) { conn.close(CampsiteWebSocket.CLOSE_POLICY); return }
                        else -> { conn.close(CampsiteWebSocket.CLOSE_UNSUPPORTED); return }
                    }
                }
            }
        }
    }

    /** False when the guest has sent too much nonsense and should be disconnected. */
    private fun handleText(conn: Conn, text: String, receivedMs: Double): Boolean {
        val obj = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull()
        val type = (obj?.get("t") as? JsonPrimitive)?.takeIf { it.isString }?.content
        when (type) {
            "ping" -> {
                val id = obj.num("id")?.takeIf { it in 0.0..1e9 }?.toLong()
                val c = obj.num("c")
                if (id == null || c == null) return bad(conn)
                // The send stamp is taken by the writer thread the instant before the bytes go out.
                conn.send(Outgoing.Text {
                    "{\"t\":\"pong\",\"id\":$id,\"c\":${wireMs(c)},\"r\":${wireMs(receivedMs)},\"s\":${wireMs(clockMs())}}"
                })
            }
            "status" -> {
                val state = (obj?.get("state") as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (state !in STATES) return bad(conn)
                conn.state = state!!
                conn.unlocked = (obj?.get("unlocked") as? JsonPrimitive)?.booleanOrNull ?: false
                conn.readyTrack = (obj?.get("ready") as? JsonPrimitive)?.takeIf { it.isString }?.content
                    ?.takeIf { it.matches(CampsiteMusicEngine.ID_PATTERN) }
                conn.errorMs = obj.num("errMs")?.takeIf { it in 0.0..10_000.0 } ?: Double.POSITIVE_INFINITY
                conn.driftMs = obj.num("driftMs")?.coerceIn(-10_000.0, 10_000.0) ?: 0.0
                conn.rttMs = obj.num("rttMs")?.coerceIn(0.0, 60_000.0) ?: 0.0
            }
            "hello" -> Unit
            else -> return bad(conn)
        }
        return true
    }

    private fun JsonObject?.num(key: String): Double? =
        (this?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

    private fun bad(conn: Conn): Boolean = ++conn.badMessages <= MAX_BAD_MESSAGES

    private fun writeLoop(conn: Conn, out: OutputStream) {
        try {
            while (true) {
                val item = conn.outbox.poll(1, TimeUnit.SECONDS)
                if (item == null) { if (shutDown) return; if (conn.closed.get() && conn.outbox.isEmpty()) return; continue }
                when (item) {
                    is Outgoing.Text -> CampsiteWebSocket.writeFrame(out, CampsiteWebSocket.OP_TEXT, item.build().toByteArray(Charsets.UTF_8))
                    Outgoing.Snapshot -> {
                        conn.snapshotPending.set(false)
                        CampsiteWebSocket.writeFrame(out, CampsiteWebSocket.OP_TEXT, engine.snapshot(conn.guestId).toString().toByteArray(Charsets.UTF_8))
                    }
                    Outgoing.Ping -> CampsiteWebSocket.writeFrame(out, CampsiteWebSocket.OP_PING, ByteArray(0))
                    is Outgoing.Pong -> CampsiteWebSocket.writeFrame(out, CampsiteWebSocket.OP_PONG, item.payload)
                    is Outgoing.Close -> {
                        CampsiteWebSocket.writeFrame(out, CampsiteWebSocket.OP_CLOSE, CampsiteWebSocket.closePayload(item.code))
                        // Half-close so the browser sees the close frame before the TCP reset.
                        runCatching { conn.socket.shutdownOutput() }
                        return
                    }
                }
            }
        } catch (e: IOException) {
            conn.closed.set(true)
            runCatching { conn.socket.close() }
        }
    }

    // ---- broadcasting and the tick -----------------------------------------------------------

    private fun broadcastIfChanged() {
        synchronized(broadcastLock) {
            val rev = engine.revision
            if (rev == lastBroadcastRev) return
            lastBroadcastRev = rev
            conns.values.forEach { it.sendSnapshot() }
        }
    }

    /** Everybody who can make sound has the current track decoded (or nobody can, so waiting is pointless). */
    private fun everyoneReady(): Boolean {
        val current = engine.currentTrackId() ?: return true
        val listeners = conns.values.filter { !it.closed.get() && it.unlocked }
        return listeners.all { it.readyTrack == current }
    }

    /** One step of the clock; public so tests can drive it deterministically. */
    fun tick() {
        engine.tick(everyoneReady())
        broadcastIfChanged()
    }

    private fun ensureTicker() {
        if (!autoTickEnabled || shutDown) return
        synchronized(this) {
            if (ticker != null) return
            ticker = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "campsite-music-tick").also { it.isDaemon = true } }.also {
                it.scheduleWithFixedDelay({ runCatching { tick() } }, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS)
            }
        }
    }

    fun connectionCount(): Int = conns.size

    fun shutdown() {
        shutDown = true
        conns.values.forEach { c -> c.close(CampsiteWebSocket.CLOSE_GOING_AWAY); runCatching { c.socket.close() } }
        conns.clear()
        synchronized(this) { ticker?.shutdownNow(); ticker = null }
        io.shutdownNow()
    }

    companion object {
        private const val TAG = "CampsiteMusic"
        const val MAX_CONNECTIONS = 32
        const val SYNC_GOOD_MS = 30.0
        private const val OUTBOX_LIMIT = 64
        private const val BUCKET_CAPACITY = 100.0
        private const val BUCKET_REFILL_PER_S = 50.0
        private const val READ_TIMEOUT_MS = 15_000
        private const val IDLE_LIMIT_MS = 45_000L
        private const val TICK_MS = 250L
        private const val MAX_BAD_MESSAGES = 10
        private val STATES = setOf("locked", "syncing", "loading", "ready", "playing", "paused", "idle", "error")
    }
}
