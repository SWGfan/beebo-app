package com.beeboentertainment.movie.core

/**
 * Turning the admin API's error codes into something the owner can act on.
 *
 * The API draws a deliberate line: transport and auth problems use real status codes, while
 * "business" refusals — the last admin, the conversion guardrails, a secret that can only be set
 * on the PC — answer 200 with {ok:false,error}. Both kinds end up here, because from the phone's
 * point of view they are all just "it said no, and here is why".
 *
 * Nothing in this file fails silently: an unrecognised code is still shown, verbatim, rather than
 * being swallowed into a generic message.
 */
object AdminErrors {

    /* Codes worth naming, so a typo in one place doesn't quietly stop matching. */
    const val HTTPS_REQUIRED = "https_required"
    const val ADMIN_ONLY = "admin_only"
    const val UNAUTHORIZED = "unauthorized"
    const val LAST_ADMIN = "last_admin"
    const val NOT_REMOTELY_SETTABLE = "not_remotely_settable"
    const val NOT_SETTABLE = "not_settable"
    const val NOT_A_DIRECTORY = "not_a_directory"
    const val BAD_VALUE = "bad_value"
    const val NOTHING_TO_SET = "nothing_to_set"
    const val NOT_FOUND = "not_found"
    const val MISSING_KEY = "missing_key"
    const val MISSING_USER_ID = "missing_userId"
    const val BAD_SCOPE = "bad_scope"

    /* Conversion guardrails — these protect real files, so they get careful wording. */
    const val NOT_DELETABLE = "not_deletable"
    const val CONVERTED_FILE_MISSING = "converted_file_missing"
    const val CONVERTED_FILE_TOO_SMALL = "converted_file_too_small"
    const val NO_OUTPUT_PATH = "no_output_path"
    const val INVALID_PATH = "invalid_path"
    const val OUTSIDE_MANAGED_FOLDERS = "outside_managed_folders"

    /* Request a title. */
    const val RATE_LIMITED = "rate_limited"
    const val ALREADY_IN_LIBRARY = "already_in_library"
    const val OWNER_ONLY = "owner_only"
    const val QUERY_TOO_SHORT = "query_too_short"
    const val NO_API_KEY = "no_api_key"
    const val TMDB_UNREACHABLE = "tmdb_unreachable"
    const val BAD_REQUEST = "bad_request"

    /**
     * @param error the server's error code
     * @param field the offending field, for the settings refusals that name one
     */
    fun message(error: String?, field: String? = null): String {
        val code = error?.trim().orEmpty()
        if (code.isEmpty()) return "The server refused that, but didn't say why."
        return when (code) {
            HTTPS_REQUIRED ->
                "Admin tools need a secure connection; the server's certificate isn't active " +
                    "right now. Check HTTPS on the PC, then try again."
            ADMIN_ONLY -> "This account isn't an admin, so it can't use the admin tools."
            UNAUTHORIZED -> "Your session has expired — please sign in again."

            LAST_ADMIN ->
                "That's the only admin left. Make someone else an admin first, or you'd lock " +
                    "the household out."

            NOT_REMOTELY_SETTABLE -> {
                val what = friendlyField(field)
                "$what can only be set on the PC, in the desktop app — it's a password for " +
                    "another service, so it's deliberately not changeable from a phone."
            }
            NOT_SETTABLE -> "${friendlyField(field)} isn't something this app can change."
            NOT_A_DIRECTORY ->
                "${friendlyField(field)} doesn't point at a folder that exists on the server. " +
                    "Nothing was changed."
            BAD_VALUE -> "${friendlyField(field)} was the wrong sort of value. Nothing was changed."
            NOTHING_TO_SET -> "Nothing to save — no changes were made."

            NOT_FOUND -> "That's gone already — someone may have removed it."
            MISSING_KEY -> "That marker row is missing its key, so it can't be cleared."
            MISSING_USER_ID -> "No user was selected."
            BAD_SCOPE -> "That isn't a valid thing to clear."

            NOT_DELETABLE ->
                "The original can only be deleted once the conversion has finished successfully " +
                    "— and it hasn't been deleted already."
            CONVERTED_FILE_MISSING ->
                "The converted copy isn't on disk, so deleting the original would leave you with " +
                    "nothing. Refused."
            CONVERTED_FILE_TOO_SMALL ->
                "The converted copy is under 1 MB, which usually means it was truncated. " +
                    "Deleting the original would risk losing the only good copy. Refused."
            NO_OUTPUT_PATH -> "That entry has no converted file recorded against it."
            INVALID_PATH ->
                "The original and the converted copy resolve to the same file, so deleting " +
                    "either would delete both. Refused."
            OUTSIDE_MANAGED_FOLDERS ->
                "That file isn't inside a Movies or TV Shows folder this server manages, so it " +
                    "won't be touched."

            RATE_LIMITED -> "That's a lot of requests in a short time. Give it a little while and try again."
            ALREADY_IN_LIBRARY -> "Good news: that's already in the library."
            OWNER_ONLY -> "Only the owner of this Beebo server can do that."
            QUERY_TOO_SHORT -> "Type at least two letters to search."
            NO_API_KEY ->
                "Searching needs a TMDB key, and this server hasn't got one. The owner can add it " +
                    "in the desktop app's Settings."
            TMDB_UNREACHABLE -> "The server couldn't reach TMDB just now. Try again in a moment."
            BAD_REQUEST -> "That request was missing something, so nothing was sent."

            // Parental controls and shared libraries: the server sends its own friendly message
            // with these; this wording is the fallback.
            "bedtime" -> "It's past bedtime on this profile. Watching opens again in the morning."
            "daily_limit" -> "That's all the watching time for today on this profile."
            "restricted_profile" -> "This profile has parental controls on. Ask the person who runs Beebo."
            "not_available_to_guests" -> "That isn't part of the library shared with you."
            "share_ended" -> "This library is no longer shared with you."
            "too_many_streams" -> "This shared library is already playing on as many screens as it allows."
            "admin_profile" -> "Parental controls can't be put on an admin. Turn off admin for this person first."
            "private_profile_sign_in" -> "This profile keeps its viewing history private. Sign out, then sign in directly with that person's own username and password."
            // "private_profile" is the desktop server's actual code (see
            // electron/viewingPrivacy.js setAdult); the other two are kept in case a future
            // server build renames it, since the desktop always sends its own "message" first
            // and this fallback only shows when that is blank.
            "private_profile", "privacy_enabled", "viewing_privacy_enabled" ->
                "This person must turn off their viewing privacy before you can change their adult label or add parental controls."
            "wrong_pin" -> "That PIN isn't right."
            "pin_required" -> "Enter the owner PIN."
            "pin_not_set" -> "The owner hasn't set a PIN yet. It's set in Owner tools, Family."
            "locked" -> "Too many wrong PINs. Try again in 15 minutes."
            "consent_required" -> "Please confirm you have the rights to share this media."
            "already_shared" -> "You already share with that email."
            "too_many_shares" -> "You're sharing with as many people as Beebo allows."
            "bad_email" -> "Enter their email address."

            else -> "The server said: $code"
        }
    }

