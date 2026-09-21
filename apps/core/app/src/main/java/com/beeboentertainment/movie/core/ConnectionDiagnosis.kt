package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.rtc.NetworkKind

/**
 * "Can't connect?" on the phone, as pure decisions (ConnectionDiagnosisTest). The Android side only
 * gathers [DoctorFacts] (ui/screens/ConnectionHelpScreen.kt, data/ConnectionProbe.kt); what they MEAN,
 * and what to tell the person, is decided here.
 *
 * It sticks to what a phone can honestly know: is it online, on Wi-Fi or mobile data, on the same
 * network as the computer, can the name be found, does the computer answer, and which kind of
 * failure it was. Whether the computer's firewall or router is at fault is the computer's own
 * "Can't connect? Fix it for me"; the steps say so.
 */
enum class FailureClass {
    TIMEOUT, REFUSED, UNREACHABLE, DNS, CERTIFICATE, CLEARTEXT_BLOCKED, UNAUTHORIZED, NOT_BEEBO, SERVER_ERROR, OFFLINE, UNKNOWN
}

object ConnectionErrors {
    /** Walks the cause chain (OkHttp wraps the original) and names the kind of failure. */
    fun classify(t: Throwable?): FailureClass {
        var cur: Throwable? = t
        var hops = 0
        val text = StringBuilder()
        while (cur != null && hops < 8) {
            when (cur) {
                is java.net.UnknownHostException -> return FailureClass.DNS
                is javax.net.ssl.SSLException, is java.security.cert.CertificateException -> return FailureClass.CERTIFICATE
                is java.net.NoRouteToHostException -> return FailureClass.UNREACHABLE
                is java.net.SocketTimeoutException -> return FailureClass.TIMEOUT
            }
            cur.message?.let { text.append(it).append(' ') }
            cur = cur.cause
            hops++
        }
        val m = text.toString()
        return when {
            t is java.io.InterruptedIOException && m.contains("timeout", true) -> FailureClass.TIMEOUT
            else -> classifyMessage(m).let { if (it == FailureClass.UNKNOWN && t is java.net.ConnectException) FailureClass.REFUSED else it }
        }
    }

    /** For failures that only survive as a message (the app's own friendly text, or a system string). */
    fun classifyMessage(message: String?): FailureClass {
        val m = message.orEmpty()
        return when {
            m.contains("CLEARTEXT", true) || m.contains("Plain HTTP was blocked", true) -> FailureClass.CLEARTEXT_BLOCKED
            m.contains("Unable to resolve host", true) || m.contains("can't be found", true) || m.contains("UnknownHost", true) -> FailureClass.DNS
            m.contains("certificate", true) || m.contains("SSLHandshake", true) || m.contains("Trust anchor", true) -> FailureClass.CERTIFICATE
            m.contains("ECONNREFUSED", true) || m.contains("refused", true) || m.contains("Can't reach the server", true) -> FailureClass.REFUSED
            m.contains("EHOSTUNREACH", true) || m.contains("ENETUNREACH", true) || m.contains("No route to host", true) || m.contains("unreachable", true) -> FailureClass.UNREACHABLE
            m.contains("timed out", true) || m.contains("timeout", true) || m.contains("did not respond in time", true) || m.contains("ETIMEDOUT", true) -> FailureClass.TIMEOUT
            else -> FailureClass.UNKNOWN
        }
    }

    /** null = the answer was fine. */
    fun classifyHttp(code: Int): FailureClass? = when (code) {
        in 200..399 -> null
        401, 403 -> FailureClass.UNAUTHORIZED
        404, 405, 410 -> FailureClass.NOT_BEEBO
        in 500..599 -> FailureClass.SERVER_ERROR
        else -> FailureClass.NOT_BEEBO
    }
}

/** The phone's own address on its network: an IPv4 address and prefix length, e.g. 192.168.1.42/24. */
data class PhoneAddress(val ipv4: String, val prefixLength: Int)

sealed interface PingOutcome {
    data class Answered(val ms: Long, val httpCode: Int) : PingOutcome
    data class Failed(val kind: FailureClass) : PingOutcome
}

