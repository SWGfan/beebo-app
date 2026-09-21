package com.beeboentertainment.movie.tvpair

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The two halves of /tvpair on beebo.tv's Worker. On login.beebo.tv, the reserved host the sign-in
 * screen already uses for find-home, so it never depends on which house is being signed in to.
 *
 * Its own client, not the app's shared one: nothing here may go through the home tunnel, and a
 * poll must never wait behind a film. No secret is ever logged; a device code, a user code and a
 * token only ever appear in a request or response body.
 */
class TvPairHttp(
    private val http: OkHttpClient = defaultClient(),
    private val base: String = BASE,
) : TvPairService, TvLinkService {

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    private data class Raw(val code: Int, val body: String)

    private suspend fun post(path: String, body: String, bearer: String? = null): Raw? = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(base + path)
            .post(body.toRequestBody(jsonType))
            .header("Accept", "application/json")
            .apply { if (bearer != null) header("Authorization", "Bearer $bearer") }
            .build()
        try {
            http.newCall(req).execute().use { r -> Raw(r.code, r.body?.string().orEmpty()) }
        } catch (e: IOException) {
            null
        }
    }

    override suspend fun start(deviceName: String, deviceModel: String): StartResult {
        val body = buildJsonObject { put("device_name", deviceName); put("device_model", deviceModel) }.toString()
        val raw = post("/tvpair/start", body) ?: return StartResult.Failed(PairFailure(PairFailure.Kind.OFFLINE))
        return TvPairParsing.parseStart(raw.code, raw.body)
    }

    override suspend fun poll(deviceCode: String): PollResult {
        val body = buildJsonObject { put("device_code", deviceCode) }.toString()
        val raw = post("/tvpair/poll", body) ?: return PollResult.Failed(PairFailure(PairFailure.Kind.OFFLINE))
        return TvPairParsing.parsePoll(raw.code, raw.body)
    }

    override suspend fun lookup(token: String, userCode: String): LinkResult<TvRequest> {
        val body = buildJsonObject { put("user_code", userCode) }.toString()
        val raw = post("/tvpair/lookup", body, token) ?: return LinkResult.Refused(LinkError.OFFLINE)
        return TvLinkParsing.parseLookup(raw.code, raw.body)
    }

    override suspend fun decide(token: String, userCode: String, decision: TvDecision): LinkResult<TvRequest> {
        val body = buildJsonObject { put("user_code", userCode); put("decision", decision.wire) }.toString()
        val raw = post("/tvpair/approve", body, token) ?: return LinkResult.Refused(LinkError.OFFLINE)
        return TvLinkParsing.parseDecision(raw.code, raw.body, decision)
    }

    companion object {
        const val BASE = "https://login.beebo.tv"

        fun defaultClient(): OkHttpClient = com.beeboentertainment.movie.core.CleartextPolicy.install(
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
        ).build()
    }
}
