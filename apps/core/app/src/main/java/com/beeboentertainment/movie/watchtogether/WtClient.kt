package com.beeboentertainment.movie.watchtogether

import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.server.ServerException
import com.beeboentertainment.movie.server.ServerJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.channels.awaitClose
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The Watch together routes, over the shared bearer client. The room code is a credential: it goes
 * in the request (the contract puts it in the query of the event stream and the poll) and nowhere
 * else, and this class never logs a URL.
 */
class WtClient(
    private val json: ServerJson,
    private val http: OkHttpClient,
    private val baseUrl: () -> String?,
    private val token: () -> String?,
) {
    private val root = "/api/watch-together"

    suspend fun ping(t0: Double): WtPing =
        json.post("$root/ping", buildJsonObject { put("t0", t0) }, WtPing.serializer())

    suspend fun preview(code: String): WtPreview = json.get("$root/room" + UrlUtils.query("code" to code), WtPreview.serializer())

    suspend fun create(kind: String, id: String, title: String, control: String? = null): WtJoinResponse =
        json.post(
            "$root/create",
            buildJsonObject {
                put("kind", kind); put("id", id); put("title", title)
                if (control != null) put("settings", buildJsonObject { put("control", control) })
            },
            WtJoinResponse.serializer()
        )

    suspend fun join(code: String): WtJoinResponse = json.post("$root/join", buildJsonObject { put("code", code) }, WtJoinResponse.serializer())
    suspend fun leave(code: String): WtSimpleAck = json.post("$root/leave", buildJsonObject { put("code", code) }, WtSimpleAck.serializer())
    suspend fun close(code: String): WtSimpleAck = json.post("$root/close", buildJsonObject { put("code", code) }, WtSimpleAck.serializer())

    /** play, pause, seek or rate. [cid] makes a retry safe. */
    suspend fun command(code: String, type: String, pos: Double?, rate: Double?, cid: String): WtCommandAck =
        json.post(
            "$root/command",
            buildJsonObject {
                put("code", code); put("type", type); put("cid", cid)
                pos?.let { put("pos", it) }
                rate?.let { put("rate", it) }
            },
            WtCommandAck.serializer()
        )

    suspend fun ready(code: String, ready: Boolean, seq: Long, durationSec: Double): JsonElement =
        json.post(
            "$root/ready",
            buildJsonObject { put("code", code); put("ready", ready); put("seq", seq); if (durationSec > 0) put("duration", durationSec) },
            JsonElement.serializer()
        )

    suspend fun chat(code: String, text: String): WtSimpleAck = json.post("$root/chat", buildJsonObject { put("code", code); put("text", text) }, WtSimpleAck.serializer())
    suspend fun react(code: String, emoji: String): WtSimpleAck = json.post("$root/react", buildJsonObject { put("code", code); put("emoji", emoji) }, WtSimpleAck.serializer())

    suspend fun settings(code: String, control: String? = null, waitForBuffering: Boolean? = null, chat: Boolean? = null): JsonElement =
        json.post(
            "$root/settings",
            buildJsonObject {
                put("code", code)
                put("settings", buildJsonObject {
                    control?.let { put("control", it) }
                    waitForBuffering?.let { put("waitForBuffering", it) }
                    chat?.let { put("chat", it) }
                })
            },
            JsonElement.serializer()
        )

    suspend fun transfer(code: String, pid: String): WtSimpleAck = json.post("$root/transfer", buildJsonObject { put("code", code); put("target", pid) }, WtSimpleAck.serializer())
    suspend fun kick(code: String, pid: String): WtSimpleAck = json.post("$root/kick", buildJsonObject { put("code", code); put("target", pid) }, WtSimpleAck.serializer())

    /** The same as the stream, as one request: the fallback when a network breaks streams. */
    suspend fun poll(code: String, since: String?): WtPoll =
        json.get("$root/poll" + UrlUtils.query("code" to code, "since" to since), WtPoll.serializer())

    /**
     * The room's Server-Sent Events. Ends when the connection does; the caller reconnects (sending the id
     * of the last event it saw so missed chat is replayed) or falls back to [poll]. A refusal (the room
     * ended, the person was removed) is a [ServerException].
     */
    fun events(code: String, lastEventId: String?): Flow<WtProtocol.SseEvent> = channelFlow {
        val url = UrlUtils.endpoint(baseUrl(), "$root/events" + UrlUtils.query("code" to code))
            ?: throw ServerException(0, "no_server", "No server address is set.")
        val t = token()
        if (t.isNullOrBlank()) throw UnauthorizedException("no token")
        val request = Request.Builder().url(url)
            .header("Authorization", "Bearer $t")
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .apply { if (!lastEventId.isNullOrBlank() && lastEventId.all { it.isDigit() }) header("Last-Event-ID", lastEventId) }
            .build()
        // The server sends a heartbeat every 15 s: 45 s of silence means the stream is dead.
        val call = http.newBuilder().readTimeout(45, TimeUnit.SECONDS).build().newCall(request)
        val reader = launch(Dispatchers.IO) {
            try {
                call.execute().use { r ->
                    if (!r.isSuccessful) {
                        val body = r.body?.string().orEmpty()
                        throw ServerJson.failure(r.code, body)
                    }
                    val source = r.body?.source() ?: return@use
                    val parser = WtProtocol.SseParser()
                    while (isActive) {
                        val line = source.readUtf8Line() ?: break
                        parser.feed(line)?.let { this@channelFlow.send(it) }
                    }
                }
                // The server ended the stream: end the flow, so the caller can reconnect.
                this@channelFlow.close()
            } catch (e: IOException) {
                if (!call.isCanceled() && e !is UnauthorizedException && e !is ServerException) throw ServerException(0, "unreachable", "The connection to the room dropped.")
                if (e is UnauthorizedException || e is ServerException) throw e
            }
        }
        awaitClose { call.cancel(); reader.cancel() }
    }

    companion object {
        fun get(): WtClient {
            val app = com.beeboentertainment.movie.BeeboApp.instance
            return WtClient(ServerJson.get(), app.api.okHttp, { app.session.baseUrl }, { app.session.token })
        }

        /** A fresh id for one command, so a retried command is answered, not applied twice. */
        fun newCommandId(): String = java.util.UUID.randomUUID().toString().replace("-", "").take(16)
    }
}
