package com.beeboentertainment.movie.rtc

import com.beeboentertainment.movie.core.UrlUtils
import java.net.URI

/**
 * The decisions behind away-from-home, kept free of Android so each has a JVM test
 * (RemoteRulesTest). The Android pieces (RemoteAccess, the player, the cast button) only ask.
 */

/** How long to wait before reconnect attempt [attempt] (1-based). */
object ReconnectBackoff {
    /** A dropped connection is retried at once; then 1, 2, 4, 8, 15, 30, 30... seconds. */
    private val STEPS_MS = longArrayOf(0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000)

    /** How long a first connection or a reconnect may take before the user is told plainly. */
    const val HONEST_FAILURE_MS = 25_000L

    /** How long a request waits for a tunnel that is reconnecting before it fails. */
    const val REQUEST_WAIT_MS = 25_000L

    fun delayMs(attempt: Int, jitter: Double = 0.0): Long {
        val base = STEPS_MS[(attempt - 1).coerceIn(0, STEPS_MS.size - 1)]
        // Up to +/-20%, so a house full of phones doesn't retry in lockstep.
        return (base * (1.0 + jitter.coerceIn(-1.0, 1.0) * 0.2)).toLong().coerceAtLeast(0)
    }

    /** A network change is a fresh start: a new path may work at once, so the count resets. */
    fun attemptAfterNetworkChange(): Int = 1
}

/** Wi-Fi or Ethernet (possibly home), something else (mobile data), or nothing. */
enum class NetworkKind { LOCAL, OTHER, NONE }

/** Where this app's server traffic goes right now. */
sealed class Route {
    /** The saved address is a normal server address: no tunnel involved. */
    data object Plain : Route()

    /** At home: the saved address is name.beebo.tv, but the computer's own address answers. */
    data class Direct(val name: String, val directBaseUrl: String) : Route()

    /** Away: everything goes through the peer-to-peer tunnel. */
    data class Tunnel(val name: String) : Route()
}

/**
 * The switching rule, at home vs away:
 *
 *  1. An address that isn't `name.beebo.tv` is used as it always was ([Route.Plain]).
 *  2. For `name.beebo.tv`, the app uses the home computer's own address ([Route.Direct]) only
 *     when ALL of these hold: it knows one (the address this phone last connected to directly,
 *     saved when the user switched to name.beebo.tv, or typed at home later); the phone is on
 *     Wi-Fi or Ethernet; the phone is signed in; and a GET /api/me to that address, with this
 *     phone's token, answered within [LAN_PROBE_TIMEOUT_MS] as the SAME user id. That last check
 *     is what proves it is this house's computer and not a similar address on someone else's
 *     network.
 *  3. Otherwise [Route.Tunnel].
 *
 * The answer is re-checked whenever the phone's network changes and at most every
 * [LAN_RECHECK_MS] while on the tunnel, so arriving home moves new requests to the faster
 * direct path within a minute, and leaving moves them back at the next network change.
 * A request already streaming finishes on the path it started on.
 */
object RouteRule {
    const val LAN_PROBE_TIMEOUT_MS = 1_500L
    const val LAN_RECHECK_MS = 60_000L

    fun shouldProbeLan(directBaseUrl: String?, network: NetworkKind, signedIn: Boolean): Boolean =
        !directBaseUrl.isNullOrBlank() && network == NetworkKind.LOCAL && signedIn &&
            UrlUtils.beeboTvName(directBaseUrl) == null

    fun decide(
        baseUrl: String?,
        directBaseUrl: String?,
        network: NetworkKind,
        signedIn: Boolean,
        lanAnsweredAsSameUser: Boolean,
    ): Route {
        val name = UrlUtils.beeboTvName(baseUrl) ?: return Route.Plain
        if (shouldProbeLan(directBaseUrl, network, signedIn) && lanAnsweredAsSameUser) {
            return Route.Direct(name, UrlUtils.normalizeBaseUrl(directBaseUrl)!!)
        }
        return Route.Tunnel(name)
    }

