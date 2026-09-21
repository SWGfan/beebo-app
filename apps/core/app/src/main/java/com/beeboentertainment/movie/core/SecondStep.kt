package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.LoginResponse
import com.beeboentertainment.movie.server.SafeText

/**
 * The second step of signing in to an account that has two-factor on (server: POST /api/login/2fa).
 * The password step answers 401 `two_factor_required` with a `challenge`; the person types a
 * 6-digit code from their authenticator app, or one of their recovery codes, and the challenge goes
 * back with it. Plain rules, no Android, so they are unit tested.
 */
object SecondStep {

    const val WRONG_CODE = "That code is not right. Try the newest code from your app, or a recovery code."
    const val EXPIRED = "That sign-in timed out. Enter your password again."
    const val SETUP_REQUIRED =
        "The owner of this Beebo requires two-factor for admins. Sign in on the website first and turn it on under Account security."

    /** What was typed in the code box. */
    sealed class Entry {
        object Empty : Entry()
        /** Six digits, ready to send. */
        data class AppCode(val code: String) : Entry()
        /** Ten letters and digits (the server shows them as XXXXX-XXXXX). */
        data class RecoveryCode(val code: String) : Entry()
        data class Invalid(val reason: String) : Entry()
    }

    private const val RECOVERY_LENGTH = 10

    /**
     * Spaces and dashes are how people copy codes ("123 456", "ABCDE-FGHJK"), so they are ignored.
     * All digits and six long is an app code; ten letters or digits is a recovery code.
     */
    fun classify(input: String?): Entry {
        val raw = input?.trim().orEmpty()
        if (raw.isEmpty()) return Entry.Empty
        if (raw.length > 32) return Entry.Invalid("That is too long to be a code.")
        val compact = raw.filter { !it.isWhitespace() && it != '-' }
        if (compact.isEmpty()) return Entry.Empty
        if (!compact.all { it in '0'..'9' || it in 'a'..'z' || it in 'A'..'Z' }) return Entry.Invalid("Codes only use letters and numbers.")
        if (compact.all { it in '0'..'9' }) {
            return if (compact.length == 6) Entry.AppCode(compact) else Entry.Invalid("An app code is 6 digits.")
        }
        val upper = compact.uppercase()
        return if (upper.length == RECOVERY_LENGTH) Entry.RecoveryCode(upper.substring(0, 5) + "-" + upper.substring(5))
        else Entry.Invalid("A recovery code is 10 letters and numbers, like ABCDE-FGHJK.")
    }

    /** The value to POST as `code`, or null when [entry] cannot be sent. */
    fun codeToSend(entry: Entry): String? = when (entry) {
        is Entry.AppCode -> entry.code
        is Entry.RecoveryCode -> entry.code
        else -> null
    }

    /** What to do with the server's answer to a code. */
    sealed class Outcome {
        data class SignedIn(val token: String, val user: com.beeboentertainment.movie.data.User?) : Outcome()
        /** Wrong code: stay on the code box and say so. */
        data class TryAgain(val message: String) : Outcome()
        /** The challenge is dead (timed out, or too many wrong codes): back to the password. */
        data class StartOver(val message: String) : Outcome()
        /** Second step locked or the address locked out: nothing to do but wait. */
        data class Locked(val message: String) : Outcome()
        data class Failed(val message: String) : Outcome()
    }

    fun outcome(r: LoginResponse): Outcome {
        if (r.ok && !r.token.isNullOrBlank()) return Outcome.SignedIn(r.token, r.user)
        val serverLine = r.message?.let { SafeText.clean(it, 200) }?.ifBlank { null }
        return when {
            r.locked || r.error == "locked" -> Outcome.Locked(lockedLine(r, serverLine))
            r.error == "challenge_expired" -> Outcome.StartOver(serverLine ?: EXPIRED)
            r.error == "two_factor_setup_required" -> Outcome.Failed(SETUP_REQUIRED)
            r.error == "invalid_code" || r.error == "code_reused" -> Outcome.TryAgain(serverLine ?: WRONG_CODE)
            else -> Outcome.Failed(serverLine ?: r.failureMessage())
        }
    }

    private fun lockedLine(r: LoginResponse, serverLine: String?): String {
        val m = r.minutesRemaining ?: 0
        return if (m > 0) "Too many wrong codes. Try again in $m minute${if (m == 1) "" else "s"}."
        else serverLine ?: "Too many wrong codes. Try again shortly."
    }
}
