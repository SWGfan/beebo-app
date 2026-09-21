package com.beeboentertainment.movie.billing

import com.beeboentertainment.movie.data.ApiException
import com.beeboentertainment.movie.data.UnauthorizedException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Narrow client for the household plan + extra-seat endpoints (worker/seatAddon.js,
 * worker/googlePlay.js). Structured exactly like [com.beeboentertainment.movie.data.RewardsClient]:
 * its own sign-in (`/auth/login`), its own token, never mixed with the hub/media-server session.
 * Lives in `main`, not `src/play`, since it's plain HTTP with no Play Billing dependency - only the
 * `play` flavour's UI happens to call [activatePlayPurchase] and [setSeats] together.
 */
class HouseholdBillingClient(
    private val http: OkHttpClient = com.beeboentertainment.movie.core.CleartextPolicy.install(OkHttpClient.Builder())
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build(),
    private val baseUrl: String = "https://login.beebo.tv",
) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
        private val mediaType = "application/json; charset=utf-8".toMediaType()
    }

    @Serializable private data class LoginRequest(val email: String, val password: String)
    @Serializable data class LoginResponse(val token: String = "", val plan: String? = null, val error: String? = null)
    @Serializable data class SeatsResponse(val seats: Int = 0, val maxExtraSeats: Int = 0, val householdLimit: Int = 0, val store: String = "none", val error: String? = null)
    @Serializable private data class SeatsRequest(val seats: Int)
    @Serializable data class ActivateResponse(val ok: Boolean = false, val plan: String? = null, val seats: Int = 0, val error: String? = null)
    @Serializable private data class ActivateRequest(val purchaseToken: String, val productId: String)
    @Serializable data class AccountIdResponse(val id: String = "", val error: String? = null)

    private suspend fun request(request: Request): Pair<Int, String> = withContext(Dispatchers.IO) {
        try { http.newCall(request).execute().use { it.code to it.body?.string().orEmpty() } }
        catch (error: IOException) { throw ApiException("Could not connect. Check your internet and try again.") }
    }
    private fun endpoint(path: String) = baseUrl.trimEnd('/') + path
    private fun auth(token: String) = "Bearer $token"

    /** Signs in with the SAME email + password already used on the desktop app. */
    suspend fun signIn(email: String, password: String): LoginResponse {
        val body = json.encodeToString(LoginRequest.serializer(), LoginRequest(email.trim(), password)).toRequestBody(mediaType)
        val (code, text) = request(Request.Builder().url(endpoint("/auth/login")).post(body).build())
        val response = runCatching { json.decodeFromString(LoginResponse.serializer(), text) }.getOrDefault(LoginResponse(error = "Could not read the sign-in response."))
        if (code !in 200..299 || response.token.isBlank()) throw ApiException(response.error ?: "That email or password was not accepted.", code)
        return response
    }

    suspend fun currentSeats(token: String): SeatsResponse {
        val (code, text) = request(Request.Builder().url(endpoint("/account/seats")).header("Authorization", auth(token)).get().build())
        val response = runCatching { json.decodeFromString(SeatsResponse.serializer(), text) }.getOrDefault(SeatsResponse(error = "Could not read your household size."))
        if (code == 401) throw UnauthorizedException("Sign-in expired. Please sign in again.")
        if (code !in 200..299) throw ApiException(response.error ?: "Household size could not be checked.", code)
        return response
    }

    /** Changes the extra-seat count. Only meaningful for a household bought through Stripe (the
     * Play-side seat count follows a Play purchase instead — see [activatePlayPurchase]). */
    suspend fun setSeats(token: String, seats: Int): SeatsResponse {
        val body = json.encodeToString(SeatsRequest.serializer(), SeatsRequest(seats)).toRequestBody(mediaType)
        val (code, text) = request(Request.Builder().url(endpoint("/account/seats")).header("Authorization", auth(token)).post(body).build())
        val response = runCatching { json.decodeFromString(SeatsResponse.serializer(), text) }.getOrDefault(SeatsResponse(error = "Could not save your household size."))
        if (code == 401) throw UnauthorizedException("Sign-in expired. Please sign in again.")
        if (code !in 200..299) throw ApiException(response.error ?: "Household size could not be saved.", code)
        return response
    }

    /** The account-binding id to pass to [PlayBillingManager]'s purchase flow as
     * `obfuscatedAccountId` - a one-way HMAC of this account's email, never the email itself,
     * that the Worker independently recomputes and checks a purchase against in
     * [activatePlayPurchase] (worker/googlePlay.js's hmacAccountId). Must be fetched fresh and
     * passed on every purchase/change - it is what stops a purchase token bought under one
     * account from activating a different one. */
    suspend fun playAccountId(token: String): String {
        val (code, text) = request(Request.Builder().url(endpoint("/play/account-id")).header("Authorization", auth(token)).get().build())
        val response = runCatching { json.decodeFromString(AccountIdResponse.serializer(), text) }.getOrDefault(AccountIdResponse(error = "Something went wrong getting ready. Try again."))
        if (code == 401) throw UnauthorizedException("Sign-in expired. Please sign in again.")
        if (code !in 200..299 || response.id.isBlank()) throw ApiException(response.error ?: "Something went wrong getting ready. Try again.", code)
        return response.id
    }

    /** Verifies a Google Play purchase and activates it, right after Play's own purchase sheet
     * closes - see docs/GOOGLE-PLAY-BILLING-AND-SEAT-ADDON.md section 4.3. */
    suspend fun activatePlayPurchase(token: String, purchaseToken: String, productId: String): ActivateResponse {
        val body = json.encodeToString(ActivateRequest.serializer(), ActivateRequest(purchaseToken, productId)).toRequestBody(mediaType)
        val (code, text) = request(Request.Builder().url(endpoint("/play/activate")).header("Authorization", auth(token)).post(body).build())
        val response = runCatching { json.decodeFromString(ActivateResponse.serializer(), text) }.getOrDefault(ActivateResponse(error = "Could not confirm your plan with Beebo."))
        if (code == 401) throw UnauthorizedException("Sign-in expired. Please sign in again.")
        if (code !in 200..299 || !response.ok) throw ApiException(response.error ?: "Your plan could not be confirmed yet. It will be reconciled automatically shortly.", code)
        return response
    }
}