    /** Does this request belong on the tunnel for [name]? Signalling (`/rtc/`) never does. */
    fun isTunnelUrl(url: String, name: String): Boolean {
        val uri = runCatching { URI(url) }.getOrNull() ?: return false
        val host = uri.host?.lowercase()?.trimEnd('.') ?: return false
        if (host != "$name.beebo.tv") return false
        val path = uri.rawPath.orEmpty()
        return !path.startsWith("/rtc/") && path != "/__sw.js"
    }

    /** The same request aimed at the home computer's own address. */
    fun rewriteToDirect(url: String, directBaseUrl: String): String? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        val base = UrlUtils.normalizeBaseUrl(directBaseUrl) ?: return null
        val pathAndQuery = uri.rawPath.orEmpty().ifEmpty { "/" } +
            (uri.rawQuery?.let { "?$it" } ?: "") +
            (uri.rawFragment?.let { "#$it" } ?: "")
        return base + pathAndQuery
    }

    /** Path plus query, which is all that travels over the tunnel. */
    fun tunnelPath(url: String): String {
        val uri = runCatching { URI(url) }.getOrNull() ?: return "/"
        return uri.rawPath.orEmpty().ifEmpty { "/" } + (uri.rawQuery?.let { "?$it" } ?: "")
    }
}

/**
 * The one sign-in screen's order of attempts, for what was typed in Home.
 *
 *  - A server address (an IP, a host and port): straight to that computer, as always.
 *  - A name or the paying account's email, on Wi-Fi or Ethernet, when the app already knows the
 *    home computer's own address: try that first with the same username and password (at home,
 *    no internet service involved, and faster), then away from home through beebo.tv.
 *  - Otherwise: through beebo.tv.
 * The owner's link (account email and account password) always goes through beebo.tv: that
 * password belongs to beebo.tv, not to the home computer.
 */
object SignInPlan {
    sealed class Step {
        data class Direct(val baseUrl: String) : Step()
        data object Remote : Step()
    }

    fun steps(entry: HomeEntry, directBaseUrl: String?, network: NetworkKind): List<Step> = when (entry) {
        is HomeEntry.Invalid -> emptyList()
        is HomeEntry.Address -> listOf(Step.Direct(entry.baseUrl))
        is HomeEntry.Name, is HomeEntry.Email -> {
            val direct = UrlUtils.normalizeBaseUrl(directBaseUrl)?.takeIf { UrlUtils.beeboTvName(it) == null }
            if (direct != null && network == NetworkKind.LOCAL) listOf(Step.Direct(direct), Step.Remote) else listOf(Step.Remote)
        }
    }
}

/**
 * Casting and away-from-home.
 *
 * A Chromecast fetches the video itself, from the URL it is handed. Through name.beebo.tv that
 * URL only works inside this phone's tunnel, which the TV can't reach. So:
 *  - a plain server address: cast exactly as before;
 *  - name.beebo.tv at home ([Route.Direct]): cast, with the URL moved to the computer's own
 *    address, which the TV on the same Wi-Fi can reach;
 *  - name.beebo.tv away, on Wi-Fi ([Decision.ViaPhone]): the phone itself passes the video on.
 *    It runs a tiny web server on the Wi-Fi it is already on, hands the TV an address on this
 *    phone, and answers the TV by pulling the same bytes down the tunnel it already has. See
 *    com.beeboentertainment.movie.player.PhoneCastRules;
 *  - name.beebo.tv away, on mobile data or with no network: no cast button, and [NEEDS_WIFI] or
 *    [EXPLANATION] where it would be. Not a technical limit - every byte would be paid for
 *    twice, once coming to the phone and once going to the TV.
 */
object CastRule {
    const val EXPLANATION =
        "Casting works at home. Away from home, Beebo streams to this phone through your private " +
            "connection, and a TV can't join it. Watch here, or cast when you're on your home Wi-Fi."

