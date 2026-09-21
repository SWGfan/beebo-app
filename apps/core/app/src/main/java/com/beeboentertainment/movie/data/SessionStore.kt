package com.beeboentertainment.movie.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.beeboentertainment.movie.core.KeyValueStore
import com.beeboentertainment.movie.core.UrlUtils

/**
 * Persistent app state: server base URL, bearer token, the logged-in user's name,
 * and per-item resume positions.
 *
 * The token lives in EncryptedSharedPreferences (androidx.security-crypto). Some OEM builds
 * throw when the AndroidKeyStore master key is unavailable, so we fall back to plain
 * SharedPreferences rather than crashing on launch — [usingEncryptedStorage] records which
 * one actually got used.
 */
class SessionStore(context: Context) {

    companion object {
        private const val TAG = "SessionStore"
        private const val SECURE_FILE = "beebo_secure"
        private const val PLAIN_FILE = "beebo_prefs"
        private const val KEY_DEMO = "demo_mode"

        private const val K_BASE_URL = "base_url"
        private const val K_TOKEN = "token"
        private const val K_USER_NAME = "user_name"
        private const val K_USER_ID = "user_id"
        private const val K_IS_ADMIN = "is_admin"
        private const val K_RESTRICTED = "profile_restricted"
        private const val K_GUEST = "profile_guest"
        private const val K_SHARED_LIBRARIES = "shared_libraries"
        private const val K_GUEST_SIGN_INS = "guest_sign_ins"
        private const val K_HOME_SNAPSHOT = "home_snapshot"
        private const val K_TRIP_LINKS = "trip_share_links"

        // Additive keys for the ported hub / party / sources modules.
        // The hub token is a credential (a JWT) so it lives in the secure store
        // alongside the movie-server token; the rest are non-secret bulk state
        // and live in the plain store next to resume positions.
        private const val K_HUB_TOKEN = "hub_token"
        // Rewards has its own limited token. It cannot read media, control a
        // home server, or act as the hub session, so a rewards compromise is
        // deliberately contained to the optional rewards API.
        private const val K_REWARDS_TOKEN = "rewards_token"
        private const val K_REWARDS_EXPIRES_AT = "rewards_expires_at"
        private const val K_AUDIO_DELAY_MS = "audio_delay_ms"
        private const val K_USER_SOURCES = "user_sources"
        private const val K_PARTY_ROLE = "party_role"
        private const val K_VIDEO_WINDOW = "video_window"
        private const val K_SUBTITLES_ON = "subtitles_on"
        private const val K_SUBTITLE_LANG = "subtitle_lang"
        private const val K_REMOTE_SIGN_IN = "remote_sign_in"
        private const val K_REMOTE_TOKEN = "remote_viewer_token"
        private const val K_DIRECT_BASE_URL = "direct_base_url"
        private const val K_WALLET_DISMISSED = "wallet_banner_dismissed"
        private const val K_CAST_VIA_PHONE_EXPLAINED = "cast_via_phone_explained"

        // No default server address: a new install starts with an empty Home box, and an existing
        // install keeps the address it saved (K_BASE_URL). Never put a real home's address here.

        /**
         * Clamp for [audioDelayMs]. Bluetooth A2DP latency rarely exceeds ~500ms;
         * the wider range leaves headroom for a stubborn head unit / TV audio path.
         */
        const val AUDIO_DELAY_MIN_MS = -1000
        const val AUDIO_DELAY_MAX_MS = 1000
    }

    /** Encrypted (or fallback) store for credentials. */
    private val secure: SharedPreferences
    /** Plain store for non-secret bulk state (resume positions, download index). */
    val plain: SharedPreferences = context.getSharedPreferences(PLAIN_FILE, Context.MODE_PRIVATE)

    var usingEncryptedStorage: Boolean = false
        private set

    init {
        secure = try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val p = EncryptedSharedPreferences.create(
                context,
                SECURE_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            usingEncryptedStorage = true
            p
        } catch (t: Throwable) {
            Log.w(TAG, "EncryptedSharedPreferences unavailable, falling back to plain prefs", t)
            usingEncryptedStorage = false
            context.getSharedPreferences(PLAIN_FILE, Context.MODE_PRIVATE)
        }
    }

    var baseUrl: String?
        get() = secure.getString(K_BASE_URL, null)
        set(value) {
            secure.edit().putString(K_BASE_URL, UrlUtils.normalizeBaseUrl(value)).apply()
        }

    var token: String?
        get() = secure.getString(K_TOKEN, null)
        set(value) {
            secure.edit().putString(K_TOKEN, value).apply()
        }

