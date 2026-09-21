package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.ViewingPrivacyResponse

/** Keep refusal states distinct from a successfully changed preference. */
object ViewingPrivacyPresentation {
    fun saved(code: Int, response: ViewingPrivacyResponse, requested: Boolean): Boolean =
        code in 200..299 && response.ok && response.enabled == requested

    fun error(code: Int, response: ViewingPrivacyResponse): String = when {
        code == 404 -> "Viewing privacy is not available on this computer yet. Update the Beebo desktop program, then try again."
        response.error == "wrong_password" || response.error == "bad_credentials" -> "That password is not right. Enter your own Beebo profile password."
        response.error == "password_required" -> "Enter your own Beebo profile password to confirm."
        response.error == "private_profile_sign_in" -> AdminErrors.message(response.error)
        code == 429 || response.error == "locked" -> "Too many attempts. Wait a few minutes, then try again."
        response.message.isNotBlank() -> response.message
        code == 401 -> "Please sign in directly with your own Beebo username and password, then try again."
        !response.error.isNullOrBlank() -> AdminErrors.message(response.error)
        else -> "Could not confirm this privacy setting. Try again when your Beebo computer is connected."
    }
}
