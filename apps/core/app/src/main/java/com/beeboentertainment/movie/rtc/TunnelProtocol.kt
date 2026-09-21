package com.beeboentertainment.movie.rtc

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okio.ByteString.Companion.toByteString
import java.io.IOException

/**
 * The HTTP-over-data-channel wire format, byte for byte what the home computer's host agent
 * (desktop/apps/desktop/resources/beebo-rtc-host/beebo-rtc-host.js) and the browser viewer page
 * (VIEWER_HTML + SW_JS in worker/worker.js) speak. Free of Android so every rule here has a JVM
 * unit test (TunnelProtocolTest).
 *
 * ## Version 1 (the browser page; every host agent)
 * ```
 * phone -> PC  text  {"kind":"req","id":"7","method":"GET","path":"/api/movies","range":"bytes=0-",
 *                     "ctype":"application/json","cookie":"a=1","body":"<base64>"}
 *                    {"kind":"abort","id":"7"}
 * PC -> phone  text  {"kind":"head","id":"7","status":206,"ctype":"video/mp4","clen":"1000",
 *                     "crange":"bytes 0-999/5000","setcookie":"","location":""}
 *                    {"kind":"end","id":"7"}   {"kind":"err","id":"7","status":502}
 *              bin   [uint16 big-endian id length][id, UTF-8][payload]
 * ```
 * `clen`, `crange`, `setcookie` and `location` are strings, and "" means absent. The old in-app
 * host sent numbers and nulls instead, so both are accepted.
 *
 * ## Version 2 (this app, with a host agent from desktop 0.1.34)
 * The phone says `{"kind":"hello","proto":2}` once the channel opens. A version-2 agent answers
 * `{"kind":"hello","proto":2,"features":[...],"maxBody":8388608,"bodyChunk":16384}`; an older one
 * says nothing, which is how it is recognised. Features:
 *  - `headers`: `req.headers` (Authorization, X-Beebo-Media-Token, ...) is passed on. Version 1
 *    agents drop it, so a bearer token never arrives; see [HostFeatures.headers].
 *  - `body-chunks`: a body over [INLINE_BODY_MAX] goes as `{req..., "bodyChunks":true,"blen":N}`,
 *    then binary frames framed exactly like responses, then `{"kind":"bend","id":...}`.
 *  - `set-cookies`: `head.setcookies`, every Set-Cookie as a list.
 *  - `resp-headers`: `head.headers`, a short allowlist of response headers.
 *
 * A single data-channel message must stay under the host's SCTP max-message-size (werift
 * advertises 65536), which is why an inline body is capped well below it.
 */
object TunnelProtocol {

    const val PROTO = 2
    /** The label the host agent accepts; any other channel is ignored by it. */
    const val CHANNEL_LABEL = "http"

    /** Bodies up to this size go inline as base64 (4/3 larger), leaving room in a 64 KB message. */
    const val INLINE_BODY_MAX = 32 * 1024
    const val DEFAULT_BODY_CHUNK = 16 * 1024
    const val DEFAULT_MAX_BODY = 8L * 1024 * 1024

    /** Request headers never sent: hop-by-hop, set by OkHttp for a socket, or carried in their own field. */
    private val SKIP_HEADERS = setOf(
        "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te",
        "trailer", "expect", "accept-encoding", "proxy-connection", "range", "cookie", "content-type",
    )

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** What the host said it can do. [LEGACY] when it never answered the hello. */
    data class HostFeatures(
        val proto: Int,
        val features: Set<String>,
        val maxBody: Long,
        val bodyChunk: Int,
    ) {
        val headers: Boolean get() = "headers" in features
        val bodyChunks: Boolean get() = "body-chunks" in features
        val isLegacy: Boolean get() = proto < PROTO

        companion object {
            val LEGACY = HostFeatures(1, emptySet(), INLINE_BODY_MAX.toLong(), DEFAULT_BODY_CHUNK)
        }
    }

    /** One message to put on the channel. */
    sealed class Frame {
        data class Text(val text: String) : Frame()
        class Binary(val bytes: ByteArray) : Frame()
    }

    class BodyTooLargeException(val size: Long, val max: Long) :
        IOException("That upload is too large to send to your home computer (${size / 1024} KB, limit ${max / 1024} KB).")

    fun hello(): String = buildJsonObject { put("kind", "hello"); put("proto", PROTO) }.toString()

    fun abort(id: String): String = buildJsonObject { put("kind", "abort"); put("id", id) }.toString()

