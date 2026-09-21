package com.beeboentertainment.movie.player

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.util.Log
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.rtc.CastRule
import com.beeboentertainment.movie.rtc.RemoteAccess
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.Request
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * "Cast while you're away from home": this phone stands in the middle.
 *
 * The phone already has a working private tunnel to the home computer. A Chromecast does not and
 * cannot - hand it a name.beebo.tv link and it spins forever. So while a cast is running away
 * from home, this object puts a very small web server on the phone's own Wi-Fi address, gives the
 * TV a link to THAT, and answers each of the TV's requests by pulling the same bytes down the
 * tunnel and passing them on unchanged. Nothing extra goes through Beebo's servers: the home leg
 * is the tunnel the phone was already using to play the film itself.
 *
 * What keeps it safe:
 *  - it listens on the Wi-Fi address only, never on every interface, and on a port the system
 *    picks, so nothing is on a guessable port;
 *  - every URL carries a fresh 128-bit token, checked on every single request in constant time,
 *    and a new film means a new token, which makes the old one dead;
 *  - there is exactly one kind of route, `/c/<token>/<slot>`, where a slot is one of the
 *    handful of URLs the app itself registered for the film being cast. No listing, no root
 *    page, no way to ask for anything else, and at most [PhoneCastRules.MAX_SLOTS] of them;
 *  - it only ever runs while a cast is running away from home on Wi-Fi, and it is shut down when
 *    the cast stops, when playback is torn down, or when the network changes under it.
 *
 * What it costs: the phone has to stay awake and keep fetching, so it holds a CPU and a Wi-Fi
 * lock while it is serving (the screen may still sleep). That is why the app says so plainly the
 * first time - [CastRule.VIA_PHONE_NOTE].
 *
 * The decisions are all in [PhoneCastRules], which has no Android in it and is unit tested.
 */
object PhoneCastRelay {

    private const val TAG = "PhoneCastRelay"

    /** A long film plus extras; a normal cast releases it the moment the TV is finished with. */
    private const val WAKE_LOCK_MS = 6 * 60 * 60 * 1000L
    private const val SOCKET_TIMEOUT_MS = 20_000
    private const val WORKERS = 6
    private const val LAN_CACHE_MS = 5_000L

