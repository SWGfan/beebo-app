package com.beeboentertainment.movie.rtc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import okio.ByteString.Companion.decodeBase64

/** The viewer page's relay URL filter: turn:/turns: only, never port 53 (browsers block it). */
object RelayUrls {
    private val RE = Regex("""^turns?:[A-Za-z0-9.\-\[\]:]{3,200}(\?transport=(udp|tcp))?$""", RegexOption.IGNORE_CASE)
    fun usable(url: String): Boolean = RE.matches(url) && !Regex(""":53(\?|$)""").containsMatchIn(url)
}

/**
 * What a viewer token says about itself. Beebo tokens are `base64url(payload).base64url(sig)`;
 * the phone can't check the signature (the Worker does, on every offer) and doesn't need to -
 * it only reads when the token runs out, and whether it belongs to the owner.
 */
data class ViewerToken(val expiresAtSec: Long, val via: String) {
    /** Owner sign-in. A household pass or a member gets no owner-only relay details. */
    val isOwner: Boolean get() = via.isEmpty()

    /** Worth signing in again before offering: less than five minutes left. */
    fun isStale(nowSec: Long): Boolean = expiresAtSec <= nowSec + 300

    companion object {
        fun parse(token: String?): ViewerToken? {
            val payload = token?.substringBefore('.', "")?.takeIf { it.isNotEmpty() } ?: return null
            val std = payload.replace('-', '+').replace('_', '/')
            val padded = std + "=".repeat((4 - std.length % 4) % 4)
            val text = padded.decodeBase64()?.utf8() ?: return null
            val obj = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
            val exp = (obj["exp"] as? JsonPrimitive)?.longOrNull ?: return null
            val via = (obj["via"] as? JsonPrimitive)?.contentOrNull.orEmpty()
            return ViewerToken(exp, via)
        }
    }
}

/**
 * How this phone signs in away from home, kept (encrypted) so the tunnel can sign in again by
 * itself when its 12-hour viewer token runs out.
 *
 *  - [Kind.MEMBER]: the one sign-in screen. [home] is the house's name ("nick") or the paying
 *    account's email; [id] is the person's own home-server username and [secret] their own
 *    home-server password. Nobody in the household needs the payer's password.
 *  - [Kind.OWNER]: the "Owner sign-in" link: [home] and [id] are the Beebo account email,
 *    [secret] the account password.
 *  - [Kind.GUEST]: someone from another household opening a library shared with them: [home] is
 *    that house's name, [id] their own Beebo account email, [secret] its password. The home
 *    computer applies that share's limits.
 *  - [Kind.HOUSEHOLD]: the shared household pass (the browser page's; not offered by the app's
 *    screen, because the home server needs to know which person is watching).
 */
data class RemoteSignIn(val kind: Kind, val home: String, val id: String, val secret: String) {
    enum class Kind { OWNER, MEMBER, HOUSEHOLD, GUEST }

    /** Home was typed as an email, so the house's name comes from the Worker (/rtc/find-home). */
    val homeIsEmail: Boolean get() = kind != Kind.GUEST && home.contains('@')

    fun toJson(): String = kotlinx.serialization.json.buildJsonObject {
        put("kind", JsonPrimitive(kind.name)); put("home", JsonPrimitive(home))
        put("id", JsonPrimitive(id)); put("secret", JsonPrimitive(secret))
    }.toString()

    companion object {
        fun fromJson(s: String?): RemoteSignIn? {
            val o = runCatching { Json.parseToJsonElement(s ?: return null) as? JsonObject }.getOrNull() ?: return null
            val kind = runCatching { Kind.valueOf((o["kind"] as? JsonPrimitive)?.contentOrNull ?: "") }.getOrNull() ?: return null
            val home = (o["home"] as? JsonPrimitive)?.contentOrNull.orEmpty()
            val id = (o["id"] as? JsonPrimitive)?.contentOrNull.orEmpty()
            val secret = (o["secret"] as? JsonPrimitive)?.contentOrNull ?: return null
            if (secret.isEmpty() || home.isBlank() || (kind != Kind.HOUSEHOLD && id.isBlank())) return null
            return RemoteSignIn(kind, home, id, secret)
        }
    }
}

