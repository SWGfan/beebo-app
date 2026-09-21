package com.beeboentertainment.movie.sources

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/** One entry discovered inside a [ProbeResult.Index] listing. */
@Serializable
data class DiscoveredItem(
    val id: String,
    val label: String,
    /** Absolute, ready to hand to the player. */
    val url: String,
)

/**
 * What a pasted link turned out to be. [url] is always the normalised, final URL
 * — after any redirects the probe followed — so the caller can save that rather
 * than the raw text the user typed.
 */
sealed interface ProbeResult {
    val url: String

    data class DirectMedia(override val url: String, val contentType: String?) : ProbeResult
    data class Index(override val url: String, val items: List<DiscoveredItem>) : ProbeResult
    data class Unknown(override val url: String) : ProbeResult
}

/**
 * Classifies a pasted website/video link.
 *
 * The classification rules (media extension, media Content-Type, index parsing)
 * are pure and unit-testable; only [probe] touches the network, and it takes the
 * core app's shared OkHttp client. Unlike the reference app there is no
 * hand-rolled http->https upgrade loop: the core client keeps followSslRedirects
 * ON, so OkHttp follows the same-port 308 itself.
 */
object SourceProbe {

    /** Extensions we treat as directly playable without asking the server. */
    private val MEDIA_EXTENSIONS =
        setOf("mp4", "mkv", "webm", "m3u8", "mp3", "m4v", "mov")

