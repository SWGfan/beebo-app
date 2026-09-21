package com.beeboentertainment.movie.account

import com.beeboentertainment.movie.hub.HubClient
import com.beeboentertainment.movie.rtc.RemoteSignIn
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Settings > Delete my account: which accounts this phone is signed in to, what deleting each one
 * removes, where the request goes, and what the answer means. Pure, so it is unit-tested; the
 * network calls are in [AccountDeleter] and the screen in DeleteAccountSection.
 *
 * Three kinds of account can be signed in through the app (Google Play's account deletion policy
 * covers each):
 *  - [Kind.HOME_MEMBER]: your own username on a home Beebo (the owner's computer). Deleting it
 *    removes your access and your personal history there, not the owner's library.
 *  - [Kind.BEEBO_ACCOUNT]: the Beebo account email and password ("Owner sign-in"), kept at beebo.tv.
 *  - [Kind.HUB]: the hub account (hub.beebotv.com) used for watch parties.
 */
object AccountDeletion {

    enum class Kind { HOME_MEMBER, BEEBO_ACCOUNT, HUB }

    data class Account(val kind: Kind, val title: String, val who: String?, val explanation: String)

    /** Deletes the Beebo account (beebo.tv). Any beebo.tv host answers; the app already uses login. */
    const val BEEBO_ACCOUNT_DELETE_URL = "https://login.beebo.tv/account/delete"
    const val HUB_ACCOUNT_DELETE_URL = HubClient.HUB_BASE_URL + "/api/v1/account"
    const val HOME_DELETE_PATH = "/api/me/delete"

    /** Shown as plain text, never as a link: the site has pages the app must not send people to. */
    const val WEB_PAGE_TEXT = "beeboentertainment.com/delete-account.html"

    fun homeExplanation(isAdmin: Boolean): String = buildString {
        append("Removes you from this home Beebo: your username and password, your watch history, ")
        append("Continue Watching, watchlist, favourites and away-from-home access. Your name is taken off ")
        append("any reports or markers you left. It does NOT delete the owner's movies and shows or anyone ")
        append("else's account. Files you backed up with Space Saver stay on that computer until the owner deletes them.")
        if (isAdmin) append(" If you are this home Beebo's only admin, you can't remove yourself: uninstall Beebo on the computer instead.")
    }

    const val BEEBO_ACCOUNT_EXPLANATION =
        "Deletes your Beebo account at beebo.tv: your email and password, any subscription (cancelled, so you " +
            "won't be billed again), your home's beebo.tv name, household pass, member sign-ins and away-from-home " +
            "records. The movies on your computer are never touched. Payment records stay with the payment " +
            "processor as the law requires."

    const val HUB_EXPLANATION =
        "Deletes your hub account: your email and password, the computer paired to it, links you saved, and " +
            "any watch party you're hosting. Payment records stay with the payment processor as the law requires."

    /** The accounts this phone is signed in to, in the order the screen lists them. */
    fun accountsOn(
        homeToken: String?,
        homeUserName: String?,
        isAdmin: Boolean,
        remote: RemoteSignIn?,
        hubToken: String?,
    ): List<Account> {
        val out = mutableListOf<Account>()
        if (!homeToken.isNullOrBlank()) {
            out += Account(Kind.HOME_MEMBER, "Your account on this home Beebo", homeUserName?.takeIf { it.isNotBlank() }, homeExplanation(isAdmin))
        }
        if (remote?.kind == RemoteSignIn.Kind.OWNER && remote.id.isNotBlank()) {
            out += Account(Kind.BEEBO_ACCOUNT, "Your Beebo account", remote.id.trim(), BEEBO_ACCOUNT_EXPLANATION)
        }
        if (!hubToken.isNullOrBlank()) {
            out += Account(Kind.HUB, "Your hub account", null, HUB_EXPLANATION)
        }
        return out
    }

    fun homeBody(password: String): String =
        buildJsonObject { put("password", JsonPrimitive(password)) }.toString()

    fun hubBody(password: String): String =
        buildJsonObject { put("password", JsonPrimitive(password)) }.toString()

    fun beeboAccountBody(email: String, password: String): String =
        buildJsonObject {
            put("email", JsonPrimitive(email.trim().lowercase()))
            put("password", JsonPrimitive(password))
        }.toString()

    sealed class Outcome {
        object Deleted : Outcome()
        /** Nothing was deleted; [message] says why in plain words. */
        data class NotDeleted(val message: String) : Outcome()
    }

    /** What an HTTP answer means for [kind]. [error] is the body's "error" field, if any. */
    fun outcome(kind: Kind, code: Int, error: String?): Outcome {
        if (code in 200..299) return Outcome.Deleted
        val e = error.orEmpty()
        return Outcome.NotDeleted(
            when {
                code == 401 && kind == Kind.HUB && e.contains("Not signed in", true) ->
                    "Your hub sign-in has expired. Sign in to the hub again, then delete the account."
                code == 401 && kind == Kind.BEEBO_ACCOUNT -> "That password doesn't match your Beebo account."
                code == 401 -> "That password isn't right."
                code == 400 -> "Enter your password to confirm."
                code == 409 || e == "last_admin" ->
                    "You're the only admin of this home Beebo, so you can't remove yourself. To delete everything on it, uninstall Beebo on the computer."
                code == 429 || e == "locked" -> "Too many tries. Wait a few minutes and try again."
                code == 404 && kind == Kind.HOME_MEMBER ->
                    "This home Beebo is too old to delete accounts from the app. Ask the owner to update Beebo on the computer, or to remove you in its Users tab."
                code == 502 -> e.ifBlank { "Couldn't reach the payment service. Nothing was deleted; try again in a few minutes." }
                else -> "Couldn't delete the account (error $code). Nothing was deleted; try again later."
            }
        )
    }

    /** The message for a request that never got an answer. */
    const val OFFLINE = "Couldn't reach the server. Check your connection and try again. Nothing was deleted."
}