/** What the one sign-in screen's "Home" box holds. */
sealed class HomeEntry {
    /** A house name, however typed: nick, nick.beebo.tv, https://nick.beebo.tv/. */
    data class Name(val name: String) : HomeEntry()
    /** The paying account's email. */
    data class Email(val email: String) : HomeEntry()
    /** A server address typed the old way (an IP, a host and port): connect to it directly. */
    data class Address(val baseUrl: String) : HomeEntry()
    data object Invalid : HomeEntry()

    companion object {
        private val EMAIL = Regex("""^[^@\s]+@[^@\s]+\.[^@\s]+$""")
        private val BARE_NAME = Regex("""^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$""")

        fun parse(raw: String?): HomeEntry {
            val s = raw?.trim().orEmpty()
            if (s.isEmpty()) return Invalid
            if (EMAIL.matches(s)) return Email(s.lowercase())
            com.beeboentertainment.movie.core.UrlUtils.beeboTvName(s)?.let { return Name(it) }
            val lower = s.lowercase()
            // No dot, no colon, no slash: a name ("nick"), not a host.
            if (BARE_NAME.matches(lower) && lower != "localhost") return Name(lower)
            if (lower.contains('@')) return Invalid
            return com.beeboentertainment.movie.core.UrlUtils.normalizeBaseUrl(s)?.let { Address(it) } ?: Invalid
        }
    }
}

/** Plain-English words for everything that can go wrong signing in and connecting. */
object RemoteMessages {
    const val CONNECTION_TEST_URL = "https://www.beeboentertainment.com/will-beebo-work.html"

    /**
     * Why /rtc/login or /rtc/find-home refused, for the sign-in form. [name] is the house's name,
     * or "" when Home was an email (the Worker never says whether an email exists).
     */
    fun signIn(code: String, status: Int, name: String, retryAfterSeconds: Long = 0, owner: Boolean = false): String = when {
        status == 402 || code == "no_active_subscription" ->
            "${if (name.isEmpty()) "This Beebo" else "$name.beebo.tv"} needs an active subscription to watch away from home. " +
                "Ask the person who runs Beebo for your home."
        code == "invalid_credentials" && owner ->
            "That Beebo account email and password didn't match."
        code == "invalid_credentials" ->
            "Couldn't sign in with those details. Check Home, and use the same username and password " +
                "you use for Beebo at home. If you've never signed in at home, do that once first, and ask " +
                "whoever runs Beebo to turn on \"Watch away from home\" for you."
        code == "not_your_beebo" ->
            "That account is fine, but it doesn't own $name.beebo.tv. Check the address, or sign in " +
                "with the account that does."
        code == "missing_fields" -> "Fill in all three boxes."
        status == 429 || code == "too_many_attempts" -> {
            val mins = ((retryAfterSeconds + 59) / 60).coerceAtLeast(1)
            "Too many tries. Wait $mins minute${if (mins == 1L) "" else "s"} and try again."
        }
        status == 404 && code == "not_found" -> "There's no Beebo at $name.beebo.tv. Check Home."
        else -> "Couldn't sign in (${code.ifEmpty { "error $status" }})."
    }

    /** /api/remote-session refused after the tunnel opened. */
    fun remoteSession(error: String): String = when (error) {
        "private_profile_sign_in" -> "This profile keeps its viewing history private. Use the regular sign-in form with your own Beebo profile username and password, rather than Owner sign-in or a household pass."
        "household_pass" -> "The household pass works in a web browser. In the app, sign in with your own username and password."
        "no_remote_access" -> "Your home Beebo hasn't turned on \"Watch away from home\" for you. Ask whoever runs Beebo at home."
        else -> UPDATE_HOST
    }

    const val UPDATE_HOST =
        "Beebo on your home computer needs an update to sign you in away from home. " +
            "Open Beebo on the computer and install the latest version."

    fun hostOffline(name: String) =
        "Your home computer isn't online right now. Check that it's switched on, awake and connected, " +
            "and that Beebo is running on it, then try again."

    fun noAnswer(name: String) =
        "$name's Beebo didn't answer. Check that Beebo is open on the home computer and that the " +
            "computer is awake and online, then try again."

    fun noDirectPath(name: String) =
        "Couldn't connect this phone to $name's home computer from this network. Beebo sends video " +
            "straight from the computer to your phone, and these two internet connections couldn't " +
            "reach each other. Try switching between Wi-Fi and mobile data, or run the connection test."

    const val OFFLINE = "No internet connection on this phone."
    const val UNREACHABLE = "Couldn't reach beebo.tv. Check this phone's internet connection."
    const val SIGNED_OUT = "Sign in again to watch away from home."
}
