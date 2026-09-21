package com.beeboentertainment.movie.core

/**
 * Pure URL helpers. The API contract says `poster` and `stream` come back as SERVER-RELATIVE
 * paths, so the app has to glue them onto whatever base URL the owner typed at first run.
 * The owner may or may not type a trailing slash, a scheme, or a port, so normalise hard.
 */
object UrlUtils {

    const val HTTP_PREFIX = "http://"
    const val HTTPS_PREFIX = "https://"

    /**
     * Rewrite a plain-HTTP base URL to HTTPS, leaving everything else about it alone.
     *
     * The server serves both protocols on the same port and 308-redirects http to https, so an
     * un-upgraded install still works — it just pays a redirect on every request. This is what
     * lets us stop paying that.
     *
     * Returns the input unchanged when it is already https, and null when there is nothing
     * usable to upgrade. Host, port and any path are preserved exactly.
     */
    fun upgradeToHttps(raw: String?): String? {
        val normalized = normalizeBaseUrl(raw) ?: return null
        if (normalized.startsWith(HTTPS_PREFIX, ignoreCase = true)) return normalized
        if (!normalized.startsWith(HTTP_PREFIX, ignoreCase = true)) return normalized
        return HTTPS_PREFIX + normalized.substring(HTTP_PREFIX.length)
    }

    /** True when this address would actually change by upgrading it. */
    fun needsHttpsUpgrade(raw: String?): Boolean {
        val normalized = normalizeBaseUrl(raw) ?: return false
        val upgraded = upgradeToHttps(raw) ?: return false
        return normalized != upgraded
    }

    /**
     * Clean up whatever the user typed into the "server address" box.
     * - trims whitespace
     * - adds https:// when no scheme is given (the server now has a real certificate)
     * - strips any trailing slashes so joins are predictable
     * Returns null if there is nothing usable.
     */
    fun normalizeBaseUrl(raw: String?): String? {
        var s = raw?.trim().orEmpty()
        if (s.isEmpty()) return null
        if (!s.startsWith("http://", ignoreCase = true) && !s.startsWith("https://", ignoreCase = true)) {
            s = "$HTTPS_PREFIX$s"
        }
        while (s.endsWith("/")) s = s.dropLast(1)
        // a scheme with no host behind it ("http://", "http:///") is not a server
        val host = s.substringAfter("://", "")
        if (host.isBlank()) return null
        return s
    }

    /**
     * The `nick` in `nick.beebo.tv`, however it was typed (scheme, port, path, capitals,
     * trailing dot), or null when the address isn't a personal beebo.tv address.
     *
     * Such an address is not a media server. It is a web page that signs you in and then
     * streams peer-to-peer from the home computer inside the browser, so this app can't
     * speak to it over plain HTTP: it used to probe /api/ping, get a 404, and tell the
     * user "That's gone already". The bare `beebo.tv` and `www.beebo.tv` are not personal.
     */
    fun beeboTvName(raw: String?): String? {
        val normalized = normalizeBaseUrl(raw) ?: return null
        val host = normalized.substringAfter("://")
            .substringBefore('/')
            .substringBefore('?')
            .substringBefore('#')
            .substringAfterLast('@')
            .substringBefore(':')
            .trimEnd('.')
            .lowercase()
        if (!host.endsWith(".beebo.tv")) return null
        val label = host.removeSuffix(".beebo.tv")
        if (label.isEmpty() || label.contains('.') || label == "www") return null
        if (!label.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }) return null
        return label
    }

    /**
     * True when two addresses, however they were typed or stored, mean the same server.
     *
     * Used to decide whether offering "go back to the default address" would actually
     * change anything: nobody needs a button that swaps an address for itself, and a
     * trailing slash or a capital letter must not make one appear.
     */
    fun sameBaseUrl(a: String?, b: String?): Boolean {
        val na = normalizeBaseUrl(a) ?: return false
        val nb = normalizeBaseUrl(b) ?: return false
        return na.equals(nb, ignoreCase = true)
    }

    /**
     * Join a normalised (or un-normalised) base URL with a server-relative path.
     * Handles double slashes, missing slashes, and already-absolute URLs (returned untouched).
     */
    fun join(baseUrl: String?, path: String?): String? {
        if (path.isNullOrBlank()) return null
        val p = path.trim()
        if (p.startsWith("http://", true) || p.startsWith("https://", true)) return p
        val base = normalizeBaseUrl(baseUrl) ?: return null
        return if (p.startsWith("/")) base + p else "$base/$p"
    }

    /** Convenience for building API endpoints, e.g. endpoint(base, "/api/ping"). */
    fun endpoint(baseUrl: String?, apiPath: String): String? = join(baseUrl, apiPath)

    /**
     * Build a query string from pairs, skipping null/blank values.
     * Returns "" (not "?") when nothing survives, so it can always be appended.
     */
    fun query(vararg pairs: Pair<String, String?>): String {
        val parts = pairs.mapNotNull { (k, v) ->
            if (v.isNullOrBlank()) null else "${encode(k)}=${encode(v)}"
        }
        return if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
    }

    /** Minimal percent-encoder (java.net.URLEncoder is available on the JVM and on Android). */
    fun encode(s: String): String =
        java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
