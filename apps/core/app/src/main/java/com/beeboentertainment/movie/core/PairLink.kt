package com.beeboentertainment.movie.core

/**
 * The link a Beebo computer shows as a QR code, and the phone reads:
 *
 *     beebo://pair?server=<host:port>&name=<house name>
 *
 * It only PRE-FILLS the sign-in screen. Reading a link never signs anyone in, never sends anything
 * and never stores anything; the person still types their own username and password. Because a QR
 * code can be printed by anybody, a link that points outside the home network is flagged
 * ([ServerTrust.OTHER]) so the screen asks before using it. Documented in docs/pairing-link.md.
 *
 * The plain address older Beebo versions showed (http://host:port) and a bare host:port pasted from
 * the clipboard are accepted too. No Android types here, so every rule has a JVM test (PairLinkTest).
 */
data class PairLink(
    /** host or host:port, ready to type into Home. */
    val server: String,
    /** The `name` in name.beebo.tv, when the computer has one. */
    val houseName: String?,
    val trust: ServerTrust,
)

enum class ServerTrust {
    /** A private address or a .local name: this is a computer in a home. */
    HOME_NETWORK,
    /** name.beebo.tv */
    BEEBO_TV,
    /** Anything else. Ask first. */
    OTHER,
}

enum class PairProblem {
    /** Not a pairing link at all (some other text). */
    NOT_A_PAIR_LINK,
    MALFORMED,
    MISSING_SERVER,
    BAD_SERVER,
    BAD_NAME,
    TOO_LONG,
}

sealed interface PairParse {
    data class Ok(val link: PairLink) : PairParse
    data class Rejected(val problem: PairProblem) : PairParse
}

object PairLinks {
    const val PREFIX = "beebo://pair"
    const val MAX_LENGTH = 300

    private val HOSTNAME_LABEL = Regex("""^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$""")
    private val HOUSE_NAME = Regex("""^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$""")
    private val HOME_SUFFIXES = listOf(".local", ".lan", ".home.arpa", ".internal")

    /** Anything the phone might be handed: an intent's data, a scanned QR text, pasted text. */
    fun parse(raw: String?): PairParse {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return PairParse.Rejected(PairProblem.NOT_A_PAIR_LINK)
        if (text.length > MAX_LENGTH) return PairParse.Rejected(PairProblem.TOO_LONG)
        if (text.any { it.isISOControl() || it.isWhitespace() }) return PairParse.Rejected(PairProblem.MALFORMED)

        return when {
            text.startsWith(PREFIX, ignoreCase = true) -> parsePairScheme(text)
            text.startsWith("http://", ignoreCase = true) || text.startsWith("https://", ignoreCase = true) -> parseServer(text, null)
            looksLikeHostPort(text) -> parseServer(text, null)
            else -> PairParse.Rejected(PairProblem.NOT_A_PAIR_LINK)
        }
    }

    // Bare host:port pasted from the clipboard: an IPv4 address, a dotted name, or a bracketed IPv6 address.
    // A one-word name needs the full link, so ordinary text such as "tel:123" is never taken for an address.
    private val BARE_HOST_PORT = Regex("""^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|\[[0-9A-Fa-f:.]+\]):\d{1,5}$""")
    private fun looksLikeHostPort(s: String) = BARE_HOST_PORT.matches(s)

    private fun parsePairScheme(text: String): PairParse {
        val rest = text.substring(PREFIX.length)
        // beebo://pair, beebo://pair/, beebo://pair?..., never beebo://pairing or beebo://pair.evil
        if (rest.isNotEmpty() && rest[0] != '?' && rest[0] != '/') return PairParse.Rejected(PairProblem.NOT_A_PAIR_LINK)
        val afterPath = rest.trimStart('/')
        if (afterPath.isNotEmpty() && afterPath[0] != '?') return PairParse.Rejected(PairProblem.MALFORMED)
        val query = afterPath.removePrefix("?").substringBefore('#')
        if (query.isEmpty()) return PairParse.Rejected(PairProblem.MISSING_SERVER)

        val params = HashMap<String, String>()
        for (pair in query.split('&')) {
            if (pair.isEmpty()) continue
            val key = decode(pair.substringBefore('=')) ?: return PairParse.Rejected(PairProblem.MALFORMED)
            val value = decode(pair.substringAfter('=', "")) ?: return PairParse.Rejected(PairProblem.MALFORMED)
            val k = key.lowercase()
            // The same field twice is ambiguous, and a classic way to smuggle a second address past a check.
            if ((k == "server" || k == "name") && params.containsKey(k)) return PairParse.Rejected(PairProblem.MALFORMED)
            params[k] = value
        }
        val server = params["server"]?.takeIf { it.isNotEmpty() } ?: return PairParse.Rejected(PairProblem.MISSING_SERVER)
        val nameRaw = params["name"]
        val name = if (nameRaw == null || nameRaw.isEmpty()) null else cleanHouseName(nameRaw) ?: return PairParse.Rejected(PairProblem.BAD_NAME)
        return parseServer(server, name)
    }

    private fun parseServer(serverRaw: String, name: String?): PairParse {
        var s = serverRaw
        if (s.startsWith("http://", ignoreCase = true)) s = s.substring(7)
        else if (s.startsWith("https://", ignoreCase = true)) s = s.substring(8)
        s = s.trimEnd('/')
        if (s.isEmpty() || s.any { it == '/' || it == '?' || it == '#' || it == '@' || it == '\\' || it == '%' }) {
            return PairParse.Rejected(PairProblem.BAD_SERVER)
        }
        val (host, port) = splitHostPort(s) ?: return PairParse.Rejected(PairProblem.BAD_SERVER)
        if (port != null && port !in 1..65535) return PairParse.Rejected(PairProblem.BAD_SERVER)
        val trust = classifyHost(host) ?: return PairParse.Rejected(PairProblem.BAD_SERVER)
        val houseFromHost = if (trust == ServerTrust.BEEBO_TV) host.lowercase().removeSuffix(".beebo.tv") else null
        val display = if (host.contains(':')) "[$host]" else host
        return PairParse.Ok(PairLink(if (port != null) "$display:$port" else display, name ?: houseFromHost, trust))
    }