    private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.\\-]*://")

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    // How much of a listing we are willing to buffer to sniff/parse it.
    private const val MAX_INDEX_BYTES = 512L * 1024L
    // How much of a body we pull just to read headers on a HEAD-less server.
    private const val SNIFF_BYTES = 2048

    // -------------------------------------------------------------- pure rules

    /**
     * Turns whatever the user pasted into a usable http(s) URL string.
     *
     * Defaults a missing scheme to https — these are arbitrary internet links,
     * not a LAN box that multiplexes http/https on one port — and keeps the path,
     * since the path is the whole point of a "bring your own file" link.
     *
     * @throws IllegalArgumentException if [raw] is blank or cannot be read as an
     *   http(s) URL. The message is written to be shown verbatim in the UI.
     */
    fun normalize(raw: String): String {
        val typed = raw.trim()
        require(typed.isNotEmpty()) { "Paste a website or video link first." }
        val withScheme = if (SCHEME.containsMatchIn(typed)) typed else "https://$typed"
        val url = withScheme.toHttpUrlOrNull()
            ?: throw IllegalArgumentException("That doesn't look like a web link.")
        return url.toString()
    }

    /** True for audio, video, or an HLS playlist Content-Type. */
    fun isMediaContentType(contentType: String?): Boolean {
        val ct = contentType?.substringBefore(';')?.trim()?.lowercase() ?: return false
        return ct.startsWith("audio/") ||
            ct.startsWith("video/") ||
            ct == "application/vnd.apple.mpegurl" ||
            ct == "application/x-mpegurl"
    }

    /** True when the URL path ends in a known media extension. */
    fun isMediaPath(url: String): Boolean {
        val httpUrl = url.toHttpUrlOrNull() ?: return false
        val last = httpUrl.pathSegments.lastOrNull().orEmpty()
        val ext = last.substringAfterLast('.', "").lowercase()
        return ext in MEDIA_EXTENSIONS
    }

    /**
     * Best-effort parse of a streamServer-style JSON listing into playable items.
     * Tolerant on purpose: it accepts a bare array or an object carrying an
     * items/entries/tracks/files array, and reads a URL from any of several common
     * field names, resolving relatives against [baseUrl]. Returns null when
     * nothing usable is found.
     */
    fun parseIndex(baseUrl: String, body: String): List<DiscoveredItem>? {
        val root = runCatching { json.parseToJsonElement(body) }.getOrNull() ?: return null
        val array: JsonArray = when (root) {
            is JsonArray -> root
            is JsonObject -> ARRAY_KEYS.firstNotNullOfOrNull { root[it] as? JsonArray }
                ?: return null
            else -> return null
        }
        val base = baseUrl.toHttpUrlOrNull()
        val out = ArrayList<DiscoveredItem>(array.size)
        array.forEachIndexed { i, el ->
            val obj = el as? JsonObject ?: return@forEachIndexed
            val rawUrl = URL_KEYS.firstNotNullOfOrNull { obj.stringField(it) }
                ?: return@forEachIndexed
            val abs = base?.resolve(rawUrl)?.toString() ?: rawUrl
            val label = LABEL_KEYS.firstNotNullOfOrNull { obj.stringField(it) }
                ?: "Item ${i + 1}"
            out += DiscoveredItem(id = "usrc_item_$i", label = label, url = abs)
        }
        return out.ifEmpty { null }
    }

    private val ARRAY_KEYS = listOf("items", "entries", "tracks", "files", "media")
    private val URL_KEYS = listOf("url", "stream", "src", "file", "path", "href")
    private val LABEL_KEYS = listOf("title", "name", "label", "id")

    private fun JsonObject.stringField(key: String): String? {
        val prim = this[key] as? JsonPrimitive ?: return null
        if (!prim.isString) return null
        return prim.content.takeIf { it.isNotBlank() }
    }

    // ------------------------------------------------------------------ probe

    /**
     * Classifies [raw] using [http]. Network-tolerant: a server that is
     * unreachable or blocks HEAD does not fail the add — the link falls back to
     * path-based classification and, failing that, [ProbeResult.Unknown], which
     * the app still lets the user save and treats as direct on play. Only
     * genuinely unparseable input (via [normalize]) throws.
     */
    suspend fun probe(raw: String, http: OkHttpClient): ProbeResult =
        withContext(Dispatchers.IO) {
            val normalized = normalize(raw)

            // 1. HEAD for a Content-Type and the post-redirect final URL.
            val head = runCatching { call(http, normalized, "HEAD") }.getOrNull()
            var finalUrl = head?.url ?: normalized
            var contentType = head?.contentType

            // 2. HEAD refused or bare? Sniff with a tiny ranged GET.
            if (head == null || head.code == 405 || head.code == 501 || contentType == null) {
                val sniff = runCatching {
                    call(http, finalUrl, "GET", rangeBytes = SNIFF_BYTES)
                }.getOrNull()
                if (sniff != null) {
                    finalUrl = sniff.url
                    contentType = contentType ?: sniff.contentType
                }
            }

            if (isMediaContentType(contentType) || isMediaPath(finalUrl)) {
                return@withContext ProbeResult.DirectMedia(finalUrl, contentType)
            }

            // 3. Might be a JSON listing. Pull a bounded body and try to parse it.
            val body = runCatching {
                call(http, finalUrl, "GET", bodyCap = MAX_INDEX_BYTES).body
            }.getOrNull()
            if (body != null) {
                parseIndex(finalUrl, body)?.let {
                    return@withContext ProbeResult.Index(finalUrl, it)
                }
            }

            // 3b. A bare origin might expose its listing under /api. One attempt.
            apiSibling(finalUrl)?.let { sibling ->
                val apiBody = runCatching {
                    call(http, sibling, "GET", bodyCap = MAX_INDEX_BYTES).body
                }.getOrNull()
                if (apiBody != null) {
                    parseIndex(sibling, apiBody)?.let {
                        return@withContext ProbeResult.Index(sibling, it)
                    }
                }
            }

            ProbeResult.Unknown(finalUrl)
        }

    /** `https://host/` -> `https://host/api`, or null when the URL has a path. */
    private fun apiSibling(url: String): String? {
        val u = url.toHttpUrlOrNull() ?: return null
        val hasPath = u.pathSegments.any { it.isNotBlank() }
        if (hasPath) return null
        return u.newBuilder().addPathSegment("api").build().toString()
    }

    // --------------------------------------------------------------- plumbing

    private class Fetched(
        val url: String,
        val code: Int,
        val contentType: String?,
        val body: String?,
    )

    /**
     * Runs one request. Ordinary and same-port http->https redirects are followed
     * by OkHttp (the core client keeps followRedirects/followSslRedirects on), so
     * the returned URL is read off the final request.
     */
    private fun call(
        client: OkHttpClient,
        url: String,
        method: String,
        rangeBytes: Int? = null,
        bodyCap: Long? = null,
    ): Fetched {
        val httpUrl = url.toHttpUrlOrNull()
            ?: throw IllegalArgumentException("That link can't be opened.")
        val builder = Request.Builder().url(httpUrl)
        if (method == "HEAD") builder.head() else builder.get()
        rangeBytes?.let { builder.header("Range", "bytes=0-${it - 1}") }

        client.newCall(builder.build()).execute().use {
            val body = if (bodyCap != null && it.isSuccessful) {
                it.peekBody(bodyCap).string()
            } else null
            return Fetched(
                url = it.request.url.toString(),
                code = it.code,
                contentType = it.header("Content-Type"),
                body = body,
            )
        }
    }
}