    private val lock = Any()
    private val random = SecureRandom()

    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private var workers: ExecutorService? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    @Volatile private var token: String? = null
    @Volatile private var host: String? = null
    @Volatile private var port: Int = 0
    /** slot number -> the home-computer URL it stands for. Only these are ever fetched. */
    private val slots = ConcurrentHashMap<Int, String>()
    /**
     * Connections a TV has open right now. A socket read cannot be interrupted, so stopping has
     * to close these by hand - otherwise a worker could go on pulling a film down the tunnel and
     * pushing it at a TV after the cast was supposed to be over.
     */
    private val openClients: MutableSet<Socket> =
        java.util.Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())
    private var nextSlot = 0
    /** The video URL this session is for. A different one means a different film: start again. */
    private var videoUpstream: String? = null

    @Volatile private var cachedLan: String? = null
    @Volatile private var cachedLanAt = 0L

    /**
     * Every stand-in address handed to a TV recently, and the real URL behind it. This is only
     * for putting things back afterwards - when the cast ends the phone must play the film from
     * the home computer again, not from an address on itself that has just been switched off.
     * Serving never looks here; it looks at [slots], which is emptied the moment a session ends.
     */
    private val handedOut = object : LinkedHashMap<String, String>(32, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > 64
    }

    private val _problem = MutableStateFlow<String?>(null)
    /** Something the viewer should be told (the tunnel dropped, the Wi-Fi changed). */
    val problem: StateFlow<String?> = _problem.asStateFlow()

    fun clearProblem() { _problem.value = null }

    /** Something the player should say out loud about casting away from home. */
    fun say(message: String) { _problem.value = message }

    val isRunning: Boolean get() = serverSocket != null

    // ------------------------------------------------------------------ can we?

    /**
     * Has this phone a Wi-Fi (or Ethernet) address a TV on the same network could reach?
     * Cached for a few seconds because the cast button asks on every redraw.
     */
    fun lanAddress(): String? {
        val now = System.currentTimeMillis()
        if (now - cachedLanAt < LAN_CACHE_MS) return cachedLan
        val found = localIpv4()
        cachedLan = found
        cachedLanAt = now
        return found
    }

    /** Enough for [CastRule.decide]: an address exists, so the little server could run. */
    fun canRelay(): Boolean = lanAddress() != null

    // ------------------------------------------------------------------ the URLs

    /**
     * Register one of the film's URLs and give back the address on this phone that stands in for
     * it, starting the server if this is the first one. Null means "can't cast this way" - not on
     * Wi-Fi, no address, or this session is already holding as many files as it will.
     *
     * Registering a new VIDEO url starts a fresh session: new token, nothing from the last film
     * still served.
     */
    fun localUrlFor(upstream: String): String? = synchronized(lock) {
        if (RemoteAccess.castDecision() !is CastRule.Decision.ViaPhone) return null
        if (!PhoneCastRules.canPassThrough(upstream)) {
            Log.i(TAG, "a converted stream can't be passed through this phone; the TV gets the file as it is")
            return null
        }
        val address = lanAddress() ?: return null
        if (serverSocket == null || host != address) {
            stopLocked(null)
            if (!startLocked(address)) return null
        }
        if (isVideo(upstream) && upstream != videoUpstream) {
            // A different film (or the same film at a different quality): everything the TV was
            // given before this moment stops working.
            newSessionLocked()
            videoUpstream = upstream
        }
        slots.entries.firstOrNull { it.value == upstream }?.let { existing ->
            return remember(PhoneCastRules.url(address, port, token ?: return null, existing.key), upstream)
        }
        if (slots.size >= PhoneCastRules.MAX_SLOTS) {
            Log.w(TAG, "refusing to relay more than ${PhoneCastRules.MAX_SLOTS} files for one film")
            return null
        }
        val slot = nextSlot++
        slots[slot] = upstream
        remember(PhoneCastRules.url(address, port, token ?: return null, slot), upstream)
    }

    private fun remember(local: String, upstream: String): String {
        synchronized(handedOut) { handedOut[local] = upstream }
        return local
    }

    /**
     * The home-computer URL a stand-in address on this phone was made for, or null if this is
     * not one of ours. Used when the TV hands the film back so the phone plays the real thing.
     */
    fun originalUrl(url: String): String? = synchronized(handedOut) { handedOut[url] }

    /** `/file` and `/tvfile` are the film itself; subtitles and posters hang off it. */
    private fun isVideo(url: String): Boolean {
        val path = runCatching { URI(url).rawPath }.getOrNull().orEmpty()
        return path.endsWith("/file") || path.endsWith("/tvfile")
    }

    // ------------------------------------------------------------------ lifecycle

    /** Stop serving. [reason], when given, is shown to the viewer. */
    fun stop(reason: String? = null) = synchronized(lock) { stopLocked(reason) }

    private fun newSessionLocked() {
        val bytes = ByteArray(PhoneCastRules.TOKEN_BYTES)
        random.nextBytes(bytes)
        token = PhoneCastRules.tokenFrom(bytes)
        slots.clear()
        nextSlot = 0
        videoUpstream = null
    }

    private fun startLocked(address: String): Boolean {
        val socket = try {
            ServerSocket().apply {
                reuseAddress = true
                bind(InetSocketAddress(InetAddress.getByName(address), 0), 8)
            }
        } catch (e: Exception) {
            Log.w(TAG, "couldn't listen on $address", e)
            return false
        }
        serverSocket = socket
        host = address
        port = socket.localPort
        newSessionLocked()
        val pool = Executors.newFixedThreadPool(WORKERS) { r ->
            Thread(r, "beebo-cast-relay").also { it.isDaemon = true }
        }
        workers = pool
        acceptThread = Thread({
            while (serverSocket === socket) {
                val client = try {
                    socket.accept()
                } catch (e: Exception) {
                    break
                }
                try {
                    pool.execute { serve(client) }
                } catch (e: Exception) {
                    runCatching { client.close() }
                }
            }
        }, "beebo-cast-accept").also { it.isDaemon = true; it.start() }
        acquireLocks()
        watchNetwork()
        Log.i(TAG, "passing the cast through this phone on $address:$port")
        return true
    }

    private fun stopLocked(reason: String?) {
        val socket = serverSocket ?: run {
            if (reason != null) _problem.value = reason
            return
        }
        serverSocket = null
        host = null
        port = 0
        token = null
        slots.clear()
        nextSlot = 0
        videoUpstream = null
        runCatching { socket.close() }
        for (client in openClients.toList()) runCatching { client.close() }
        openClients.clear()
        runCatching { workers?.shutdownNow() }
        workers = null
        acceptThread = null
        releaseLocks()
        unwatchNetwork()
        if (reason != null) _problem.value = reason
        Log.i(TAG, "stopped passing the cast through this phone")
    }

    // ------------------------------------------------------------------ staying awake

    private fun acquireLocks() {
        val ctx = context() ?: return
        runCatching {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "beebo:cast_relay")
                .apply { setReferenceCounted(false); acquire(WAKE_LOCK_MS) }
        }
        runCatching {
            val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "beebo:cast_relay")
                .apply { setReferenceCounted(false); acquire() }
        }
    }

    private fun releaseLocks() {
        runCatching { wakeLock?.let { if (it.isHeld) it.release() } }
        wakeLock = null
        runCatching { wifiLock?.let { if (it.isHeld) it.release() } }
        wifiLock = null
    }

    // ------------------------------------------------------------------ the network

    /**
     * The TV can only reach this phone at the address it was given. If the phone leaves that
     * Wi-Fi - or drops to mobile data, which would make the viewer pay for every byte twice -
     * the cast is stopped and said so, rather than left to stall.
     */
    private fun watchNetwork() {
        if (networkCallback != null) return
        val cm = context()?.getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(n: Network) = recheck(runCatching { cm.getNetworkCapabilities(n) }.getOrNull())
            override fun onLost(n: Network) = recheck(null)
            override fun onCapabilitiesChanged(n: Network, caps: NetworkCapabilities) = recheck(caps)
        }
        runCatching { cm.registerDefaultNetworkCallback(cb); networkCallback = cb }
    }

    private fun unwatchNetwork() {
        val cb = networkCallback ?: return
        networkCallback = null
        val cm = context()?.getSystemService(ConnectivityManager::class.java) ?: return
        runCatching { cm.unregisterNetworkCallback(cb) }
    }

    /**
     * [caps] is what the system just said about the network, read straight from the callback
     * rather than from RemoteAccess, which keeps its own copy and may not have caught up yet -
     * acting on a stale reading would end a cast that was perfectly fine.
     */
    private fun recheck(caps: NetworkCapabilities?) {
        val bound = host ?: return
        cachedLanAt = 0L
        // The address the TV was given has to still be on this phone, or nothing can reach it.
        val stillThere = runCatching { localAddresses().contains(bound) }.getOrDefault(false)
        // Dropping to mobile data would mean paying for every byte twice. Stop rather than let
        // that happen quietly. A lost network says nothing about the transport, so it is judged
        // on the address alone.
        val onLocal = caps == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        if (!stillThere || !onLocal) {
            stop("The Wi-Fi changed, so the TV can't reach this phone any more. Join the same Wi-Fi as the TV and cast again.")
        }
    }

    // ------------------------------------------------------------------ serving

    private fun serve(client: Socket) {
        openClients += client
        try {
            client.use { socket ->
                socket.tcpNoDelay = true
                socket.soTimeout = SOCKET_TIMEOUT_MS
                val input = socket.getInputStream()
                val out = BufferedOutputStream(socket.getOutputStream())
                val requestLine = readLine(input) ?: return
                val parts = requestLine.split(" ")
                if (parts.size < 2) { writeError(out, 404); return }
                val method = parts[0]
                val target = parts[1]
                val headers = readHeaders(input)
                when (val routed = PhoneCastRules.route(method, target, token, slots.keys.toSet())) {
                    is PhoneCastRules.Routed.Serve -> relay(method, routed.slot, headers, out)
                    is PhoneCastRules.Routed.Preflight -> writeHead(out, 204, PhoneCastRules.preflightHeaders())
                    is PhoneCastRules.Routed.Forbidden -> writeError(out, 403)
                    is PhoneCastRules.Routed.MethodNotAllowed -> writeError(out, 405)
                    is PhoneCastRules.Routed.NotFound -> writeError(out, 404)
                }
                runCatching { out.flush() }
            }
        } catch (e: Exception) {
            Log.d(TAG, "connection ended: ${e.message}")
        } finally {
            openClients -= client
        }
    }

    /** Ask the home computer for the same thing the TV asked this phone for, and pass it on. */
    private fun relay(method: String, slot: Int, headers: Map<String, String>, out: OutputStream) {
        val upstream = slots[slot] ?: run { writeError(out, 404); return }
        val rangeDecision = PhoneCastRules.rangeFor(headers["range"])
        if (rangeDecision is PhoneCastRules.RangeDecision.Unsatisfiable) { writeError(out, 416); return }

        val builder = Request.Builder().url(upstream)
            // Never let anything compress a film: it would cost the phone work and lose the
            // Content-Length the TV needs to seek.
            .header("Accept-Encoding", "identity")
        if (rangeDecision is PhoneCastRules.RangeDecision.Pass) builder.header("Range", rangeDecision.header)
        BeeboApp.instance.session.token?.takeIf { it.isNotBlank() }
            ?.let { builder.header("Authorization", "Bearer $it") }
        if (method.equals("HEAD", ignoreCase = true)) builder.head()

        var started = false
        try {
            httpClient().newCall(builder.build()).execute().use { response ->
                val body = response.body
                writeHead(
                    out, response.code,
                    PhoneCastRules.responseHeaders(
                        upstreamStatus = response.code,
                        contentType = response.header("Content-Type"),
                        contentLength = body?.contentLength() ?: -1L,
                        contentRange = response.header("Content-Range"),
                    )
                )
                started = true
                if (method.equals("HEAD", ignoreCase = true) || body == null) return
                copy(body.byteStream(), out)
            }
        } catch (e: IOException) {
            Log.w(TAG, "the home computer stopped answering mid-cast: ${e.message}")
            reportLost()
            // Nothing sent yet: the TV can be told honestly. Once bytes are on the wire the
            // status is already spent, so the connection simply ends and the TV stops.
            if (!started) runCatching { writeError(out, 502) }
        }
    }

    /**
     * The connection to the home computer went. Said only while the cast is genuinely still
     * meant to be running: stopping a cast on purpose also breaks these fetches, and blaming the
     * home computer for that would be a lie.
     */
    private fun reportLost() {
        if (serverSocket != null) _problem.value = CastRule.VIA_PHONE_LOST
    }

    @Volatile private var relayHttp: okhttp3.OkHttpClient? = null

    /**
     * The player's own client, so this goes over exactly the same tunnel the film was already
     * coming down (and shares its connection pool) - with no read timeout, because the tunnel
     * does its own waiting and a paused TV can leave a reply sitting for a long time.
     */
    private fun httpClient(): okhttp3.OkHttpClient {
        relayHttp?.let { return it }
        val built = BeeboApp.instance.api.okHttp.newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        relayHttp = built
        return built
    }

    /**
     * Pull from the home computer and push to the TV at the TV's speed. A failure reading is the
     * tunnel; a failure writing is simply the TV having gone away, and is not worth a message.
     */
    private fun copy(source: InputStream, out: OutputStream) {
        val buf = ByteArray(PhoneCastRules.COPY_BUFFER_BYTES)
        while (true) {
            val read = try {
                source.read(buf)
            } catch (e: IOException) {
                reportLost()
                throw e
            }
            if (read < 0) return
            try {
                out.write(buf, 0, read)
                out.flush()
            } catch (e: IOException) {
                // The TV closed the connection (it seeked, or the cast ended). Perfectly normal.
                return
            }
        }
    }

    // ------------------------------------------------------------------ tiny HTTP

    private fun writeHead(out: OutputStream, status: Int, headers: List<Pair<String, String>>) {
        val sb = StringBuilder(PhoneCastRules.statusLine(status)).append("\r\n")
        for ((k, v) in headers) sb.append(k).append(": ").append(v).append("\r\n")
        sb.append("\r\n")
        out.write(sb.toString().toByteArray(Charsets.US_ASCII))
        out.flush()
    }

    /** Every refusal looks the same from outside: a short line, and nothing to learn from. */
    private fun writeError(out: OutputStream, status: Int) {
        val body = when (status) {
            403 -> "No."
            405 -> "Only GET."
            416 -> "That part of the file doesn't exist."
            502 -> "Beebo lost the connection to your home computer."
            else -> "Nothing here."
        }.toByteArray()
        val sb = StringBuilder(PhoneCastRules.statusLine(status)).append("\r\n")
            .append("Content-Type: text/plain; charset=utf-8\r\n")
            .append("Content-Length: ").append(body.size).append("\r\n")
            .append("Cache-Control: no-store\r\n")
            .append("X-Content-Type-Options: nosniff\r\n")
            .append("Access-Control-Allow-Origin: *\r\n")
            .append("Connection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.US_ASCII))
        out.write(body)
        out.flush()
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        var sawAny = false
        while (true) {
            val c = input.read()
            if (c == -1) return if (sawAny) sb.toString() else null
            sawAny = true
            if (c == '\n'.code) break
            if (c != '\r'.code) sb.append(c.toChar())
            if (sb.length > 8_192) throw IOException("request line too long")
        }
        return sb.toString()
    }

    private fun readHeaders(input: InputStream): Map<String, String> {
        val headers = HashMap<String, String>()
        var count = 0
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            if (++count > 64) throw IOException("too many headers")
            val idx = line.indexOf(':')
            if (idx > 0) headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
        }
        return headers
    }

    // ------------------------------------------------------------------ addresses

    private fun context(): Context? = runCatching { BeeboApp.instance as Context }.getOrNull()

    /**
     * This phone's own address on the Wi-Fi (or Ethernet) it is using. Wi-Fi first: on a phone
     * that is also on a VPN or a tether, the TV is on the Wi-Fi.
     */
    private fun localIpv4(): String? {
        val candidates = ArrayList<Pair<Int, String>>()
        try {
            for (nif in NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp || nif.isLoopback) continue
                val name = nif.name.lowercase()
                for (addr in nif.inetAddresses) {
                    if (addr !is Inet4Address || addr.isLoopbackAddress || !addr.isSiteLocalAddress) continue
                    val rank = when {
                        name.startsWith("wlan") || name.contains("wifi") -> 0
                        name.startsWith("eth") -> 1
                        name.startsWith("p2p") || name.contains("tether") || name.startsWith("rndis") -> 4
                        else -> 3
                    }
                    addr.hostAddress?.let { candidates += rank to it }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "couldn't read this phone's addresses", e)
            return null
        }
        return candidates.minByOrNull { it.first }?.second
    }

    private fun localAddresses(): Set<String> {
        val out = HashSet<String>()
        runCatching {
            for (nif in NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp) continue
                for (addr in nif.inetAddresses) {
                    if (addr is Inet4Address) addr.hostAddress?.let { out += it }
                }
            }
        }
        return out
    }
}