data class DoctorFacts(
    val network: NetworkKind,
    val phone: PhoneAddress? = null,
    /** What the person is trying to reach; null when nothing was typed yet. */
    val target: PairLink? = null,
    /** null = not tested (an IP address needs no lookup). */
    val nameFound: Boolean? = null,
    val ping: PingOutcome? = null,
    /** The HTTP status the last sign-in got, when one was tried. */
    val lastLoginHttp: Int? = null,
)

enum class Level { OK, WARN, PROBLEM }

data class DoctorFinding(val id: String, val level: Level, val title: String, val body: String, val steps: List<String> = emptyList())

object ConnectionDoctor {
    /**
     * What the person is trying to reach, from what is in the Home box. On the home Wi-Fi with a
     * scanned address, that address; otherwise the address or name typed. An email says nothing about
     * where the computer is, so there is nothing to check but the phone itself.
     */
    fun targetFor(home: String, pairedServer: String?, network: NetworkKind): PairLink? {
        if (pairedServer != null && network == NetworkKind.LOCAL) (PairLinks.parse(pairedServer) as? PairParse.Ok)?.let { return it.link }
        return when (val e = com.beeboentertainment.movie.rtc.HomeEntry.parse(home)) {
            is com.beeboentertainment.movie.rtc.HomeEntry.Name -> (PairLinks.parse("https://${e.name}.beebo.tv") as? PairParse.Ok)?.link
            is com.beeboentertainment.movie.rtc.HomeEntry.Address -> (PairLinks.parse(e.baseUrl) as? PairParse.Ok)?.link
            else -> null
        }
    }

    /** Same network? Both must be IPv4 and inside one subnet of the phone's prefix length. */
    fun sameSubnet(phone: PhoneAddress?, serverHost: String): Boolean? {
        val p = ipv4Bits(phone?.ipv4) ?: return null
        val s = ipv4Bits(serverHost) ?: return null
        val len = phone!!.prefixLength
        if (len !in 1..32) return null
        val mask = if (len == 32) -1 else (-1 shl (32 - len))
        return (p and mask) == (s and mask)
    }

    private fun ipv4Bits(s: String?): Int? {
        val parts = s?.split('.') ?: return null
        if (parts.size != 4) return null
        var v = 0
        for (part in parts) {
            val n = part.toIntOrNull() ?: return null
            if (n !in 0..255 || part.length > 3) return null
            v = (v shl 8) or n
        }
        return v
    }

    private fun hostOf(server: String): String =
        if (server.startsWith("[")) server.substringAfter('[').substringBefore(']') else server.substringBeforeLast(':', server)

    private val FIX_ON_PC = "On the computer, open Beebo and press “Can’t connect? Fix it for me”."