    /** Away from home and not on Wi-Fi. Honest about why, because the reason is the phone bill. */
    const val NEEDS_WIFI =
        "Casting away from home needs Wi-Fi. Beebo would have to pass the film to the TV through " +
            "this phone, so every minute would come out of your mobile data twice. Join the Wi-Fi " +
            "the TV is on, then try again."

    /** Said once, the first time someone casts away from home, so the rules are not a surprise. */
    const val VIA_PHONE_NOTE =
        "Sent through this phone, so keep Beebo open and stay on this Wi-Fi."

    /**
     * Away from home the phone passes the film on exactly as it is. A film the TV can only play
     * once the home computer has converted it can't be cast that way, because the converted
     * stream is a playlist of small pieces rather than one file.
     */
    const val CANT_CONVERT_AWAY =
        "This one can't be sent to the TV from away from home. Your TV would need Beebo to convert " +
            "it first, and that only works on your home Wi-Fi. Watch it on the phone, or cast it at home."

    /**
     * They were already watching a converted stream when they pressed cast. The film itself can
     * go to the TV; the converted version can't, so they only have to set the quality back.
     */
    const val CANT_CAST_CONVERTED =
        "Away from home the TV gets the film as it is, so a changed quality can't be cast. " +
            "Set the quality back to Original and try again."

    /** The tunnel went while the TV was playing. */
    const val VIA_PHONE_LOST =
        "The TV stopped because the connection to your home computer dropped. Try casting again " +
            "in a moment."

    sealed class Decision {
        data object Allowed : Decision()
        data class AllowedVia(val directBaseUrl: String, val name: String) : Decision()
        /** Away from home, on Wi-Fi: this phone passes the video to the TV itself. */
        data class ViaPhone(val name: String) : Decision()
        data object Blocked : Decision()
    }

    /**
     * For callers that cannot use the phone as a middleman - the photo viewer, which casts a
     * whole album's worth of URLs rather than one item. They keep the old answer: at home yes,
     * away no.
     */
    fun decide(route: Route): Decision = decide(route, NetworkKind.OTHER, phoneCanRelay = false)

    /**
     * [phoneCanRelay] is "this phone has a Wi-Fi address a TV could reach, and can run the little
     * server". [network] must be [NetworkKind.LOCAL] as well: on mobile data the answer is no
     * however capable the phone is.
     */
    fun decide(route: Route, network: NetworkKind, phoneCanRelay: Boolean): Decision = when (route) {
        is Route.Plain -> Decision.Allowed
        is Route.Direct -> Decision.AllowedVia(route.directBaseUrl, route.name)
        is Route.Tunnel ->
            if (phoneCanRelay && network == NetworkKind.LOCAL) Decision.ViaPhone(route.name)
            else Decision.Blocked
    }

    /** What to say where the cast button would have been. */
    fun blockedExplanation(network: NetworkKind): String =
        if (network == NetworkKind.LOCAL) EXPLANATION else NEEDS_WIFI

    /** The heading above [blockedExplanation]. */
    fun blockedTitle(network: NetworkKind): String =
        if (network == NetworkKind.LOCAL) "Casting works at home" else "Casting needs Wi-Fi"

    /**
     * The URL to hand the TV, or null when this one can't be cast.
     *
     * [viaPhone] is asked only for [Decision.ViaPhone], and only for URLs that live behind the
     * tunnel: it registers the URL with the phone's own little server and gives back the address
     * on this phone that stands in for it. Anything already out on the internet (a poster on
     * TMDB) is handed over untouched - there is no point relaying what the TV can fetch itself.
     */
    fun castUrl(url: String, decision: Decision, viaPhone: (String) -> String? = { null }): String? = when (decision) {
        is Decision.Allowed -> url
        is Decision.AllowedVia ->
            if (RouteRule.isTunnelUrl(url, decision.name)) RouteRule.rewriteToDirect(url, decision.directBaseUrl) else url
        is Decision.ViaPhone ->
            if (RouteRule.isTunnelUrl(url, decision.name)) viaPhone(url) else url
        is Decision.Blocked -> null
    }
}
