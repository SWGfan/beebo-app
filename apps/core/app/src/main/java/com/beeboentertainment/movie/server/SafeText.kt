package com.beeboentertainment.movie.server

/**
 * Everything the server sends that ends up on screen (channel names, book titles, chat lines,
 * show notes, station names) goes through here first. Compose draws text as text - nothing here
 * is ever parsed as markup - so this is about hiding and reordering tricks: control characters,
 * bidirectional overrides, zero-width characters, and absurd lengths. The same set the server
 * strips from watch-together names and chat, so what is shown matches what was meant.
 */
object SafeText {

    /** Control, bidi override / isolate, zero-width, soft hyphen, BOM and the like. */
    private val INVISIBLE = Regex(
        "[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF\\uFFF9-\\uFFFB]"
    )
    private val WHITESPACE = Regex("\\s+")

    /** One line of text: invisible characters become spaces, runs of space collapse, capped at [max] characters. */
    fun clean(value: String?, max: Int = 200): String {
        var s = value ?: return ""
        if (s.length > max * 4) s = s.substring(0, max * 4)
        s = INVISIBLE.replace(s, " ")
        s = WHITESPACE.replace(s, " ").trim()
        return capCodePoints(s, max)
    }

    /** Longer text with line breaks kept (show notes, a book description): blank runs collapse, capped at [max]. */
    fun paragraphs(value: String?, max: Int = 4000): String {
        var s = value ?: return ""
        if (s.length > max * 4) s = s.substring(0, max * 4)
        s = s.replace("\r\n", "\n").replace('\r', '\n')
        s = Regex("[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF\\uFFF9-\\uFFFB]").replace(s, " ")
        s = s.lines().joinToString("\n") { WHITESPACE.replace(it, " ").trim() }
        s = Regex("\n{3,}").replace(s, "\n\n").trim()
        return capCodePoints(s, max)
    }

    private fun capCodePoints(s: String, max: Int): String {
        if (max <= 0) return ""
        if (s.codePointCount(0, s.length) <= max) return s
        val end = s.offsetByCodePoints(0, max)
        return s.substring(0, end).trim()
    }

    /** A machine code such as `tuners_busy`: lowercase letters, digits, `_` and `-` only, or empty. */
    fun code(value: String?): String {
        val s = value?.trim().orEmpty()
        return if (s.length in 1..64 && s.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '_' || it == '-' || it == '.' || it == ':' }) s else ""
    }

    /**
     * Show notes arrive as HTML the server already sanitised. The app shows them as plain text
     * anyway (no WebView, no rendering of markup, nothing to click): tags go, block tags become
     * line breaks, a few entities are decoded once.
     */
    fun htmlToText(html: String?, max: Int = 4000): String {
        var s = html ?: return ""
        if (s.length > max * 6) s = s.substring(0, max * 6)
        s = Regex("(?is)<(script|style|iframe|object|svg)\\b.*?</\\1\\s*>").replace(s, " ")
        s = Regex("(?i)<br\\s*/?>|</p\\s*>|</li\\s*>|</h[1-6]\\s*>|</div\\s*>").replace(s, "\n")
        s = Regex("(?i)<li[^>]*>").replace(s, "• ")
        s = Regex("<[^>]*>").replace(s, "")
        s = decodeEntities(s)
        return paragraphs(s, max)
    }

    /** One pass, so "&amp;lt;" becomes the text "&lt;" and not "<" (decoded once, never twice). */
    private fun decodeEntities(s: String): String {
        val named = mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ")
        return Regex("&(#\\d{1,6}|[a-z]{2,6});").replace(s) { m ->
            val ref = m.groupValues[1]
            if (ref.startsWith("#")) {
                val cp = ref.substring(1).toIntOrNull()
                if (cp != null && cp in 32..0x10FFFF && cp !in 0xD800..0xDFFF) String(Character.toChars(cp)) else " "
            } else {
                named[ref] ?: m.value
            }
        }
    }

    /**
     * An address from outside (a podcast's artwork, a station's logo). Only https is loaded: those
     * come from third-party hosts, and a plain-http image would be readable and changeable on the
     * way. No credentials in the address, and a sane length.
     */
    fun httpsUrlOrNull(value: String?): String? {
        val s = value?.trim().orEmpty()
        if (s.length !in 9..1000) return null
        if (!s.startsWith("https://", ignoreCase = true)) return null
        if (s.any { it.isWhitespace() || it.code < 32 }) return null
        val authority = s.substring(8).substringBefore('/').substringBefore('?').substringBefore('#')
        if (authority.isEmpty() || authority.contains('@')) return null
        return s
    }

    /**
     * A server-relative path the app may join onto its own address and send the bearer token to:
     * it must start with one of [prefixes], with no scheme, no second slash, no `..`, no control
     * characters. Anything else is dropped rather than followed, so a hostile or broken server
     * answer can never point the token at another host.
     */
    fun serverPathOrNull(value: String?, vararg prefixes: String): String? {
        val s = value?.trim().orEmpty()
        if (s.isEmpty() || s.length > 1500) return null
        if (!s.startsWith("/") || s.startsWith("//") || s.contains("\\")) return null
        if (s.any { it.code < 32 || it == ' ' }) return null
        val pathOnly = s.substringBefore('?').substringBefore('#')
        if (pathOnly.split('/').any { it == ".." || it == "." }) return null
        if (prefixes.isNotEmpty() && prefixes.none { s.startsWith(it) }) return null
        return s
    }
}