    fun diagnose(f: DoctorFacts): List<DoctorFinding> {
        val out = ArrayList<DoctorFinding>()
        val target = f.target
        val host = target?.let { hostOf(it.server) }

        if (f.network == NetworkKind.NONE) {
            out += DoctorFinding(
                "online", Level.PROBLEM, "This phone is not online",
                "It has no Wi-Fi or mobile data connection right now.",
                listOf("Turn on Wi-Fi, or mobile data, in your phone’s settings.", "Turn off Airplane mode if it is on."),
            )
            return out
        }
        out += DoctorFinding(
            "online", Level.OK,
            if (f.network == NetworkKind.LOCAL) "The phone is on Wi-Fi" else "The phone is on mobile data",
            if (f.network == NetworkKind.LOCAL) "It is connected to a Wi-Fi or cable network." else "It is not on Wi-Fi.",
        )
        if (target == null) return out

        val local = target.trust == ServerTrust.HOME_NETWORK
        if (local && f.network == NetworkKind.OTHER) {
            out += DoctorFinding(
                "wifi", Level.PROBLEM, "This address only works on your home Wi-Fi",
                "You are on mobile data, and ${target.server} is a computer inside a home network.",
                listOf("Turn on Wi-Fi and join the same Wi-Fi as your Beebo computer.", "Away from home, sign in with your home’s name (like thesmiths) instead of a number."),
            )
        }
        if (local && f.network == NetworkKind.LOCAL && host != null) {
            when (sameSubnet(f.phone, host)) {
                false -> out += DoctorFinding(
                    "subnet", Level.PROBLEM, "The phone looks to be on a different network",
                    "The phone is at ${f.phone?.ipv4} and the computer is at $host. Those are different networks, so they cannot see each other.",
                    listOf(
                        "Join the same Wi-Fi as the computer. A “guest” network, or a second router or Wi-Fi extender, is a different network.",
                        "If the computer is on a cable, it must be plugged into the same router as the Wi-Fi.",
                    ),
                )
                true -> out += DoctorFinding("subnet", Level.OK, "Same network as the computer", "The phone and the computer are on the same network.")
                null -> {}
            }
        }
        if (f.nameFound == false) {
            out += DoctorFinding(
                "dns", Level.PROBLEM, "The address cannot be found",
                "This phone could not look up ${if (target.trust == ServerTrust.OTHER) "that name" else host.orEmpty()}.",
                if (target.trust == ServerTrust.BEEBO_TV) listOf("Check the phone’s internet connection.", "Check the spelling of your home’s name.")
                else listOf("Check the address for typing mistakes.", "Names ending in .local often do not work on Android. Use the numbers shown in Beebo on the computer, like 192.168.1.20:47811."),
            )
        } else if (f.nameFound == true) {
            out += DoctorFinding("dns", Level.OK, "The address was found", "The name resolved to an address.")
        }

        f.ping?.let { p ->
            when (p) {
                is PingOutcome.Answered -> {
                    val bad = ConnectionErrors.classifyHttp(p.httpCode)
                    if (bad == null || target.trust == ServerTrust.BEEBO_TV) {
                        out += if (target.trust == ServerTrust.BEEBO_TV) DoctorFinding(
                            "server", Level.OK, "Beebo’s service answered (${p.ms} ms)",
                            "The phone can reach beebo.tv. If signing in still fails, the computer at home may be off, asleep, or not set up for watching away from home.",
                            listOf("Make sure the computer at home is on and Beebo is open.", FIX_ON_PC),
                        ) else DoctorFinding("server", Level.OK, "The computer answered (${p.ms} ms)", "Beebo on the computer is reachable from this phone.")
                    } else out += failure(bad, target, p.httpCode)
                }
                is PingOutcome.Failed -> if (!(p.kind == FailureClass.DNS && f.nameFound == false)) out += failure(p.kind, target, null)
            }
        }
        if (f.lastLoginHttp == 401 || f.lastLoginHttp == 403) {
            out += DoctorFinding(
                "login", Level.PROBLEM, "The computer answered, but the sign-in was refused",
                "The username or password did not match.",
                listOf("Tap “Show password” to check what you typed.", "Ask whoever runs Beebo to check your username, or to set a new password for you."),
            )
        }
        return out
    }

