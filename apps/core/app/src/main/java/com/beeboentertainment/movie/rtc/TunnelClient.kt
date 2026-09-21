package com.beeboentertainment.movie.rtc

import okhttp3.Headers
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.Source
import okio.Timeout
import okio.buffer
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** One open data channel to the home computer. [BeeboTunnel] is the WebRTC one. */
interface TunnelLink {
    val features: TunnelProtocol.HostFeatures
    val isOpen: Boolean
    /** True when this connection runs through a TURN relay rather than directly. */
    val relayed: Boolean
    /** Direct, through Beebo Relay or another relay, when the link could tell (WebRTC stats). */
    val path: TunnelPath get() = if (relayed) TunnelPath.RELAY else TunnelPath.UNKNOWN
    fun send(frame: TunnelProtocol.Frame)
    fun close()
}

/** Messages from a [TunnelLink], on whatever thread its transport uses. */
interface TunnelLinkListener {
    fun onText(link: TunnelLink, text: String)
    fun onBinary(link: TunnelLink, bytes: ByteArray)
    fun onPathChanged(link: TunnelLink) {}
    fun onClosed(link: TunnelLink)
}

/**
 * Opens a link, blocking. Throws [TunnelConnectException] with words worth showing someone.
 */
fun interface TunnelLinkFactory {
    fun connect(listener: TunnelLinkListener): TunnelLink
}

class TunnelConnectException(
    message: String,
    /** A reason retrying can't fix by itself (signed out, subscription lapsed, wrong password). */
    val fatal: Boolean = false,
    /** Worker error code or a local one ("host_offline", "ice_failed", "no_answer", ...). */
    val code: String = "",
) : IOException(message)

/**
 * HTTP over the tunnel, with reconnects that the rest of the app doesn't notice.
 *
 * [execute] turns an OkHttp request into tunnel messages and the reply into an OkHttp response
 * whose body streams as the bytes arrive. [connection] keeps a link open: when it drops (a
 * network change, the PC restarting) requests wait for the next one instead of failing, and a
 * film that was playing carries on from the byte it had reached (see [StreamExchange]).
 *
 * No Android here: the link comes from a [TunnelLinkFactory], so TunnelClientTest drives the whole
 * thing against a fake home computer.
 */
