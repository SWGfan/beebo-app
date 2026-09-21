package com.beeboentertainment.movie.rtc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * The whole HTTP-over-tunnel client against a fake home computer that speaks the host agent's
 * protocol: Range and 206, chunked request bodies, cookies, dropping the link mid-film and
 * carrying on over a new one at the same byte, the reader-behind pause, and an old agent.
 */
class TunnelClientTest {

    private val film = ByteArray(3 * 1024 * 1024 + 123) { ((it * 31) xor (it ushr 7)).toByte() }
    private val clients = CopyOnWriteArrayList<TunnelClient>()

    @After fun tearDown() { clients.forEach { it.shutdown() } }

    /** The home computer: one film with ranges, an echo, cookies. */
    private inner class FakeHost(val legacy: Boolean = false, val chunk: Int = 16384, val chunkDelayMs: Long = 0) {
        val links = CopyOnWriteArrayList<FakeLink>()
        val requests = CopyOnWriteArrayList<JsonObject>()
        val connects = AtomicInteger()
        @Volatile var failNextConnects = 0
        /** Close the link after sending this many film bytes (once). */
        @Volatile var dropAfterBytes = -1L
        val jar = ConcurrentHashMap<String, String>()

        val factory = TunnelLinkFactory { listener ->
            connects.incrementAndGet()
            if (failNextConnects > 0) { failNextConnects--; throw TunnelConnectException("Your home computer isn't online right now.", code = "host_offline") }
            FakeLink(this, listener).also { links.add(it) }
        }
    }