    /** Is this the one error that means "the connection isn't secure", not "you can't do that"? */
    fun isHttpsProblem(error: String?): Boolean = error?.trim() == HTTPS_REQUIRED

    /** Should this send the user back to the login screen? */
    fun isSessionProblem(error: String?): Boolean = error?.trim() == UNAUTHORIZED

    /** Folder keys read like camelCase; give them back as words. */
    fun friendlyField(field: String?): String {
        val f = field?.trim().orEmpty()
        if (f.isEmpty()) return "That setting"
        return when (f) {
            "moviesDir" -> "The Movies folder"
            "tvShowsDir" -> "The TV Shows folder"
            "newFilesDir" -> "The New Files folder"
            "viewerAppDir" -> "The Viewer app folder"
            "tmdbCacheDir" -> "The TMDB cache folder"
            "extraMoviesDirs" -> "The extra Movies folders"
            "extraTvShowsDirs" -> "The extra TV Shows folders"
            "tmdbApiKey" -> "The TMDB API key"
            "emailAppPassword" -> "The email app password"
            "emailUser" -> "The email username"
            "adminNotifyEmail" -> "The admin notification address"
            "duckdnsToken" -> "The DuckDNS token"
            else -> "\"$f\""
        }
    }
}

/**
 * Who gets to see the admin entry point.
 *
 * The rule is deliberately blunt: the flag comes from the server via /api/me, and a non-admin
 * sees no trace of the section at all — not a disabled button, not a greyed tab. The API enforces
 * this independently, so this is about not showing someone a door they cannot open.
 */
object AdminGate {

    /** Show the admin action in the app bar? */
    fun showAdminEntry(isSignedIn: Boolean, isAdmin: Boolean): Boolean = isSignedIn && isAdmin

    /**
     * May this session open an admin screen? Same answer, named separately because it guards a
     * different thing — navigation rather than a button.
     */
    fun canOpenAdmin(isSignedIn: Boolean, isAdmin: Boolean): Boolean = showAdminEntry(isSignedIn, isAdmin)

    /**
     * What to believe when /api/me can't be reached on resume.
     * Keep the last known answer rather than flickering the section away on a dropped Wi-Fi —
     * the API refuses admin calls on its own, so a stale "true" costs nothing but a clear error.
     */
    fun resolveIsAdmin(fresh: Boolean?, lastKnown: Boolean): Boolean = fresh ?: lastKnown
}