    var userName: String?
        get() = secure.getString(K_USER_NAME, null)
        set(value) { secure.edit().putString(K_USER_NAME, value).apply() }

    var userId: String?
        get() = secure.getString(K_USER_ID, null)
        set(value) { secure.edit().putString(K_USER_ID, value).apply() }

    var isAdmin: Boolean
        get() = secure.getBoolean(K_IS_ADMIN, false)
        set(value) { secure.edit().putBoolean(K_IS_ADMIN, value).apply() }

    /**
     * "Keep playing with the screen off." OFF by default, exactly like the website, and
     * remembered across videos and app restarts once the user turns it on.
     * The logic lives in BackgroundPlaybackSetting so it can be unit-tested headlessly; this is
     * only the SharedPreferences binding. Not a secret, so it uses the plain store.
     */
    val backgroundPlayback: com.beeboentertainment.movie.core.BackgroundPlaybackSetting by lazy {
        com.beeboentertainment.movie.core.BackgroundPlaybackSetting(SharedPrefsKeyValueStore(plain))
    }

    var keepPlayingInBackground: Boolean
        get() = backgroundPlayback.enabled
        set(value) { backgroundPlayback.enabled = value }

    /**
     * "Show time remaining" for the player's duration label, in place of the total length.
     * OFF by default; the logic lives in TimeRemainingSetting so it can be unit-tested
     * headlessly, exactly like [backgroundPlayback] above. Not a secret, so it uses the plain
     * store.
     */
    private val timeRemaining: com.beeboentertainment.movie.core.TimeRemainingSetting by lazy {
        com.beeboentertainment.movie.core.TimeRemainingSetting(SharedPrefsKeyValueStore(plain))
    }

    var showTimeRemaining: Boolean
        get() = timeRemaining.enabled
        set(value) { timeRemaining.enabled = value }

    /**
     * The coordination hub's session token (a JWT), or null when not signed in
     * to the hub. Independent of [token], which is the movie server's own login:
     * the hub is what tells the app which movie server to talk to in the first
     * place. Kept in the secure store like [token].
     */
    var hubToken: String?
        get() = secure.getString(K_HUB_TOKEN, null)
        set(value) { secure.edit().putString(K_HUB_TOKEN, value).apply() }

    var rewardsToken: String?
        get() = secure.getString(K_REWARDS_TOKEN, null)
        set(value) { secure.edit().putString(K_REWARDS_TOKEN, value).apply() }

    var rewardsExpiresAt: Long
        get() = secure.getLong(K_REWARDS_EXPIRES_AT, 0L)
        set(value) { secure.edit().putLong(K_REWARDS_EXPIRES_AT, value).apply() }

    fun clearRewardsSession() {
        secure.edit().remove(K_REWARDS_TOKEN).remove(K_REWARDS_EXPIRES_AT).apply()
    }

    /**
     * Lip-sync trim for the watch party: how far, in milliseconds, a viewer's
     * local video is shifted against the synced (audio) timeline so the picture
     * lines up with (possibly Bluetooth-delayed) audio. Positive means the audio
     * is late, so the video is pulled back to meet it. Consumed by
     * com.beeboentertainment.movie.party.PartyController as
     * effectiveTarget = synced - audioDelayMs. Clamped on write to
     * [AUDIO_DELAY_MIN_MS]..[AUDIO_DELAY_MAX_MS]. Not a secret, so plain store.
     */
    var audioDelayMs: Int
        get() = plain.getInt(K_AUDIO_DELAY_MS, 0)
        set(value) {
            plain.edit()
                .putInt(K_AUDIO_DELAY_MS, value.coerceIn(AUDIO_DELAY_MIN_MS, AUDIO_DELAY_MAX_MS))
                .apply()
        }

    /**
     * The user's own "bring your own link" sources, serialised as a JSON array of
     * com.beeboentertainment.movie.sources.UserSource. Owned by SourceStore; nothing else
     * should read or write this key directly. Defaults to an empty array, never
     * null, so a fresh install and a first-run parse both decode cleanly.
     */
    var userSources: String
        get() = plain.getString(K_USER_SOURCES, "[]") ?: "[]"
        set(value) { plain.edit().putString(K_USER_SOURCES, value).apply() }

    /**
     * The role this device last used in a watch party: "host" or "viewer", or
     * null if it has never joined one. Persisted so the UI can offer the last
     * choice. Not a secret, so plain store.
     */
    var partyRole: String?
        get() = plain.getString(K_PARTY_ROLE, null)
        set(value) { plain.edit().putString(K_PARTY_ROLE, value).apply() }