    private fun splitHostPort(s: String): Pair<String, Int?>? {
        if (s.startsWith("[")) {
            val close = s.indexOf(']')
            if (close < 0) return null
            val host = s.substring(1, close)
            val tail = s.substring(close + 1)
            if (tail.isEmpty()) return host to null
            if (!tail.startsWith(":")) return null
            val port = tail.substring(1).toIntOrNull() ?: return null
            return host to port
        }
        val colon = s.lastIndexOf(':')
        if (colon < 0) return s to null
        // a second colon in an unbracketed name is a bare IPv6 address, which needs brackets here
        if (s.indexOf(':') != colon) return null
        val portText = s.substring(colon + 1)
        if (portText.isEmpty() || portText.length > 5 || !portText.all { it in '0'..'9' }) return null
        return s.substring(0, colon) to portText.toInt()
    }

    /** null = not a usable host at all. */
    internal fun classifyHost(host: String): ServerTrust? {
        if (host.isEmpty() || host.length > 253) return null
        parseIpv4(host)?.let { return if (isPrivateV4(it)) ServerTrust.HOME_NETWORK else ServerTrust.OTHER }
        if (host.contains(':')) {
            // IPv6 literal: only characters an address can have
            if (!host.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' || it == ':' || it == '.' }) return null
            val h = host.lowercase()
            return if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb") || h.startsWith("fc") || h.startsWith("fd")) ServerTrust.HOME_NETWORK else ServerTrust.OTHER
        }
        // a dotted-number host that failed IPv4 parsing ("999.1.1.1", "1.2.3") is not a name either
        if (host.all { it in '0'..'9' || it == '.' }) return null
        val labels = host.trimEnd('.').split('.')
        if (labels.any { !HOSTNAME_LABEL.matches(it) }) return null
        val lower = host.lowercase().trimEnd('.')
        if (lower.endsWith(".beebo.tv")) {
            val label = lower.removeSuffix(".beebo.tv")
            return if (label.isNotEmpty() && !label.contains('.') && label != "www") ServerTrust.BEEBO_TV else ServerTrust.OTHER
        }
        if (HOME_SUFFIXES.any { lower.endsWith(it) }) return ServerTrust.HOME_NETWORK
        // A bare one-label name ("mypc") only resolves on a home network.
        if (!lower.contains('.')) return ServerTrust.HOME_NETWORK
        return ServerTrust.OTHER
    }

    private fun parseIpv4(s: String): IntArray? {
        val parts = s.split('.')
        if (parts.size != 4) return null
        val out = IntArray(4)
        for (i in 0..3) {
            val p = parts[i]
            if (p.isEmpty() || p.length > 3 || !p.all { it in '0'..'9' }) return null
            val n = p.toInt()
            if (n > 255) return null
            out[i] = n
        }
        return out
    }

    private fun isPrivateV4(a: IntArray): Boolean =
        a[0] == 10 ||
            (a[0] == 172 && a[1] in 16..31) ||
            (a[0] == 192 && a[1] == 168) ||
            (a[0] == 169 && a[1] == 254) ||
            // 100.64/10: carrier-grade NAT space, which is what Tailscale and similar private networks use
            (a[0] == 100 && a[1] in 64..127)

    private fun cleanHouseName(raw: String): String? {
        val s = raw.trim().lowercase().removeSuffix(".beebo.tv")
        return if (HOUSE_NAME.matches(s)) s else null
    }

    /** Strict percent-decoding (UTF-8). null on a bad escape or bytes that are not UTF-8. */
    private fun decode(s: String): String? {
        if (!s.contains('%') && !s.contains('+')) return s
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '%' -> {
                    if (i + 2 >= s.length) return null
                    val hi = Character.digit(s[i + 1], 16)
                    val lo = Character.digit(s[i + 2], 16)
                    if (hi < 0 || lo < 0) return null
                    out.write(hi * 16 + lo)
                    i += 3
                }
                c == '+' -> { out.write(' '.code); i++ }
                c.code < 0x80 -> { out.write(c.code); i++ }
                else -> {
                    val bytes = c.toString().toByteArray(Charsets.UTF_8)
                    out.write(bytes, 0, bytes.size); i++
                }
            }
        }
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        return try {
            val text = decoder.decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString()
            if (text.any { it.isISOControl() }) null else text
        } catch (e: java.nio.charset.CharacterCodingException) {
            null
        }
    }
}

/** What the sign-in screen says about a link before using it. */
object PairMessages {
    fun problem(p: PairProblem): String = when (p) {
        PairProblem.NOT_A_PAIR_LINK -> "That is not a Beebo connection code. Scan the code shown in Beebo on your computer."
        PairProblem.TOO_LONG -> "That code is too long to be a Beebo connection code."
        PairProblem.MISSING_SERVER -> "That code does not say which computer to connect to."
        PairProblem.BAD_SERVER, PairProblem.MALFORMED, PairProblem.BAD_NAME ->
            "That code looks damaged. Show the code in Beebo on your computer again and scan it once more."
    }

    /** Non-null when the person must agree before the link is used. */
    fun confirmation(link: PairLink): String? =
        if (link.trust == ServerTrust.OTHER) {
            "This code points to ${link.server}, which is not on your home network and not a beebo.tv address. " +
                "Only continue if you trust whoever gave you this code, because you will type your password for it."
        } else null
}