    /**
     * Everything to send for one request, in order.
     *
     * @param headers every request header, as OkHttp holds them. Range and Cookie move to their
     *   own fields; [cookieJar] (this connection's own cookies) is merged under a Cookie header
     *   the caller set itself.
     */
    fun encodeRequest(
        id: String,
        method: String,
        path: String,
        headers: List<Pair<String, String>>,
        body: ByteArray?,
        contentType: String?,
        cookieJar: String?,
        host: HostFeatures,
    ): List<Frame> {
        var range: String? = null
        var cookie: String? = null
        var headerCtype: String? = null
        val extra = LinkedHashMap<String, String>()
        for ((name, value) in headers) {
            when (name.lowercase()) {
                "range" -> range = value
                "cookie" -> cookie = if (cookie == null) value else "$cookie; $value"
                "content-type" -> headerCtype = value
                else -> if (name.lowercase() !in SKIP_HEADERS) {
                    // Repeated headers are rare here; the last one wins, as in a JSON object.
                    extra[name] = value
                }
            }
        }
        val mergedCookie = mergeCookies(cookie, cookieJar)
        val ctype = contentType ?: headerCtype
        val size = body?.size?.toLong() ?: 0L
        val chunked = size > INLINE_BODY_MAX
        if (chunked && (!host.bodyChunks || size > host.maxBody)) {
            throw BodyTooLargeException(size, if (host.bodyChunks) host.maxBody else INLINE_BODY_MAX.toLong())
        }

        val req = buildJsonObject {
            put("kind", "req")
            put("id", id)
            put("method", method)
            put("path", path)
            range?.let { put("range", it) }
            ctype?.let { put("ctype", it) }
            mergedCookie?.let { put("cookie", it) }
            if (size > 0 && !chunked) put("body", body!!.toByteString().base64())
            if (chunked) { put("bodyChunks", true); put("blen", size) }
            // Sent to a version 1 host too: the old in-app host honoured it, and the Node agent
            // simply ignores what it doesn't know.
            if (extra.isNotEmpty()) put("headers", JsonObject(extra.mapValues { JsonPrimitive(it.value) }))
        }
        val out = mutableListOf<Frame>(Frame.Text(req.toString()))
        if (chunked) {
            val step = host.bodyChunk.coerceIn(1024, 60 * 1024)
            var off = 0
            while (off < body!!.size) {
                val n = minOf(step, body.size - off)
                out.add(Frame.Binary(frame(id, body, off, n)))
                off += n
            }
            out.add(Frame.Text(buildJsonObject { put("kind", "bend"); put("id", id) }.toString()))
        }
        return out
    }