    /**
     * The passenger video window's saved geometry, as a small JSON blob
     * ({x,y,w,h,hidden}). Opaque here — owned and parsed by
     * com.beeboentertainment.movie.party.VideoWindow. Null until first moved or resized.
     */
    var videoWindow: String?
        get() = plain.getString(K_VIDEO_WINDOW, null)
        set(value) { plain.edit().putString(K_VIDEO_WINDOW, value).apply() }

    /**
     * "Show subtitles." OFF on a fresh install, then remembered across videos and app restarts.
     *
     * Persisting it rather than resetting per video is the whole point: nobody turns subtitles on
     * because of THIS film - they turn them on because of their hearing, their accent, or the
     * room they watch in, and all three are still true for the next one. Making them re-arm it
     * every single time would be the annoying choice. It is the same rule, for the same reason,
     * as [keepPlayingInBackground] above, so the two settings behave consistently.
     *
     * Not a secret, so plain store.
     */
    var subtitlesOn: Boolean
        get() = plain.getBoolean(K_SUBTITLES_ON, false)
        set(value) { plain.edit().putBoolean(K_SUBTITLES_ON, value).apply() }

    /**
     * The ISO language code of the subtitle track last chosen ("en", "es", ...), or null when the
     * viewer has only ever used a sidecar that carried no code in its name.
     *
     * Only the LANGUAGE carries over, never the track itself: two files do not have the same set
     * of sidecars, so an index or a label would be meaningless on the next one. The player falls
     * back to the first track when this language is not among them. Deliberately not a per-title
     * map - that would grow one entry per file across a library of over a thousand, and would
     * still be a guess the very first time each one is opened.
     */
    var subtitleLanguage: String?
        get() = plain.getString(K_SUBTITLE_LANG, null)
        set(value) { plain.edit().putString(K_SUBTITLE_LANG, value).apply() }

    /* ------------------------- away from home (name.beebo.tv) ------------------------- */

    /**
     * How this phone signs in to name.beebo.tv, as JSON ({kind, id, secret}), so the tunnel can
     * sign in again by itself when its 12-hour viewer token runs out. A credential, so it is only
     * ever kept when the store really is encrypted; on a phone without a working keystore the
     * app asks again after a restart instead. See RemoteAccess.
     */
    var remoteSignIn: String?
        get() = if (usingEncryptedStorage) secure.getString(K_REMOTE_SIGN_IN, null) else null
        set(value) {
            if (usingEncryptedStorage && value != null) secure.edit().putString(K_REMOTE_SIGN_IN, value).apply()
            else secure.edit().remove(K_REMOTE_SIGN_IN).apply()
        }

    /** The 12-hour viewer token from /rtc/login (it only opens the handshake, never the library). */
    var remoteViewerToken: String?
        get() = secure.getString(K_REMOTE_TOKEN, null)
        set(value) { secure.edit().putString(K_REMOTE_TOKEN, value).apply() }

    /**
     * The home computer's own address, remembered when the user moves to name.beebo.tv, so the
     * app can use it while on the home Wi-Fi (RouteRule). Not a secret.
     */
    var directBaseUrl: String?
        get() = plain.getString(K_DIRECT_BASE_URL, null)
        set(value) { plain.edit().putString(K_DIRECT_BASE_URL, UrlUtils.normalizeBaseUrl(value)).apply() }

    /** The relay-balance banner last dismissed ("level:seq"), so it stays dismissed. */
    var walletBannerDismissed: String?
        get() = plain.getString(K_WALLET_DISMISSED, null)
        set(value) { plain.edit().putString(K_WALLET_DISMISSED, value).apply() }

    /**
     * True once the person has been told, one time, that casting away from home goes through
     * this phone ("keep Beebo open and stay on this Wi-Fi"). Saying it twice would be nagging.
     */
    var castViaPhoneExplained: Boolean
        get() = plain.getBoolean(K_CAST_VIA_PHONE_EXPLAINED, false)
        set(value) { plain.edit().putBoolean(K_CAST_VIA_PHONE_EXPLAINED, value).apply() }

    fun forgetRemote() {
        secure.edit().remove(K_REMOTE_SIGN_IN).remove(K_REMOTE_TOKEN).apply()
    }

    val hasServer: Boolean get() = !baseUrl.isNullOrBlank()
    val isLoggedIn: Boolean get() = hasServer && !token.isNullOrBlank()

    /**
     * "Look around without a server."
     *
     * Beebo is a client for a home media server, so without one the app had
     * nothing to show and stopped dead on the setup screen. That is correct for
     * a customer who owns a server, but it is a wall for anyone evaluating the
     * app - a Play Store reviewer, or one of the closed-test testers - who has
     * an Android phone and no Windows PC.
     *
     * In demo mode the library tabs explain themselves instead of erroring, and
     * everything that genuinely needs no server (the travel and camping tools,
     * the games, the sample video) works for real. Connecting a server later
     * clears the flag and nothing is lost.
     */
    var demoMode: Boolean
        get() = plain.getBoolean(KEY_DEMO, false)
        set(v) { plain.edit().putBoolean(KEY_DEMO, v).apply() }

