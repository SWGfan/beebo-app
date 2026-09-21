package com.beeboentertainment.movie.server

import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.UnauthorizedException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * A refusal or failure from one of the server's JSON routes: [status] is the HTTP status (0 when
 * the answer could not be read at all), [code] the server's machine-readable `error`
 * ("tuners_busy", "wrong_password", "not_found"...), [message] something safe to show. The
 * message has been through [SafeText]: a server can put anything in there.
 */
class ServerException(
    val status: Int,
    val code: String,
    message: String,
) : IOException(message) {
    val isNotFound: Boolean get() = status == 404 && (code == "not_found" || code.isEmpty())
}

/** What the server said when it said no. Pure, so the mapping is unit tested. */
data class ServerFailure(val status: Int, val code: String, val message: String?)

object ServerErrors {

    /**
     * Reads `{ ok:false, error, message }` out of a failure body. A body that is not JSON (an HTML
     * page from a proxy, an older server's plain text) gives an empty code and no message.
     */
    fun parse(status: Int, body: String?): ServerFailure {
        val obj: JsonObject? = try {
            if (body.isNullOrBlank()) null else ApiClient.JSON.parseToJsonElement(body).jsonObject
        } catch (_: Exception) {
            null
        }
        val code = obj?.get("error")?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }.orEmpty()
        val message = obj?.get("message")?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
        return ServerFailure(status, SafeText.code(code), message?.let { SafeText.clean(it, 300) }?.ifBlank { null })
    }

    /** A plain-words line for a failure that carried no message of its own. */
    fun fallbackMessage(status: Int, code: String): String = when {
        code == "unauthorized" || status == 401 -> "Your sign-in ended. Sign in again."
        code == "rate_limited" || status == 429 -> "Slow down a little, then try again."
        code == "admin_only" -> "Only the person who runs Beebo can do that."
        code == "not_available_to_guests" -> "That is not available in a library shared with you."
        code == "restricted_profile" -> "That is not available on a profile with parental controls."
        status == 404 -> "Your Beebo computer doesn't have that. It may need an update."
        status == 413 -> "That was too big to send."
        status in 500..599 -> "Your Beebo computer had a problem. Try again in a moment."
        else -> "That didn't work."
    }
}

/**
 * The bearer-token JSON client the new feature screens share (Live TV, Audiobooks, Podcasts,
 * Radio, Account security, Watch together). It rides the app's own OkHttp client, so away from
 * home every call still goes over the tunnel, and the same cleartext policy applies.
 *
 * The token and address are read through lambdas at call time (a sign-in can change them between
 * calls), and it never logs a URL or a token.
 *
 * A 401 is a dead session (UnauthorizedException, so the screen can send the person to sign-in)
 * unless the server named a reason ("wrong_password", "invalid_code"...), which is an answer to
 * this request and is thrown as a [ServerException] instead.
 */
class ServerJson(
    private val baseUrl: () -> String?,
    private val token: () -> String?,
    private val http: OkHttpClient,
) {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    private fun request(method: String, path: String, body: String?): Request {
        val url = UrlUtils.endpoint(baseUrl(), path) ?: throw ServerException(0, "no_server", "No server address is set.")
        val t = token()
        if (t.isNullOrBlank()) throw UnauthorizedException("no token")
        val b = Request.Builder().url(url)
            .header("Authorization", "Bearer $t")
            .header("Accept", "application/json")
        when (method) {
            "GET" -> b.get()
            "DELETE" -> if (body == null) b.delete() else b.delete(body.toRequestBody(jsonType))
            else -> b.method(method, (body ?: "{}").toRequestBody(jsonType))
        }
        return b.build()
    }

    /** Runs a request and returns (status, body) without throwing on an HTTP error status. */
    suspend fun exchange(method: String, path: String, body: String? = null): Pair<Int, String> = withContext(Dispatchers.IO) {
        val req = request(method, path, body)
        val response = try {
            http.newCall(req).execute()
        } catch (e: IOException) {
            throw ServerException(0, "unreachable", "Can't reach your Beebo computer right now.")
        }
        response.use { r -> r.code to r.body?.string().orEmpty() }
    }

    /** Throws for any failure status; otherwise returns the body text. */
    suspend fun text(method: String, path: String, body: String? = null): String {
        val (status, text) = exchange(method, path, body)
        if (status in 200..299) return text
        throw failure(status, text)
    }

    suspend fun <T> get(path: String, serializer: KSerializer<T>): T = decode(text("GET", path), serializer)

    suspend fun <T> post(path: String, body: JsonElement?, serializer: KSerializer<T>): T =
        decode(text("POST", path, body?.toString() ?: "{}"), serializer)

    suspend fun <T> put(path: String, body: JsonElement?, serializer: KSerializer<T>): T =
        decode(text("PUT", path, body?.toString() ?: "{}"), serializer)

    suspend fun <T> delete(path: String, serializer: KSerializer<T>): T = decode(text("DELETE", path), serializer)

    suspend fun <T> decodeOrNull(body: String, serializer: KSerializer<T>): T? = decodeQuietly(body, serializer)

    private fun <T> decode(text: String, serializer: KSerializer<T>): T =
        decodeQuietly(text, serializer)
            ?: throw ServerException(0, "bad_response", "This Beebo computer sent something the app doesn't understand. It may need an update.")

    private fun <T> decodeQuietly(text: String, serializer: KSerializer<T>): T? =
        try { ApiClient.JSON.decodeFromString(serializer, text) } catch (_: Exception) { null }

    companion object {
        /** Maps a failure status and body to what to throw. Public so tests can pin the mapping. */
        fun failure(status: Int, body: String?): IOException {
            val f = ServerErrors.parse(status, body)
            if (status == 401 && (f.code.isEmpty() || f.code == "unauthorized")) return UnauthorizedException()
            return ServerException(status, f.code, f.message ?: ServerErrors.fallbackMessage(status, f.code))
        }

        fun obj(vararg pairs: Pair<String, JsonElement?>): JsonObject =
            JsonObject(pairs.filter { it.second != null }.associate { it.first to it.second!! })

        fun str(v: String?): JsonElement? = v?.let { JsonPrimitive(it) }
        fun num(v: Number?): JsonElement? = v?.let { JsonPrimitive(it) }
        fun bool(v: Boolean?): JsonElement? = v?.let { JsonPrimitive(it) }

        @Volatile private var shared: ServerJson? = null

        /** The app's client. Only called from running screens, never from unit tests. */
        fun get(): ServerJson = shared ?: synchronized(this) {
            shared ?: com.beeboentertainment.movie.BeeboApp.instance.let { app ->
                ServerJson({ app.session.baseUrl }, { app.session.token }, app.api.okHttp)
            }.also { shared = it }
        }
    }
}
