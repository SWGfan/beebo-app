package com.beeboentertainment.movie.core

import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * Decoding of the opaque `id` the API uses for library items.
 *
 * POST /api/history/clear with scope="one" wants a `fileName` (for movies the filename, for TV
 * the path relative to the TV Shows root), but /api/continue only hands us the encoded id. In
 * practice that id is a base64 wrapper around exactly that path, so we decode it when it decodes
 * cleanly and fall back to sending the id untouched when it doesn't — the server treats an
 * unmatched fileName as "removes nothing" rather than an error, so a wrong guess is harmless.
 */
object IdCodec {

    /** Best-effort decode of an encoded id back to the server-side path/filename. */
    fun decodeToPath(id: String?): String? {
        val raw = id?.trim().orEmpty()
        if (raw.isEmpty()) return null
        var t = raw.replace('-', '+').replace('_', '/')
        while (t.length % 4 != 0) t += "="
        val bytes = decodeBase64(t) ?: return null
        val text = String(bytes, Charsets.UTF_8)
        if (text.isEmpty()) return null
        // reject binary noise; a real path is printable
        if (text.any { it.code < 32 && it != '\t' }) return null
        return text
    }

    /** What to send as `fileName`: the decoded path when we can get one, otherwise the raw id. */
    fun fileNameFor(id: String?): String = decodeToPath(id) ?: id.orEmpty()

    @android.annotation.SuppressLint("NewApi") // API 24-25 fall back to android.util.Base64 below
    private fun decodeBase64(s: String): ByteArray? = try {
        java.util.Base64.getDecoder().decode(s)
    } catch (_: Throwable) {
        // java.util.Base64 needs API 26; fall back to android.util.Base64 on 24/25
        try {
            val cls = Class.forName("android.util.Base64")
            val m = cls.getMethod("decode", String::class.java, Int::class.javaPrimitiveType)
            m.invoke(null, s, 0) as ByteArray
        } catch (_: Throwable) {
            null
        }
    }
}

/**
 * Building the POST /api/history/clear body, and the "remove all for this show" title rule.
 */
object HistoryClear {

    const val SCOPE_ONE = "one"
    const val SCOPE_SHOW = "show"
    const val SCOPE_ALL = "all"

    /**
     * The show half of a "Show — S1E2" title, matching the server's own rule
     * (case-insensitive comparison against either the whole stored title or its show half).
     * A movie title has no episode half and comes back unchanged.
     */
    fun showTitleOf(title: String?): String {
        val t = title?.trim().orEmpty()
        if (t.isEmpty()) return ""
        // The server's format uses an em dash; tolerate a plain hyphen too.
        for (sep in listOf(" — ", "—", " – ", " - ")) {
            val i = t.indexOf(sep)
            if (i > 0) return t.substring(0, i).trim()
        }
        return t
    }

    /** Confirmation copy, so a destructive action always says exactly what it will remove. */
    fun confirmationFor(scope: String, title: String?): String = when (scope) {
        SCOPE_ONE -> "Remove \"${title.orEmpty()}\" from your history?"
        SCOPE_SHOW -> "Remove everything for \"${showTitleOf(title)}\" from your history?"
        SCOPE_ALL -> "Clear your entire watch history? This can't be undone."
        else -> "Remove this from your history?"
    }
}

/**
 * Formatting for the Continue Watching rows: "43% · 26 min left".
 */
object ContinueFormat {

    /** 0..100, clamped. Prefers the server's rounded percent, derives one if it's missing. */
    fun percent(serverPercent: Int?, currentTimeSec: Double, durationSec: Double): Int {
        if (serverPercent != null && serverPercent in 0..100) return serverPercent
        if (durationSec <= 0.0) return 0
        return ((currentTimeSec / durationSec) * 100.0).roundToInt().coerceIn(0, 100)
    }

    /** Fraction for the progress bar. */
    fun fraction(percent: Int): Float = (percent.coerceIn(0, 100)) / 100f

    /**
     * "26 min left" / "1 hr 26 min left" / "less than a minute left".
     * Returns null when the duration is unknown, so the caller can just show the percent.
     */
    fun remainingLabel(currentTimeSec: Double, durationSec: Double): String? {
        if (durationSec <= 0.0) return null
        val remainingSec = durationSec - currentTimeSec
        if (remainingSec <= 0.0) return "finished"
        if (remainingSec < 60.0) return "less than a minute left"
        val totalMinutes = ceil(remainingSec / 60.0).toInt()
        val hours = totalMinutes / 60
        val minutes = totalMinutes % 60
        return when {
            hours <= 0 -> "$minutes min left"
            minutes == 0 -> "$hours hr left"
            else -> "$hours hr $minutes min left"
        }
    }

    /** The whole subtitle: "43% · 26 min left", or just "43%" when the duration is unknown. */
    fun subtitle(serverPercent: Int?, currentTimeSec: Double, durationSec: Double): String {
        val pct = percent(serverPercent, currentTimeSec, durationSec)
        val remaining = remainingLabel(currentTimeSec, durationSec)
        return if (remaining == null) "$pct%" else "$pct% · $remaining"
    }
}