    /** "a=1; b=2" merged with the jar's, by name, the caller's own value winning. */
    fun mergeCookies(explicit: String?, jar: String?): String? {
        val m = LinkedHashMap<String, String>()
        for (src in listOf(jar, explicit)) {
            for (part in src.orEmpty().split(';')) {
                val i = part.indexOf('=')
                if (i <= 0) continue
                m[part.substring(0, i).trim()] = part.substring(i + 1).trim()
            }
        }
        return if (m.isEmpty()) null else m.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    // ------------------------------------------------------------------ frames

    fun frame(id: String, payload: ByteArray, offset: Int = 0, length: Int = payload.size): ByteArray {
        val idBytes = id.toByteArray(Charsets.UTF_8)
        require(idBytes.size <= 0xFFFF) { "id too long" }
        val out = ByteArray(2 + idBytes.size + length)
        out[0] = (idBytes.size ushr 8).toByte()
        out[1] = idBytes.size.toByte()
        System.arraycopy(idBytes, 0, out, 2, idBytes.size)
        System.arraycopy(payload, offset, out, 2 + idBytes.size, length)
        return out
    }

    /** (id, payload) of a binary frame, or null if it is too short to be one. */
    fun unframe(bytes: ByteArray): Pair<String, ByteArray>? {
        if (bytes.size < 2) return null
        val idLen = ((bytes[0].toInt() and 0xFF) shl 8) or (bytes[1].toInt() and 0xFF)
        if (bytes.size < 2 + idLen) return null
        val id = String(bytes, 2, idLen, Charsets.UTF_8)
        return id to bytes.copyOfRange(2 + idLen, bytes.size)
    }

    // ------------------------------------------------------------------ replies

    data class ResponseHead(
        val status: Int,
        val contentType: String,
        /** -1 when unknown. */
        val contentLength: Long,
        /** Every header to put on the OkHttp response, Set-Cookie repeated. */
        val headers: List<Pair<String, String>>,
        val setCookies: List<String>,
    )

    sealed class Incoming {
        data class Hello(val features: HostFeatures) : Incoming()
        data class Head(val id: String, val head: ResponseHead) : Incoming()
        data class End(val id: String) : Incoming()
        data class Err(val id: String, val status: Int) : Incoming()
        data object Ignored : Incoming()
    }

    fun parseText(text: String): Incoming {
        val obj = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return Incoming.Ignored
        val kind = obj.str("kind")
        if (kind == "hello") return Incoming.Hello(parseHello(obj))
        val id = obj.str("id") ?: return Incoming.Ignored
        return when (kind) {
            "head" -> Incoming.Head(id, parseHead(obj))
            "end" -> Incoming.End(id)
            "err" -> Incoming.Err(id, obj.num("status")?.toInt() ?: 502)
            else -> Incoming.Ignored
        }
    }

    internal fun parseHello(obj: JsonObject): HostFeatures {
        val proto = obj.num("proto")?.toInt() ?: 1
        val features = (obj["features"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }?.toSet().orEmpty()
        val maxBody = obj.num("maxBody")?.takeIf { it > 0 } ?: DEFAULT_MAX_BODY
        val chunk = obj.num("bodyChunk")?.toInt()?.takeIf { it in 1024..60_000 } ?: DEFAULT_BODY_CHUNK
        return HostFeatures(proto, features, maxBody, chunk)
    }

    internal fun parseHead(obj: JsonObject): ResponseHead {
        val status = obj.num("status")?.toInt()?.takeIf { it in 100..599 } ?: 502
        val ctype = obj.str("ctype")?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        val clen = obj.num("clen")?.takeIf { it >= 0 } ?: -1L
        val crange = obj.str("crange")?.takeIf { it.isNotBlank() }
        val location = obj.str("location")?.takeIf { it.isNotBlank() }

        val setCookies = (obj["setcookies"] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.takeIf { s -> s.isNotBlank() } }
            ?: listOfNotNull(obj.str("setcookie")?.takeIf { it.isNotBlank() })

        val headers = mutableListOf<Pair<String, String>>()
        headers.add("Content-Type" to ctype)
        if (clen >= 0) headers.add("Content-Length" to clen.toString())
        if (crange != null) {
            headers.add("Content-Range" to crange)
            headers.add("Accept-Ranges" to "bytes")
        }
        location?.let { headers.add("Location" to it) }
        setCookies.forEach { headers.add("Set-Cookie" to it) }
        (obj["headers"] as? JsonObject)?.forEach { (k, v) ->
            val value = (v as? JsonPrimitive)?.contentOrNull ?: return@forEach
            if (k.isBlank() || value.any { it == '\r' || it == '\n' }) return@forEach
            val lower = k.lowercase()
            if (lower in setOf("content-type", "content-length", "content-range", "location", "set-cookie")) return@forEach
            if (lower == "accept-ranges" && crange != null) return@forEach
            headers.add(k to value)
        }
        return ResponseHead(status, ctype, clen, headers, setCookies)
    }

    private fun JsonObject.str(key: String): String? = when (val e: JsonElement? = this[key]) {
        null, is JsonNull -> null
        is JsonPrimitive -> e.contentOrNull
        else -> null
    }

    /** A number sent as a number or as a numeric string ("" and null are absent). */
    private fun JsonObject.num(key: String): Long? = when (val e = this[key]) {
        null, is JsonNull -> null
        is JsonPrimitive -> e.longOrNull ?: e.intOrNull?.toLong() ?: e.contentOrNull?.trim()?.toLongOrNull()
        else -> null
    }

    // ------------------------------------------------------------------ ranges

    /** The first byte a `Range: bytes=a-b` asks for, 0 when there is no usable range. */
    fun rangeStart(range: String?): Long? {
        if (range.isNullOrBlank()) return 0L
        val m = Regex("""^\s*bytes=(\d+)-(\d*)\s*$""").find(range) ?: return null
        return m.groupValues[1].toLongOrNull()
    }

    /** The last byte asked for, or null for "to the end" (or no range). */
    fun rangeEnd(range: String?): Long? {
        if (range.isNullOrBlank()) return null
        val m = Regex("""^\s*bytes=(\d+)-(\d*)\s*$""").find(range) ?: return null
        return m.groupValues[2].takeIf { it.isNotEmpty() }?.toLongOrNull()
    }

    /** The Range to ask for to carry on after [delivered] bytes of an answer that began at [start]. */
    fun resumeRange(start: Long, end: Long?, delivered: Long): String =
        "bytes=${start + delivered}-${end ?: ""}"

    /** Start of a `Content-Range: bytes a-b/total`, or null. */
    fun contentRangeStart(contentRange: String?): Long? =
        contentRange?.let { Regex("""^\s*bytes\s+(\d+)-\d+/(\d+|\*)\s*$""").find(it) }?.groupValues?.get(1)?.toLongOrNull()
}
