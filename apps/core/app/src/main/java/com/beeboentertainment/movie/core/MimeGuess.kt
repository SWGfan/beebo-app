package com.beeboentertainment.movie.core

/**
 * Extension -> MIME mapping used when handing a stream to a Chromecast.
 *
 * Chromecast is far pickier than ExoPlayer: the default media receiver looks at the
 * content type we declare in the MediaInfo. Local playback can sniff the container,
 * casting cannot, so we make the best guess we can.
 *
 * The catch: the contract's stream URLs look like `/file?id=<encodedId>&mt=<token>` and carry
 * no extension in the path at all. So we look, in order, at:
 *   1. the URL path
 *   2. any query parameter whose value looks like a filename
 *   3. the base64-ish `id` parameter, decoded, in case the server encoded a real file path
 *   4. an explicit title/filename hint the caller passes in
 */
object MimeGuess {

    private val MAP = mapOf(
        "mp4" to "video/mp4",
        "m4v" to "video/mp4",
        "mov" to "video/quicktime",
        "mkv" to "video/x-matroska",
        "webm" to "video/webm",
        "avi" to "video/x-msvideo",
        "wmv" to "video/x-ms-wmv",
        "flv" to "video/x-flv",
        "ts" to "video/mp2t",
        "m2ts" to "video/mp2t",
        "mts" to "video/mp2t",
        "mpg" to "video/mpeg",
        "mpeg" to "video/mpeg",
        "3gp" to "video/3gpp",
        "ogv" to "video/ogg",
        "m3u8" to "application/x-mpegURL",
        "mpd" to "application/dash+xml",
        "mp3" to "audio/mpeg",
        "m4a" to "audio/mp4",
        "flac" to "audio/flac",
        "aac" to "audio/aac",
        "ogg" to "audio/ogg",
        "wav" to "audio/wav"
    )

    const val DEFAULT = "video/mp4"

    /** Map a bare extension (with or without a leading dot, any case) to a MIME type. */
    fun fromExtension(ext: String?): String? {
        val e = ext?.trim()?.removePrefix(".")?.lowercase() ?: return null
        if (e.isEmpty()) return null
        return MAP[e]
    }

    /**
     * Best-effort MIME type for a stream URL.
     * [hint] is an optional filename/title that may itself carry the extension.
     * Never returns null — falls back to [DEFAULT] so casting at least attempts playback.
     */
    fun forStreamUrl(url: String?, hint: String? = null): String {
        candidateExtensions(url, hint).forEach { ext ->
            fromExtension(ext)?.let { return it }
        }
        return DEFAULT
    }

    /** Exposed for tests: the ordered list of extension candidates we consider. */
    fun candidateExtensions(url: String?, hint: String? = null): List<String> {
        val out = mutableListOf<String>()
        val u = url.orEmpty()

        val pathPart = u.substringBefore('?').substringBefore('#')
        extOf(pathPart)?.let { out += it }

        val queryPart = u.substringAfter('?', "").substringBefore('#')
        if (queryPart.isNotEmpty()) {
            for (kv in queryPart.split('&')) {
                val key = kv.substringBefore('=')
                val value = decode(kv.substringAfter('=', ""))
                if (value.isEmpty()) continue
                extOf(value)?.let { out += it }
                // the encoded id often base64-wraps a real path like "/movies/Foo (1999).mkv"
                if (key.equals("id", true) || key.equals("k", true) || key.equals("p", true)) {
                    base64Decode(value)?.let { decoded -> extOf(decoded)?.let { out += it } }
                }
            }
        }

        hint?.let { extOf(it)?.let { e -> out += e } }
        return out.distinct()
    }

    /** Pull a plausible file extension off the tail of a string. */
    private fun extOf(s: String): String? {
        val tail = s.substringAfterLast('/').substringAfterLast('\\')
        val dot = tail.lastIndexOf('.')
        if (dot < 0 || dot == tail.length - 1) return null
        val ext = tail.substring(dot + 1).lowercase()
        // extensions are short and alphanumeric; anything else is a false positive
        if (ext.length !in 1..5) return null
        if (!ext.all { it.isLetterOrDigit() }) return null
        return ext
    }

    private fun decode(s: String): String = try {
        java.net.URLDecoder.decode(s, "UTF-8")
    } catch (_: Exception) {
        s
    }

    private fun base64Decode(s: String): String? = try {
        // tolerate url-safe alphabet and missing padding
        var t = s.replace('-', '+').replace('_', '/')
        while (t.length % 4 != 0) t += "="
        val bytes = javaBase64(t) ?: return null
        val text = String(bytes, Charsets.UTF_8)
        if (text.any { it.code in 0..8 }) null else text
    } catch (_: Exception) {
        null
    }

    @android.annotation.SuppressLint("NewApi") // API 24-25 fall back to android.util.Base64 below
    private fun javaBase64(s: String): ByteArray? = try {
        java.util.Base64.getDecoder().decode(s)
    } catch (_: Throwable) {
        // java.util.Base64 exists from API 26; on 24/25 fall back to android.util.Base64 via reflection
        try {
            val cls = Class.forName("android.util.Base64")
            val m = cls.getMethod("decode", String::class.java, Int::class.javaPrimitiveType)
            m.invoke(null, s, 0) as ByteArray
        } catch (_: Throwable) {
            null
        }
    }
}