    private fun failure(kind: FailureClass, target: PairLink, http: Int?): DoctorFinding {
        val local = target.trust != ServerTrust.BEEBO_TV
        return when (kind) {
            FailureClass.REFUSED -> DoctorFinding(
                "server", Level.PROBLEM, "The computer is there, but Beebo is not answering",
                "The computer refused the connection, which usually means Beebo is not running or the port number is wrong.",
                listOf("On the computer, open Beebo and wait until it is running.", FIX_ON_PC, "Check the number after the colon matches the one shown in Beebo."),
            )
            FailureClass.TIMEOUT -> DoctorFinding(
                "server", Level.PROBLEM, if (local) "The computer did not answer" else "Beebo did not answer in time",
                if (local) "Nothing came back. The computer may be off or asleep, on another network, or its firewall is blocking phones."
                else "The phone reached Beebo’s service, but your computer at home did not answer.",
                listOf("Wake the computer up, and make sure Beebo is open.", if (local) "Join the same Wi-Fi as the computer." else "Check the computer at home has internet.", FIX_ON_PC),
            )
            FailureClass.UNREACHABLE -> DoctorFinding(
                "server", Level.PROBLEM, "There is no way to get to that address",
                "The phone has no route to it. It is probably on a different network from the computer.",
                listOf("Join the same Wi-Fi as the computer, not a guest network.", "Turn off any VPN on the phone."),
            )
            FailureClass.DNS -> DoctorFinding(
                "dns", Level.PROBLEM, "The address cannot be found", "The name did not resolve.",
                listOf("Check the address for typing mistakes.", "Check the phone’s internet connection."),
            )
            FailureClass.CERTIFICATE -> DoctorFinding(
                "secure", Level.PROBLEM, "The secure connection failed",
                "The phone did not trust the computer’s security certificate.",
                listOf("Turn on “Set time automatically” in the phone’s date and time settings. A wrong date breaks secure connections.", "Turn off any VPN or web filter on the phone or the Wi-Fi.", "If it still fails, use the numbers shown in Beebo instead of a name."),
            )
            FailureClass.CLEARTEXT_BLOCKED -> DoctorFinding(
                "secure", Level.PROBLEM, "Android blocked a plain connection",
                "Android does not allow an unencrypted connection to that address.",
                listOf("Use your home’s name (like thesmiths) instead of an address, or update the Beebo app."),
            )
            FailureClass.UNAUTHORIZED -> DoctorFinding(
                "login", Level.PROBLEM, "The computer refused the sign-in", "The username or password did not match.",
                listOf("Tap “Show password” to check what you typed.", "Ask whoever runs Beebo to check your username."),
            )
            FailureClass.NOT_BEEBO -> DoctorFinding(
                "server", Level.PROBLEM, "That address answered, but it is not Beebo${http?.let { " (code $it)" } ?: ""}",
                "Something else is at that address, or the port number is wrong.",
                listOf("Check the address and the number after the colon against what Beebo shows on the computer."),
            )
            FailureClass.SERVER_ERROR -> DoctorFinding(
                "server", Level.PROBLEM, "Beebo on the computer had an error${http?.let { " (code $it)" } ?: ""}",
                "The computer answered with an error instead of the library.",
                listOf("Restart Beebo on the computer, then try again.", FIX_ON_PC),
            )
            FailureClass.OFFLINE -> DoctorFinding("online", Level.PROBLEM, "This phone is not online", "There is no connection.", listOf("Turn on Wi-Fi or mobile data."))
            FailureClass.UNKNOWN -> DoctorFinding(
                "server", Level.PROBLEM, "Something went wrong reaching the computer", "The phone could not tell what.",
                listOf("Try again in a moment.", FIX_ON_PC),
            )
        }
    }

    /** The one line at the top. */
    fun headline(findings: List<DoctorFinding>): String {
        val problem = findings.firstOrNull { it.level == Level.PROBLEM }
        val warn = findings.firstOrNull { it.level == Level.WARN }
        return when {
            problem != null -> problem.title
            warn != null -> warn.title
            findings.isEmpty() -> "Nothing to check yet"
            else -> "Everything on this phone looks fine"
        }
    }

    /**
     * Text the person can copy and send. It names what was found, never a password, token or
     * username, and it hides an address that is not a home or beebo.tv address.
     */
    fun report(f: DoctorFacts, findings: List<DoctorFinding>, appVersion: String, androidVersion: String): String {
        val t = f.target
        val where = when (t?.trust) {
            null -> "not entered"
            ServerTrust.HOME_NETWORK -> "a home-network address (${t.server})"
            ServerTrust.BEEBO_TV -> "a beebo.tv address"
            ServerTrust.OTHER -> "another address (hidden)"
        }
        val sb = StringBuilder()
        sb.append("Beebo phone connection report\n")
        sb.append("App version: ").append(appVersion).append('\n')
        sb.append("Android: ").append(androidVersion).append('\n')
        sb.append("Phone network: ").append(when (f.network) { NetworkKind.LOCAL -> "Wi-Fi or cable"; NetworkKind.OTHER -> "mobile data"; NetworkKind.NONE -> "offline" }).append('\n')
        sb.append("Trying to reach: ").append(where).append('\n')
        f.nameFound?.let { sb.append("Name found: ").append(if (it) "yes" else "no").append('\n') }
        f.ping?.let {
            sb.append("Answer: ").append(when (it) { is PingOutcome.Answered -> "HTTP ${it.httpCode} in ${it.ms} ms"; is PingOutcome.Failed -> it.kind.name }).append('\n')
        }
        f.lastLoginHttp?.let { sb.append("Last sign-in answer: HTTP ").append(it).append('\n') }
        sb.append("Result: ").append(headline(findings)).append('\n')
        for (x in findings) sb.append("- [").append(x.level.name).append("] ").append(x.title).append('\n')
        return sb.toString()
    }
}