    private inner class FakeLink(val host: FakeHost, val listener: TunnelLinkListener) : TunnelLink {
        private val pool = Executors.newSingleThreadExecutor()
        private val uploads = ConcurrentHashMap<String, Pair<JsonObject, java.io.ByteArrayOutputStream>>()
        val aborted = ConcurrentHashMap.newKeySet<String>()
        @Volatile private var open = true
        override val features = if (host.legacy) TunnelProtocol.HostFeatures.LEGACY
            else TunnelProtocol.HostFeatures(2, setOf("headers", "body-chunks", "set-cookies", "resp-headers"), 1_000_000, 16384)
        override val isOpen get() = open
        override val relayed = false

        override fun send(frame: TunnelProtocol.Frame) {
            if (!open) throw IOException("closed")
            when (frame) {
                is TunnelProtocol.Frame.Binary -> {
                    val (id, p) = TunnelProtocol.unframe(frame.bytes)!!
                    uploads[id]!!.second.write(p)
                }
                is TunnelProtocol.Frame.Text -> {
                    val o = Json.parseToJsonElement(frame.text).jsonObject
                    val id = o["id"]!!.jsonPrimitive.content
                    when (o["kind"]!!.jsonPrimitive.content) {
                        "abort" -> aborted.add(id)
                        "bend" -> uploads.remove(id)!!.let { (req, buf) -> pool.execute { serve(req, buf.toByteArray()) } }
                        "req" -> {
                            host.requests.add(o)
                            if (o["bodyChunks"] != null) uploads[id] = o to java.io.ByteArrayOutputStream()
                            else pool.execute { serve(o, o["body"]?.jsonPrimitive?.content?.decodeBase64()?.toByteArray()) }
                        }
                    }
                }
            }
        }

        private fun text(o: JsonObject) = listener.onText(this, o.toString())

        private fun serve(req: JsonObject, body: ByteArray?) {
            if (!open) return
            val id = req["id"]!!.jsonPrimitive.content
            val path = req["path"]!!.jsonPrimitive.content
            val headers = if (host.legacy) null else req["headers"]?.jsonObject
            val cookie = req["cookie"]?.jsonPrimitive?.contentOrNull
            when {
                path.startsWith("/film") -> {
                    val m = Regex("""bytes=(\d+)-(\d*)""").find(req["range"]?.jsonPrimitive?.contentOrNull ?: "")
                    val start = m?.groupValues?.get(1)?.toLong() ?: 0L
                    val end = m?.groupValues?.get(2)?.takeIf { it.isNotEmpty() }?.toLong() ?: (film.size - 1L)
                    text(buildJsonObject {
                        put("kind", "head"); put("id", id); put("status", if (m != null) 206 else 200); put("ctype", "video/mp4")
                        put("clen", (end - start + 1).toString())
                        put("crange", if (m != null) "bytes $start-$end/${film.size}" else "")
                        if (!host.legacy) put("headers", buildJsonObject { put("accept-ranges", "bytes") })
                    })
                    var off = start
                    while (off <= end) {
                        if (id in aborted || !open) return
                        val n = minOf(host.chunk.toLong(), end - off + 1).toInt()
                        listener.onBinary(this, TunnelProtocol.frame(id, film, off.toInt(), n))
                        off += n
                        if (host.chunkDelayMs > 0) Thread.sleep(host.chunkDelayMs)
                        if (host.dropAfterBytes in 0..(off - start - 1) && host.dropAfterBytes >= 0) {
                            host.dropAfterBytes = -1
                            close()
                            return
                        }
                    }
                    text(buildJsonObject { put("kind", "end"); put("id", id) })
                }
                path.startsWith("/echo") -> {
                    val auth = headers?.get("Authorization")?.jsonPrimitive?.contentOrNull
                    if (path.contains("needauth") && auth == null) {
                        text(buildJsonObject { put("kind", "head"); put("id", id); put("status", 401); put("ctype", "application/json"); put("clen", "") })
                        text(buildJsonObject { put("kind", "end"); put("id", id) })
                        return
                    }
                    val out = buildJsonObject {
                        put("method", req["method"]!!.jsonPrimitive.content)
                        put("auth", auth ?: "")
                        put("cookie", cookie ?: "")
                        put("ctype", req["ctype"]?.jsonPrimitive?.contentOrNull ?: "")
                        put("blen", body?.size ?: 0)
                        put("sha", body?.toByteString()?.sha256()?.hex() ?: "")
                    }.toString().toByteArray()
                    text(buildJsonObject {
                        put("kind", "head"); put("id", id); put("status", 200); put("ctype", "application/json"); put("clen", out.size.toString())
                        if (path.contains("set=1")) put("setcookies", buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive("sid=s1; Path=/; HttpOnly")); add(kotlinx.serialization.json.JsonPrimitive("t=dark")) })
                    })
                    listener.onBinary(this, TunnelProtocol.frame(id, out))
                    text(buildJsonObject { put("kind", "end"); put("id", id) })
                }
                else -> {
                    text(buildJsonObject { put("kind", "err"); put("id", id); put("status", 502) })
                }
            }
        }

        override fun close() {
            if (!open) return
            open = false
            Thread { listener.onClosed(this) }.start()
            pool.shutdown()
        }
    }

    private fun client(host: FakeHost, highWater: Long = 64L * 1024 * 1024) =
        TunnelClient(host.factory, headTimeoutMs = 5_000, readTimeoutMs = 10_000, highWaterBytes = highWater, requestWaitMs = 10_000, jitter = { -1.0 })
            .also { clients.add(it); it.connection.keepAlive = true }

    private fun get(path: String, vararg headers: Pair<String, String>) =
        Request.Builder().url("https://nick.beebo.tv$path").apply { headers.forEach { header(it.first, it.second) } }.build()

    @Test fun `a whole film and a seek, byte-exact, with 206 and Content-Range`() {
        val c = client(FakeHost())
        c.execute(get("/film")).use { r ->
            assertEquals(200, r.code)
            assertEquals(film.size.toLong(), r.body!!.contentLength())
            assertArrayEquals(film, r.body!!.bytes())
        }
        c.execute(get("/film", "Range" to "bytes=1000-1999")).use { r ->
            assertEquals(206, r.code)
            assertEquals("bytes 1000-1999/${film.size}", r.header("Content-Range"))
            assertEquals("1000", r.header("Content-Length"))
            assertArrayEquals(film.copyOfRange(1000, 2000), r.body!!.bytes())
        }
    }

    @Test fun `request bodies - inline JSON and a chunked upload - and headers`() {
        val host = FakeHost()
        val c = client(host)
        val json = """{"username":"kid","password":"p"}"""
        c.execute(Request.Builder().url("https://nick.beebo.tv/echo").header("Authorization", "Bearer abc")
            .post(json.toRequestBody("application/json; charset=utf-8".toMediaType())).build()).use { r ->
            val o = Json.parseToJsonElement(r.body!!.string()).jsonObject
            assertEquals("POST", o["method"]!!.jsonPrimitive.content)
            assertEquals("Bearer abc", o["auth"]!!.jsonPrimitive.content)
            assertEquals("application/json; charset=utf-8", o["ctype"]!!.jsonPrimitive.content)
            assertEquals(json.toByteArray().toByteString().sha256().hex(), o["sha"]!!.jsonPrimitive.content)
        }
        val big = ByteArray(200_001) { (it % 97).toByte() }
        c.execute(Request.Builder().url("https://nick.beebo.tv/echo").put(big.toRequestBody("application/octet-stream".toMediaType())).build()).use { r ->
            val o = Json.parseToJsonElement(r.body!!.string()).jsonObject
            assertEquals("200001", o["blen"]!!.jsonPrimitive.content)
            assertEquals(big.toByteString().sha256().hex(), o["sha"]!!.jsonPrimitive.content)
        }
        assertTrue(host.requests.last()["bodyChunks"] != null)
    }

    @Test fun `the session cookie is kept and sent back, across a reconnect`() {
        val host = FakeHost()
        val c = client(host)
        c.execute(get("/echo?set=1")).use { r -> assertEquals(listOf("sid=s1; Path=/; HttpOnly", "t=dark"), r.headers("Set-Cookie")); r.body!!.string() }
        host.links.last().close()
        Thread.sleep(200)
        c.execute(get("/echo")).use { r ->
            assertEquals("sid=s1; t=dark", Json.parseToJsonElement(r.body!!.string()).jsonObject["cookie"]!!.jsonPrimitive.content)
        }
        assertEquals(2, host.connects.get())
    }

    @Test fun `the connection drops mid-film and the film carries on at the same byte`() {
        val host = FakeHost()
        val c = client(host)
        host.dropAfterBytes = 1_000_000
        c.execute(get("/film", "Range" to "bytes=500-")).use { r ->
            assertEquals(206, r.code)
            assertArrayEquals(film.copyOfRange(500, film.size), r.body!!.bytes())
        }
        assertEquals(2, host.connects.get())
        val resume = host.requests.last()
        val range = resume["range"]!!.jsonPrimitive.content
        assertTrue(range, Regex("""bytes=\d+-${film.size - 1}""").matches(range))
    }

    @Test fun `a reader far behind pauses the PC and asks again from the next byte`() {
        val host = FakeHost()
        val c = client(host, highWater = 256 * 1024)
        c.execute(get("/film")).use { r ->
            Thread.sleep(500)   // let far more than the high-water mark arrive unread
            assertArrayEquals(film, r.body!!.bytes())
        }
        assertTrue("paused and resumed", host.requests.size >= 2)
        assertTrue(host.links.first().aborted.isNotEmpty())
        assertEquals(1, host.connects.get())
    }

    @Test fun `closing a body mid-film tells the PC to stop`() {
        // A paced host: the film must still be in flight when the body is closed. On a fast
        // machine an unpaced 3 MB film arrives whole first, and a finished exchange has
        // nothing left to abort (that was the intermittent CI failure).
        val host = FakeHost(chunkDelayMs = 5)
        val c = client(host)
        val r = c.execute(get("/film"))
        r.body!!.source().readByteArray(10)
        r.close()
        val id = host.requests.first()["id"]!!.jsonPrimitive.content
        // The abort travels on another thread; a fixed 100 ms is too tight on a busy CI runner.
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline && !host.links.first().aborted.contains(id)) Thread.sleep(20)
        assertTrue(host.links.first().aborted.contains(id))
    }

    @Test fun `waits out a failed connect with backoff, then answers`() {
        val host = FakeHost()
        host.failNextConnects = 2
        val c = client(host)
        c.execute(get("/echo")).use { r -> assertEquals(200, r.code); r.body!!.string() }
        assertEquals(3, host.connects.get())
    }

    @Test fun `a fatal failure fails requests at once with its words`() {
        val c = TunnelClient({ throw TunnelConnectException("Sign in again to watch away from home.", fatal = true, code = "signed_out") }, requestWaitMs = 10_000)
            .also { clients.add(it) }
        val t0 = System.currentTimeMillis()
        try { c.execute(get("/echo")); fail() } catch (e: IOException) { assertEquals("Sign in again to watch away from home.", e.message) }
        assertTrue(System.currentTimeMillis() - t0 < 5_000)
    }

    @Test fun `an old agent that drops Authorization is reported, not turned into a sign-out`() {
        val c = client(FakeHost(legacy = true))
        try {
            c.execute(get("/echo?needauth=1", "Authorization" to "Bearer abc")); fail()
        } catch (e: IOException) {
            assertEquals(TunnelClient.UPDATE_HOST_MESSAGE, e.message)
        }
        // Without a token a 401 is just a 401.
        c.execute(get("/echo?needauth=1")).use { assertEquals(401, it.code) }
    }

    @Test fun `an error from the PC before the head`() {
        val c = client(FakeHost())
        try { c.execute(get("/nothing")); fail() } catch (e: IOException) { assertTrue(e.message!!.contains("502")) }
    }
}
