package com.beeboentertainment.movie.data

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
 * Narrow client for the optional Beebo Points service. It uses only a Rewards
 * token issued by /auth/rewards-login, never the media-server or hub token.
 */
class RewardsClient(
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
    @Serializable data class LoginResponse(val token: String = "", val expiresAt: Long = 0, val error: String? = null)
    @Serializable data class Offer(val id: String, val type: String, val title: String, val description: String, val estimatedSeconds: Int, val points: Int, val provider: String)
    @Serializable data class Rewards(val adsEnabled: Boolean = false, val personalizedAds: Boolean = false, val points: Int = 0, val pointsPolicy: String = "", val consentVersion: String? = null, val offers: List<Offer> = emptyList())
    @Serializable data class Policy(val disclosure: String = "", val pointsNeverExpire: Boolean = true, val dailyOfferLimit: Int = 0)
    @Serializable data class StateResponse(val ok: Boolean = false, val rewards: Rewards = Rewards(), val advertisingAvailable: Boolean = false, val policy: Policy = Policy(), val error: String? = null)
    @Serializable private data class Preferences(val adsEnabled: Boolean, val personalizedAds: Boolean)

    private suspend fun request(request: Request): Pair<Int, String> = withContext(Dispatchers.IO) {
        try { http.newCall(request).execute().use { it.code to it.body?.string().orEmpty() } }
        catch (error: IOException) { throw ApiException("Beebo Points could not connect. Check your internet and try again.") }
    }
    private fun endpoint(path: String) = baseUrl.trimEnd('/') + path
    private fun auth(token: String) = "Bearer $token"

    suspend fun login(email: String, password: String): LoginResponse {
        val body = json.encodeToString(LoginRequest.serializer(), LoginRequest(email.trim(), password)).toRequestBody(mediaType)
        val (code, text) = request(Request.Builder().url(endpoint("/auth/rewards-login")).post(body).build())
        val response = runCatching { json.decodeFromString(LoginResponse.serializer(), text) }.getOrDefault(LoginResponse(error = "Could not read the sign-in response."))
        if (code !in 200..299 || response.token.isBlank()) throw ApiException(if (response.error == "invalid_credentials") "That email or password was not accepted." else response.error ?: "Rewards sign-in could not finish.", code)
        return response
    }
    suspend fun state(token: String): StateResponse {
        val (code, text) = request(Request.Builder().url(endpoint("/rewards/me")).header("Authorization", auth(token)).get().build())
        val response = runCatching { json.decodeFromString(StateResponse.serializer(), text) }.getOrDefault(StateResponse(error = "Could not read your Rewards status."))
        if (code == 401) throw UnauthorizedException("Rewards sign-in expired. Please sign in again.")
        if (code !in 200..299 || !response.ok) throw ApiException(response.error ?: "Rewards status could not be checked.", code)
        return response
    }
    suspend fun preferences(token: String, adsEnabled: Boolean, personalizedAds: Boolean): StateResponse {
        val payload = json.encodeToString(Preferences.serializer(), Preferences(adsEnabled, personalizedAds && adsEnabled)).toRequestBody(mediaType)
        val (code, text) = request(Request.Builder().url(endpoint("/rewards/preferences")).header("Authorization", auth(token)).post(payload).build())
        val response = runCatching { json.decodeFromString(StateResponse.serializer(), text) }.getOrDefault(StateResponse(error = "Could not save your Rewards choice."))
        if (code == 401) throw UnauthorizedException("Rewards sign-in expired. Please sign in again.")
        if (code !in 200..299 || !response.ok) throw ApiException(response.error ?: "Rewards choice could not be saved.", code)
        return response
    }
}
