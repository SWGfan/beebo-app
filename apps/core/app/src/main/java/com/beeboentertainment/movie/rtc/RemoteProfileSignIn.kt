package com.beeboentertainment.movie.rtc

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.LoginRequest
import com.beeboentertainment.movie.data.LoginResponse
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Exchanges an established tunnel for a home-server session. A private profile requires its
 * own password even when the signalling service already authenticated the tunnel. The caller
 * supplies the open tunnel's executor, so passwords cannot follow redirects or a remembered LAN IP.
 */
internal object RemoteProfileSignIn {
    sealed class Result {
        data class SignedIn(val login: LoginResponse) : Result()
        /**
         * [secondStepChallenge] is set when the password was right but the account has two-factor
         * on: the caller asks for a code and finishes with [secondStep].
         */
        data class Refused(val message: String, val secondStepChallenge: String? = null) : Result()
    }

    private const val CODE_PROMPT = "Enter the 6-digit code from your authenticator app."

    /** Step two over the open tunnel: the challenge and a code to the home server's /api/login/2fa. */
    fun secondStep(name: String, challenge: String, code: String, executeTunnel: (Request) -> Response): Result {
        val payload = ApiClient.JSON.encodeToString(
            com.beeboentertainment.movie.data.SecondStepRequest.serializer(),
            com.beeboentertainment.movie.data.SecondStepRequest(challenge, code)
        )
        val request = Request.Builder().url("https://$name.beebo.tv/api/login/2fa")
            .post(payload.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .header("Accept", "application/json").build()
        return executeTunnel(request).use { response ->
            val body = decode(response.body?.string().orEmpty())
            when {
                successful(response.code, body) -> Result.SignedIn(body!!)
                response.code in 300..399 -> Result.Refused("Your home Beebo redirected the sign-in request. Nothing was forwarded. Reconnect and try again.")
                body == null -> Result.Refused("Your home Beebo could not check that code. It may need an update.")
                else -> when (val o = com.beeboentertainment.movie.core.SecondStep.outcome(body)) {
                    is com.beeboentertainment.movie.core.SecondStep.Outcome.TryAgain -> Result.Refused(o.message, challenge)
                    is com.beeboentertainment.movie.core.SecondStep.Outcome.StartOver -> Result.Refused(o.message)
                    is com.beeboentertainment.movie.core.SecondStep.Outcome.Locked -> Result.Refused(o.message)
                    is com.beeboentertainment.movie.core.SecondStep.Outcome.Failed -> Result.Refused(o.message)
                    is com.beeboentertainment.movie.core.SecondStep.Outcome.SignedIn -> Result.SignedIn(body)
                }
            }
        }
    }

    fun authenticate(name: String, signIn: RemoteSignIn, executeTunnel: (Request) -> Response): Result {
        val base = "https://$name.beebo.tv"
        val request = Request.Builder().url("$base/api/remote-session")
            .post(ByteArray(0).toRequestBody(null)).header("Accept", "application/json").build()
        val initial = executeTunnel(request).use { response ->
            response.code to decode(response.body?.string().orEmpty())
        }
        if (successful(initial.first, initial.second)) return Result.SignedIn(initial.second!!)
        if (initial.first == 401 && initial.second?.needsSecondStep == true) return Result.Refused(CODE_PROMPT, initial.second!!.challenge)
        val needsOwnPassword = initial.first == 403 && initial.second?.error == "private_profile_sign_in"
        if (!needsOwnPassword || signIn.kind != RemoteSignIn.Kind.MEMBER || signIn.id.isBlank() || signIn.secret.isEmpty()) {
            return Result.Refused(RemoteMessages.remoteSession(if (initial.first == 404) "" else initial.second?.error.orEmpty()))
        }

        // Only MEMBER contains the local profile's username/password. Owner, guest and household
        // credentials must never be repurposed as a private profile password or an account bypass.
        val payload = ApiClient.JSON.encodeToString(LoginRequest.serializer(), LoginRequest(signIn.id.trim(), signIn.secret))
        val login = Request.Builder().url("$base/api/login")
            .post(payload.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .header("Accept", "application/json").build()
        return executeTunnel(login).use { response ->
            val body = decode(response.body?.string().orEmpty())
            when {
                successful(response.code, body) -> Result.SignedIn(body!!)
                response.code == 401 && body?.needsSecondStep == true -> Result.Refused(CODE_PROMPT, body.challenge)
                response.code == 429 -> Result.Refused("Too many sign-in attempts. Wait a few minutes, then try again with your own Beebo profile password.")
                body != null && (body.locked || body.error == "bad_credentials") -> Result.Refused(body.failureMessage())
                body?.error == "private_profile_sign_in" -> Result.Refused(RemoteMessages.remoteSession(body.error))
                response.code == 401 -> Result.Refused("Your home Beebo could not confirm that password. Sign in with your own current profile username and password.")
                response.code in 300..399 -> Result.Refused("Your home Beebo redirected the sign-in request. No password was forwarded. Reconnect and try again.")
                else -> Result.Refused("Your home Beebo could not complete profile sign-in. Try again, or check the Beebo program on your computer.")
            }
        }
    }

    private fun decode(body: String): LoginResponse? =
        runCatching { ApiClient.JSON.decodeFromString(LoginResponse.serializer(), body) }.getOrNull()

    private fun successful(code: Int, body: LoginResponse?): Boolean =
        code == 200 && body?.ok == true && !body.token.isNullOrBlank() && !body.user?.id.isNullOrBlank()
}
