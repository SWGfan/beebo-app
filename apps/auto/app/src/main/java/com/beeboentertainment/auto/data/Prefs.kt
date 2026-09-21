package com.beeboentertainment.auto.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.beeboentertainment.movie.core.UrlUtils
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * What the user typed cannot be understood as a server address. The message is
 * written to be shown verbatim in the UI — a silently mangled address is a
 * permanently broken config with nothing to explain it.
 */
class InvalidServerAddressException(message: String) : IllegalArgumentException(message)

/**
 * Everything the car needs to reach the server, in one place.
 *
 * The MediaLibraryService is started by Android Auto with no Activity in sight,
 * so all of this has to be readable cold, from disk, with no UI having run.
 */
class Prefs private constructor(
    private val sp: SharedPreferences,
    /** EncryptedSharedPreferences, or null on a phone whose keystore won't make one. */
    private val secure: SharedPreferences?,
) {

    /**
     * Where the app's server traffic goes: `https://name.beebo.tv` after the one sign-in (the
     * tunnel away from home, the computer's own address at home; see remote/AutoRemote), or a
     * direct address typed under "Advanced" by an existing setup. Empty until signed in.
     *
     * There used to be a built-in default, the owner's DuckDNS address through an open router
     * port. A saved copy of it is treated as unset ([migrateSavedBaseUrl]), so a phone that still
     * has it asks for the new sign-in instead of trying a port that is now closed.
     */
    var baseUrl: String
        get() {
            val raw = sp.getString(KEY_BASE_URL, null)
            val migrated = migrateSavedBaseUrl(raw)
            if (raw != null && migrated.isEmpty()) sp.edit().remove(KEY_BASE_URL).apply()
            return migrated
        }
        set(v) = sp.edit().putString(KEY_BASE_URL, normalizeBaseUrl(v)).apply()

    /** The signed-in user's id on the home server: proves a Wi-Fi address is the same computer. */
    var userId: String?
        get() = sp.getString(KEY_USER_ID, null)
        set(v) = sp.edit().putString(KEY_USER_ID, v).apply()

    /**
     * The home computer's own address (typed under "Advanced", or the one used to sign in at
     * home), used instead of the tunnel while on Wi-Fi when [baseUrl] is name.beebo.tv and it
     * answers as the same user. Null when unknown.
     */
    var directBaseUrl: String?
        get() = migrateSavedBaseUrl(sp.getString(KEY_DIRECT_BASE_URL, null)).ifBlank { null }
        set(v) {
            val n = v?.let { runCatching { normalizeBaseUrl(it) }.getOrNull() }?.takeIf { it.isNotBlank() }
            sp.edit().putString(KEY_DIRECT_BASE_URL, n).apply()
        }

    /** True when the saved sign-in can be kept (encrypted storage works on this phone). */
    val canKeepRemoteSignIn: Boolean get() = secure != null

    /** The away-from-home sign-in (RemoteSignIn JSON), encrypted. Null when not kept. */
    var remoteSignIn: String?
        get() = secure?.getString(KEY_REMOTE_SIGN_IN, null)
        set(v) {
            val s = secure ?: return
            if (v == null) s.edit().remove(KEY_REMOTE_SIGN_IN).apply()
            else s.edit().putString(KEY_REMOTE_SIGN_IN, v).apply()
        }

    /** The 12-hour viewer token from beebo.tv (opens the handshake only, never the library). */
    var remoteViewerToken: String?
        get() = secure?.getString(KEY_REMOTE_TOKEN, null)
        set(v) {
            val s = secure ?: return
            if (v == null) s.edit().remove(KEY_REMOTE_TOKEN).apply()
            else s.edit().putString(KEY_REMOTE_TOKEN, v).apply()
        }

    fun forgetRemote() {
        secure?.edit()?.remove(KEY_REMOTE_SIGN_IN)?.remove(KEY_REMOTE_TOKEN)?.apply()
    }

    /** A home-server session: its token, and who it belongs to. */
    fun saveLogin(token: String, user: User?, fallbackName: String = "") {
        this.token = token
        userName = user?.name?.takeIf { it.isNotBlank() } ?: fallbackName
        userId = user?.id?.takeIf { it.isNotBlank() }
    }

    var token: String?
        get() = sp.getString(KEY_TOKEN, null)
        set(v) = sp.edit().putString(KEY_TOKEN, v).apply()

    var userName: String
        get() = sp.getString(KEY_USER_NAME, "") ?: ""
        set(v) = sp.edit().putString(KEY_USER_NAME, v).apply()

    var lastUsername: String
        get() = sp.getString(KEY_LAST_USERNAME, "") ?: ""
        set(v) = sp.edit().putString(KEY_LAST_USERNAME, v).apply()

    /**
     * The coordination hub's session token (a JWT), or null when not signed in
     * to the hub. Independent of [token], which is the movie server's own login:
     * the hub is what tells the app which movie server to talk to in the first
     * place. Persisted the same way as every other string here.
     */
    var hubToken: String?
        get() = sp.getString(KEY_HUB_TOKEN, null)
        set(v) = sp.edit().putString(KEY_HUB_TOKEN, v).apply()

    /**
     * The user's own "bring your own link" sources, serialised as a JSON array
     * of [com.beeboentertainment.auto.sources.UserSource]. Persisted exactly like every
     * other string here so the car service can read the list cold, with no UI
     * having run. Defaults to an empty array, never null, so a fresh install and
     * a first-run parse both have something valid to decode.
     *
     * The list is owned by [com.beeboentertainment.auto.sources.SourceStore]; nothing
     * else should read or write this key directly.
     */
    var userSources: String
        get() = sp.getString(KEY_USER_SOURCES, "[]") ?: "[]"
        set(v) = sp.edit().putString(KEY_USER_SOURCES, v).apply()

    /** Skip decoding the video track in the car. Saves battery and bandwidth. */
    var audioOnly: Boolean
        get() = sp.getBoolean(KEY_AUDIO_ONLY, true)
        set(v) = sp.edit().putBoolean(KEY_AUDIO_ONLY, v).apply()

    /**
     * Lip-sync trim for the "watch party": how far, in milliseconds, a viewer's
     * local video is shifted against the synced (audio) timeline so a passenger's
     * picture lines up with the car's Bluetooth-delayed audio.
     *
     * Positive means the car audio is late, so the video is pulled back to meet
     * it; negative pushes the video ahead. Consumed by
     * [com.beeboentertainment.auto.party.PartyController] as `target = synced - audioDelayMs`.
     * Stored and clamped to [AUDIO_DELAY_MIN_MS]..[AUDIO_DELAY_MAX_MS] so a stray
     * value can never send the player somewhere absurd. Defaults to 0 (no trim).
     */
    var audioDelayMs: Int
        get() = sp.getInt(KEY_AUDIO_DELAY_MS, 0)
        set(v) = sp.edit()
            .putInt(KEY_AUDIO_DELAY_MS, v.coerceIn(AUDIO_DELAY_MIN_MS, AUDIO_DELAY_MAX_MS))
            .apply()

    /**
     * The role this device last used in a watch party: "host" or "viewer", or
     * null if it has never joined one. Persisted so the UI can offer the last
     * choice, and so the car service could rejoin cold if ever wired to.
     */
    var partyRole: String?
        get() = sp.getString(KEY_PARTY_ROLE, null)
        set(v) = sp.edit().putString(KEY_PARTY_ROLE, v).apply()

    /**
     * The display name this device last used in the passenger "games" suite —
     * shown on the scoreboard and sent as the room name when joining a game
     * lobby. Defaults to empty; the games UI falls back to [userName] then a
     * generic label. Stored exactly like every other string here.
     */
    var lastPlayerName: String
        get() = sp.getString(KEY_LAST_PLAYER_NAME, "") ?: ""
        set(v) = sp.edit().putString(KEY_LAST_PLAYER_NAME, v).apply()

    /**
     * The difficulty last chosen for the games suite's AI opponent ("Cruisin'
     * Carl" and friends): one of [com.beeboentertainment.auto.games.BotDifficulty]'s
     * names, or null before the user first picks. Persisted so the choice sticks
     * between sessions.
     */
    var gameBotDifficulty: String?
        get() = sp.getString(KEY_GAME_BOT_DIFFICULTY, null)
        set(v) = sp.edit().putString(KEY_GAME_BOT_DIFFICULTY, v).apply()

    /**
     * The passenger video window's saved geometry, as a small JSON blob
     * ({x,y,w,h,hidden}). Opaque to Prefs — owned and parsed by
     * [com.beeboentertainment.auto.party.VideoWindow]. Null until the user first moves or
     * resizes the window. Stored exactly like every other string here.
     */
    var videoWindow: String?
        get() = sp.getString(KEY_VIDEO_WINDOW, null)
        set(v) = sp.edit().putString(KEY_VIDEO_WINDOW, v).apply()

    val isConfigured: Boolean get() = baseUrl.isNotBlank() && !token.isNullOrBlank()

    /** Forget the home-server session and the away-from-home sign-in. Addresses are kept. */
    fun signOut() {
        sp.edit().remove(KEY_TOKEN).remove(KEY_USER_NAME).remove(KEY_USER_ID).apply()
        forgetRemote()
    }

    /** Forget the hub session only. Left separate from [signOut] so signing out
     *  of the movie server and out of the hub stay independent decisions. */
    fun signOutHub() {
        sp.edit().remove(KEY_HUB_TOKEN).apply()
    }

    companion object {
        private const val FILE = "beebo_auto"
        private const val KEY_BASE_URL = "baseUrl"
        private const val KEY_USER_ID = "userId"
        private const val KEY_DIRECT_BASE_URL = "directBaseUrl"
        private const val KEY_REMOTE_SIGN_IN = "remoteSignIn"
        private const val KEY_REMOTE_TOKEN = "remoteViewerToken"
        private const val SECURE_FILE = "beebo_auto_secure"

        /**
         * The address every install used to start with: the owner's PC through an open router
         * port. It is not a default any more (there is none); a saved copy counts as unset.
         */
        const val LEGACY_DUCKDNS_URL = "https://example-house.duckdns.org:47811"
        private const val KEY_TOKEN = "token"
        private const val KEY_USER_NAME = "userName"
        private const val KEY_LAST_USERNAME = "lastUsername"
        private const val KEY_HUB_TOKEN = "hubToken"
        private const val KEY_USER_SOURCES = "userSources"
        private const val KEY_AUDIO_ONLY = "audioOnly"
        private const val KEY_AUDIO_DELAY_MS = "audioDelayMs"
        private const val KEY_PARTY_ROLE = "partyRole"
        private const val KEY_VIDEO_WINDOW = "videoWindow"
        private const val KEY_LAST_PLAYER_NAME = "lastPlayerName"
        private const val KEY_GAME_BOT_DIFFICULTY = "gameBotDifficulty"

        /** Clamp for [audioDelayMs]. Bluetooth A2DP latency rarely exceeds ~500ms;
         *  the wider range leaves headroom for a stubborn head unit. */
        const val AUDIO_DELAY_MIN_MS = -1000
        const val AUDIO_DELAY_MAX_MS = 1000

        @Volatile private var instance: Prefs? = null

        fun get(context: Context): Prefs = instance ?: synchronized(this) {
            val app = context.applicationContext
            instance ?: Prefs(
                app.getSharedPreferences(FILE, Context.MODE_PRIVATE),
                openSecure(app),
            ).also { instance = it }
        }

        /** Some OEM keystores refuse; then the sign-in just isn't kept between token renewals. */
        private fun openSecure(app: Context): SharedPreferences? = runCatching {
            val key = MasterKey.Builder(app)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                app,
                SECURE_FILE,
                key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }.onFailure { Log.w("Prefs", "encrypted storage unavailable", it) }.getOrNull()

        /**
         * A saved address as the app should use it now: the old DuckDNS default, however it was
         * saved (http after a failed upgrade, capitals, a trailing slash), becomes "" (unset).
         * Anything else is kept exactly as saved.
         */
        fun migrateSavedBaseUrl(saved: String?): String {
            val s = saved?.trim().orEmpty()
            if (s.isEmpty()) return ""
            val asHttps = runCatching { normalizeBaseUrl(s) }.getOrNull()
                ?.replaceFirst(Regex("^http://", RegexOption.IGNORE_CASE), "https://")
            return if (asHttps.equals(LEGACY_DUCKDNS_URL, ignoreCase = true)) "" else s
        }

        const val DEFAULT_PORT = 47811

        private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.\\-]*)://")

        /** A scheme with the slashes missing, or a bare IPv6 literal. */
        private val ALMOST_SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.\\-]*:(?![0-9])")

        /**
         * Turns whatever the user typed into a usable origin.
         *
         * "nick.beebo.tv", "https://Nick.beebo.tv/" -> https://nick.beebo.tv (the tunnel; no port)
         * "beebo.local"                     -> http://beebo.local:47811
         * "http://192.168.1.10"              -> http://192.168.1.10:47811
         * "https://host:47811/"              -> https://host:47811
         * "https://host/beeboentertainment"            -> https://host:47811
         *
         * Port 47811 is hardcoded server-side, so it is added when absent. A
         * plain-HTTP base is fine: if the server has a certificate it answers
         * with a 308 to https on the same port, and OkHttp follows that while
         * preserving the method and body.
         *
         * Parsing goes through OkHttp rather than string surgery because every
         * caller ends up handing the result to OkHttp anyway: if HttpUrl cannot
         * read it here, nothing downstream ever will, and it is far kinder to
         * say so while the user is still looking at the field.
         *
         * Paths are always dropped. The API surface is rooted at the origin, so
         * a path would only ever be a mistake, and keeping one on some branches
         * but not others is worse than either choice.
         *
         * @throws InvalidServerAddressException if [raw] is non-blank and cannot
         *   be read as an http(s) address.
         */
        fun normalizeBaseUrl(raw: String): String {
            val typed = raw.trim()
            if (typed.isEmpty()) return ""
            // A personal beebo.tv address is the tunnel's name, not a server with a port.
            UrlUtils.beeboTvName(typed)?.let { return "https://$it.beebo.tv" }

            val matched = SCHEME.find(typed)
            val scheme = matched?.groupValues?.get(1)?.lowercase()
            if (scheme != null && scheme != "http" && scheme != "https") {
                throw InvalidServerAddressException(
                    "Only http:// and https:// addresses work here, not $scheme://."
                )
            }
            // "http:/host" is the one broken input HttpUrl reads happily: it
            // becomes the host "http" with a path, and would be stored as a
            // perfectly valid-looking address for a server nobody has.
            if (matched == null && ALMOST_SCHEME.containsMatchIn(typed)) {
                throw InvalidServerAddressException(adviceFor(typed))
            }
            val rest = if (matched == null) typed else typed.substring(matched.value.length)
            val url = "${scheme ?: "http"}://$rest".toHttpUrlOrNull()
                ?: throw InvalidServerAddressException(adviceFor(rest))

            // HttpUrl reports the scheme's default port when none was typed, so
            // whether one was typed has to be read off the authority itself.
            val port = if (hasExplicitPort(rest)) url.port else DEFAULT_PORT
            val host = if (url.host.contains(':')) "[${url.host}]" else url.host
            return "${url.scheme}://$host:$port"
        }

        private fun hasExplicitPort(rest: String): Boolean {
            val authority = rest.takeWhile { it != '/' && it != '?' && it != '#' }
                .substringAfterLast('@')
            return if (authority.startsWith("[")) authority.contains("]:")
            else authority.contains(':')
        }

        private fun adviceFor(rest: String): String {
            val authority = rest.takeWhile { it != '/' && it != '?' && it != '#' }
            if (!authority.startsWith("[") && authority.count { it == ':' } > 1) {
                return "That looks like an IPv6 address — put it in brackets, " +
                    "like [$authority]."
            }
            return "That isn't an address this can use. Try something like " +
                "192.168.1.10 or beebo.local."
        }
    }
}