class TunnelClient(
    factory: TunnelLinkFactory,
    private val headTimeoutMs: Long = 30_000,
    private val readTimeoutMs: Long = 90_000,
    private val highWaterBytes: Long = StreamExchange.DEFAULT_HIGH_WATER,
    requestWaitMs: Long = ReconnectBackoff.REQUEST_WAIT_MS,
    jitter: () -> Double = { Math.random() * 2 - 1 },
) {
    companion object {
        const val UPDATE_HOST_MESSAGE =
            "Beebo on your home computer needs an update to work with this app away from home. " +
                "Open Beebo on the computer and install the latest version."
    }

    val cookies = TunnelCookieJar()
    private val exchanges = ConcurrentHashMap<String, Pair<TunnelLink, StreamExchange>>()
    private val nextId = AtomicLong(1)

    private val listener = object : TunnelLinkListener {
        override fun onText(link: TunnelLink, text: String) {
            when (val m = TunnelProtocol.parseText(text)) {
                is TunnelProtocol.Incoming.Head -> exchanges[m.id]?.second?.onHead(m.id, m.head)
                is TunnelProtocol.Incoming.End -> exchanges.remove(m.id)?.second?.onEnd(m.id)
                is TunnelProtocol.Incoming.Err -> exchanges.remove(m.id)?.second?.onErr(m.id, m.status)
                else -> {}
            }
        }

        override fun onBinary(link: TunnelLink, bytes: ByteArray) {
            val (id, payload) = TunnelProtocol.unframe(bytes) ?: return
            val ex = exchanges[id]?.second ?: return
            if (ex.onBinary(id, payload)) {
                // The reader is far behind: stop the PC, and ask again later from the next byte.
                exchanges.remove(id)
                runCatching { link.send(TunnelProtocol.Frame.Text(TunnelProtocol.abort(id))) }
            }
        }

        override fun onPathChanged(link: TunnelLink) { connection.pathChanged(link) }

        override fun onClosed(link: TunnelLink) {
            for ((id, pair) in exchanges.entries.toList()) {
                if (pair.first !== link) continue
                exchanges.remove(id)
                pair.second.onLinkLost("The connection to your home computer dropped.")
            }
            connection.linkLost(link)
        }
    }

    val connection: TunnelConnection = TunnelConnection(factory, listener, requestWaitMs, jitter)

    /** Something is streaming right now (a film, a download). */
    val busy: Boolean get() = exchanges.isNotEmpty()

    /** Run one request. Blocks until the status line; the body streams afterwards. */
    fun execute(request: Request, onCall: ((StreamExchange) -> Unit)? = null): Response {
        val method = request.method
        val bodyBytes = request.body?.let { b -> Buffer().also { b.writeTo(it) }.readByteArray() }
        val contentType = request.body?.contentType()?.toString()
        val path = RouteRule.tunnelPath(request.url.toString())
        val headers = (0 until request.headers.size).map { request.headers.name(it) to request.headers.value(it) }
        val hadAuthorization = request.header("Authorization") != null

        var attempt = 0
        while (true) {
            attempt++
            val link = connection.awaitLink()
            val id = nextId.getAndIncrement().toString()
            val ex = StreamExchange(method, id, highWaterBytes)
            onCall?.invoke(ex)
            exchanges[id] = link to ex
            val head = try {
                val frames = TunnelProtocol.encodeRequest(
                    id, method, path, headers, bodyBytes, contentType, cookies.header(), link.features,
                )
                for (f in frames) link.send(f)
                ex.awaitHead(headTimeoutMs)
            } catch (e: TunnelProtocol.BodyTooLargeException) {
                exchanges.remove(id)
                throw e
            } catch (e: IOException) {
                exchanges.remove(id)
                // A connection that dropped before the answer: a GET or HEAD can safely be asked
                // again on the next one. Anything that might change something is not repeated.
                val idempotent = method == "GET" || method == "HEAD"
                if (idempotent && attempt < 3 && !link.isOpen) continue
                throw e
            }
            cookies.store(head.setCookies)

            // A version 1 agent drops request headers, so a signed-in request arrives anonymous
            // and is refused. Passing that on as a 401 would sign the user out of an account
            // that is fine; say what's actually wrong instead.
            if (link.features.isLegacy && head.status == 401 && hadAuthorization) {
                exchanges.remove(id)
                ex.cancel()
                runCatching { link.send(TunnelProtocol.Frame.Text(TunnelProtocol.abort(id))) }
                throw IOException(UPDATE_HOST_MESSAGE)
            }
            return buildResponse(request, head, ex, path, headers)
        }
    }

    private fun buildResponse(
        request: Request,
        head: TunnelProtocol.ResponseHead,
        ex: StreamExchange,
        path: String,
        requestHeaders: List<Pair<String, String>>,
    ): Response {
        val hb = Headers.Builder()
        for ((k, v) in head.headers) runCatching { hb.addUnsafeNonAscii(k, v) }
        val source = ExchangeSource(ex, path, requestHeaders).buffer()
        val noBody = request.method == "HEAD" || head.status == 204 || head.status == 304
        val ctype = head.contentType
        val length = if (noBody) 0L else head.contentLength
        return Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(head.status)
            .message(statusMessage(head.status))
            .headers(hb.build())
            .body(object : ResponseBody() {
                override fun contentType(): MediaType? = ctype.toMediaTypeOrNull()
                override fun contentLength(): Long = length
                override fun source(): BufferedSource = source
            })
            .build()
    }

    /** Stop everything and forget the session's cookies (signing out, or a different address). */
    fun shutdown() {
        for ((id, pair) in exchanges.entries.toList()) {
            exchanges.remove(id)
            pair.second.fail(IOException("Disconnected from your home computer."))
        }
        cookies.clear()
        connection.shutdown()
    }

    /**
     * The body of a reply. Blocking on purpose: the player pulls at the speed it needs, and when it
     * stops, [StreamExchange] pauses the PC rather than filling memory.
     */
    private inner class ExchangeSource(
        private val ex: StreamExchange,
        private val path: String,
        private val requestHeaders: List<Pair<String, String>>,
    ) : Source {
        private var done = false
        private var pending: ByteArray? = null
        private var pendingOff = 0

        override fun read(sink: Buffer, byteCount: Long): Long {
            if (done) return -1
            while (true) {
                pending?.let { buf ->
                    val n = minOf(byteCount, (buf.size - pendingOff).toLong()).toInt()
                    sink.write(buf, pendingOff, n)
                    pendingOff += n
                    if (pendingOff >= buf.size) { pending = null; pendingOff = 0 }
                    return n.toLong()
                }
                val t = try {
                    ex.take(readTimeoutMs)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw IOException("Interrupted while reading from your home computer.")
                }
                when (t) {
                    is StreamExchange.Take.Chunk -> { pending = t.bytes; pendingOff = 0 }
                    is StreamExchange.Take.End -> { done = true; return -1 }
                    is StreamExchange.Take.NeedsResume -> resume()
                }
            }
        }

        /** Ask for the rest, from the next byte, on whichever connection is open now. */
        private fun resume() {
            var tries = 0
            while (true) {
                if (++tries > 6) throw IOException("The connection to your home computer keeps dropping.")
                val link = connection.awaitLink()
                val id = nextId.getAndIncrement().toString()
                val range = ex.beginResume(id)
                exchanges[id] = link to ex
                val headers = requestHeaders.filterNot { it.first.equals("Range", true) } + ("Range" to range)
                try {
                    for (f in TunnelProtocol.encodeRequest(id, "GET", path, headers, null, null, cookies.header(), link.features)) {
                        link.send(f)
                    }
                } catch (e: IOException) {
                    exchanges.remove(id)
                    if (ex.onLinkLost("The connection to your home computer dropped.")) continue
                    throw e
                }
                if (ex.awaitResumed(headTimeoutMs)) return
            }
        }

        override fun timeout(): Timeout = Timeout.NONE

        override fun close() {
            if (done) return
            done = true
            val id = ex.wireId
            val pair = exchanges.remove(id)
            ex.cancel()
            pair?.first?.let { link -> runCatching { link.send(TunnelProtocol.Frame.Text(TunnelProtocol.abort(id))) } }
        }
    }

    private fun statusMessage(code: Int) = when (code) {
        200 -> "OK"; 204 -> "No Content"; 206 -> "Partial Content"
        301 -> "Moved Permanently"; 302 -> "Found"; 304 -> "Not Modified"; 307 -> "Temporary Redirect"; 308 -> "Permanent Redirect"
        400 -> "Bad Request"; 401 -> "Unauthorized"; 402 -> "Payment Required"; 403 -> "Forbidden"; 404 -> "Not Found"
        413 -> "Payload Too Large"; 416 -> "Range Not Satisfiable"
        500 -> "Internal Server Error"; 502 -> "Bad Gateway"; 503 -> "Service Unavailable"
        else -> ""
    }
}