    fun saveLogin(token: String, user: User?) {
        this.token = token
        this.userName = user?.name
        this.userId = user?.id
        this.isAdmin = user?.isAdmin ?: false
        this.isRestricted = user?.restricted ?: false
        this.isGuest = user?.guest ?: false
    }

    /* ---------------- parental controls, shared libraries (core/SharingLogic.kt) ---------------- */

    /** Parental controls are on for the signed-in profile, as the server last said. */
    var isRestricted: Boolean
        get() = secure.getBoolean(K_RESTRICTED, false)
        set(value) { secure.edit().putBoolean(K_RESTRICTED, value).apply() }

    /** Signed in to someone else's shared library rather than this person's own home. */
    var isGuest: Boolean
        get() = secure.getBoolean(K_GUEST, false)
        set(value) { secure.edit().putBoolean(K_GUEST, value).apply() }

    /** Libraries shared with this person (house name, label, their email). Not secret. */
    var sharedLibrariesJson: String?
        get() = plain.getString(K_SHARED_LIBRARIES, null)
        set(value) { plain.edit().putString(K_SHARED_LIBRARIES, value).apply() }

    /**
     * The guest sign-in per shared house, as RemoteSignIn JSON keyed by name, so switching back
     * and forth doesn't ask for the password each time. A credential: only kept when encrypted.
     */
    var guestSignInsJson: String?
        get() = if (usingEncryptedStorage) secure.getString(K_GUEST_SIGN_INS, null) else null
        set(value) {
            if (usingEncryptedStorage && value != null) secure.edit().putString(K_GUEST_SIGN_INS, value).apply()
            else secure.edit().remove(K_GUEST_SIGN_INS).apply()
        }

    /** "My home" while a shared library is open: address, sign-in and session to come back to. */
    var homeSnapshotJson: String?
        get() = if (usingEncryptedStorage) secure.getString(K_HOME_SNAPSHOT, null) else null
        set(value) {
            if (usingEncryptedStorage && value != null) secure.edit().putString(K_HOME_SNAPSHOT, value).apply()
            else secure.edit().remove(K_HOME_SNAPSHOT).apply()
        }

    /**
     * Private trip links made from this phone (see tripshare/). Each one holds a working address, so it
     * is kept only when the store really is encrypted, and it is forgotten on sign-out.
     */
    var tripLinksJson: String?
        get() = if (usingEncryptedStorage) secure.getString(K_TRIP_LINKS, null) else null
        set(value) {
            if (usingEncryptedStorage && value != null) secure.edit().putString(K_TRIP_LINKS, value).apply()
            else secure.edit().remove(K_TRIP_LINKS).apply()
        }

    /** Forget credentials but keep the server address — a 401 shouldn't make them retype the URL. */
    fun logout() {
        secure.edit().remove(K_TOKEN).remove(K_USER_NAME).remove(K_USER_ID).remove(K_IS_ADMIN).remove(K_RESTRICTED).remove(K_GUEST).remove(K_REWARDS_TOKEN).remove(K_REWARDS_EXPIRES_AT).remove(K_TRIP_LINKS).apply()
    }

    /**
     * Forget the hub session only. Kept separate from [logout] so signing out of
     * the movie server and out of the coordination hub stay independent decisions.
     */
    fun logoutHub() {
        secure.edit().remove(K_HUB_TOKEN).apply()
    }

    /** SharedPreferences-backed KeyValueStore used by ResumeStore. */
    fun resumeKeyValueStore(): KeyValueStore = SharedPrefsKeyValueStore(plain)
}

/** Adapter so the pure ResumeStore logic can sit on top of SharedPreferences. */
class SharedPrefsKeyValueStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun getLong(key: String, default: Long): Long = try {
        prefs.getLong(key, default)
    } catch (_: ClassCastException) {
        default
    }
    override fun putLong(key: String, value: Long) { prefs.edit().putLong(key, value).apply() }
    override fun remove(key: String) { prefs.edit().remove(key).apply() }
    override fun keys(): Set<String> = prefs.all.keys.toSet()
    override fun getBoolean(key: String, default: Boolean): Boolean = try {
        prefs.getBoolean(key, default)
    } catch (_: ClassCastException) {
        default
    }
    override fun putBoolean(key: String, value: Boolean) { prefs.edit().putBoolean(key, value).apply() }
}
