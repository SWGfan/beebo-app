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
        data class Refused(val message: String) : Result()
    }

    fun authenticate(name: String, signIn: RemoteSignIn, executeTunnel: (Request) -> Response): Result {
        val base = "https://$name.beebo.tv"
        val request = Request.Builder().url("$base/api/remote-session")
            .post(ByteArray(0).toRequestBody(null)).header("Accept", "application/json").build()
        val initial = executeTunnel(request).use { response ->
            response.code to decode(response.body?.string().orEmpty())
        }
        if (successful(initial.first, initial.second)) return Result.SignedIn(initial.second!!)
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
