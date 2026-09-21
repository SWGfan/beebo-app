package com.beeboentertainment.auto.data

import com.beeboentertainment.movie.rtc.Route
import com.beeboentertainment.movie.rtc.RouteRule
import com.beeboentertainment.movie.rtc.TunnelClient
import com.beeboentertainment.movie.rtc.TunnelInterceptor
import com.beeboentertainment.movie.rtc.TunnelLink
import com.beeboentertainment.movie.rtc.TunnelLinkFactory
import com.beeboentertainment.movie.rtc.TunnelLinkListener
import com.beeboentertainment.movie.rtc.TunnelProtocol
import com.beeboentertainment.movie.rtc.TunnelRouter
import com.beeboentertainment.movie.rtc.TunnelRouting
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * The car app's own HTTP clients against a fake home computer on the tunnel: what ExoPlayer,
 * the browse API and the posters really use. The shared TunnelClientTest covers the tunnel
 * itself; this covers how this app plugs into it.
 */
class HttpTunnelTest {

    private val film = ByteArray(200_000) { (it * 7 xor (it ushr 5)).toByte() }
    private val requests = CopyOnWriteArrayList<JsonObject>()
    private lateinit var tunnel: TunnelClient

    private inner class FakeLink(val listener: TunnelLinkListener) : TunnelLink {
        private val pool = Executors.newSingleThreadExecutor()
        @Volatile private var open = true
        override val features = TunnelProtocol.HostFeatures(2, setOf("headers", "body-chunks", "set-cookies", "resp-headers"), 1_000_000, 16384)
        override val isOpen get() = open
        override val relayed = false

        override fun send(frame: TunnelProtocol.Frame) {
            if (!open) throw IOException("closed")
            val text = (frame as? TunnelProtocol.Frame.Text)?.text ?: return
            val o = Json.parseToJsonElement(text).jsonObject
            if (o["kind"]?.jsonPrimitive?.content != "req") return
            requests.add(o)
            pool.execute { serve(o) }
        }

        private fun serve(req: JsonObject) {
            val id = req["id"]!!.jsonPrimitive.content
            val path = req["path"]!!.jsonPrimitive.content
            val token = req["headers"]?.jsonObject?.get(MediaTokenHeader.HEADER)?.jsonPrimitive?.contentOrNull
            when {
                path.startsWith("/file") -> {
                    val m = Regex("""bytes=(\d+)-(\d*)""").find(req["range"]?.jsonPrimitive?.contentOrNull ?: "")
                    val start = m?.groupValues?.get(1)?.toInt() ?: 0
                    val end = m?.groupValues?.get(2)?.takeIf { it.isNotEmpty() }?.toInt() ?: (film.size - 1)
                    listener.onText(this, buildJsonObject {
                        put("kind", "head"); put("id", id); put("status", if (m != null) 206 else 200)
                        put("ctype", "video/mp4"); put("clen", (end - start + 1).toString())
                        put("crange", if (m != null) "bytes $start-$end/${film.size}" else "")
                        put("headers", buildJsonObject {
                            put("accept-ranges", "bytes")
                            put(MediaTokenHeader.CAPABILITY, "1")
                            put("x-seen-token", token ?: "")
                        })
                    }.toString())
                    var off = start
                    while (off <= end) {
                        val n = minOf(16_000, end - off + 1)
                        listener.onBinary(this, TunnelProtocol.frame(id, film, off, n))
                        off += n
                    }
                    listener.onText(this, buildJsonObject { put("kind", "end"); put("id", id) }.toString())
                }
                path.startsWith("/login-page") -> {
                    val body = "<html>sign in</html>".toByteArray()
                    listener.onText(this, buildJsonObject {
                        put("kind", "head"); put("id", id); put("status", 200)
                        put("ctype", "text/html; charset=utf-8"); put("clen", body.size.toString())
                    }.toString())
                    listener.onBinary(this, TunnelProtocol.frame(id, body))
                    listener.onText(this, buildJsonObject { put("kind", "end"); put("id", id) }.toString())
                }
                else -> {
                    val body = """{"ok":true,"apiVersion":3}""".toByteArray()
                    listener.onText(this, buildJsonObject {
                        put("kind", "head"); put("id", id); put("status", 200)
                        put("ctype", "application/json"); put("clen", body.size.toString())
                        put("headers", buildJsonObject { put(MediaTokenHeader.CAPABILITY, "1") })
                    }.toString())
                    listener.onBinary(this, TunnelProtocol.frame(id, body))
                    listener.onText(this, buildJsonObject { put("kind", "end"); put("id", id) }.toString())
                }
            }
        }

        override fun close() {
            if (!open) return
            open = false
            listener.onClosed(this)
            pool.shutdown()
        }
    }

    @Before fun setUp() {
        MediaTokenHeader.forgetAll()
        tunnel = TunnelClient(TunnelLinkFactory { l -> FakeLink(l) })
        TunnelRouting.router = object : TunnelRouter {
            override fun routeFor(url: String): Route =
                if (RouteRule.isTunnelUrl(url, "nick")) Route.Tunnel("nick") else Route.Plain
            override fun client(name: String): TunnelClient? = tunnel.takeIf { name == "nick" }
            override fun directFailed(name: String) {}
        }
    }

    @After fun tearDown() {
        TunnelRouting.router = null
        tunnel.shutdown()
        MediaTokenHeader.forgetAll()
    }

    @Test fun `the tunnel is the last interceptor on every client`() {
        for ((name, c) in listOf("api" to Http.client(), "stream" to Http.streamClient(), "artwork" to Http.artworkClient())) {
            assertTrue("$name: last interceptor", c.interceptors.last() is TunnelInterceptor)
            assertEquals("$name: exactly one tunnel", 1, c.interceptors.count { it is TunnelInterceptor })
        }
    }

    @Test fun `the API reaches the home computer through the tunnel`() {
        Http.client().newCall(Request.Builder().url("https://nick.beebo.tv/api/ping").build()).execute().use { r ->
            assertEquals(200, r.code)
            assertEquals("""{"ok":true,"apiVersion":3}""", r.body!!.string())
            // The response keeps the address the app used, so per-server state stays keyed on it.
            assertEquals("https://nick.beebo.tv/api/ping", r.request.url.toString())
        }
        assertEquals("/api/ping", requests.single()["path"]!!.jsonPrimitive.content)
        // ...and learned, from the tunnelled answer, that this server reads the media token header.
        assertTrue(MediaTokenHeader.serverAccepts("https://nick.beebo.tv/file?id=1&mt=abc"))
    }

    @Test fun `the player seeks with Range, and its media token travels as a header`() {
        MediaTokenHeader.noteResponse("https://nick.beebo.tv/", "1")
        val req = Request.Builder()
            .url("https://nick.beebo.tv/file?id=42&mt=secret")
            .header("Range", "bytes=50000-99999")
            .build()
        Http.streamClient().newCall(req).execute().use { r ->
            assertEquals(206, r.code)
            assertEquals("bytes 50000-99999/${film.size}", r.header("Content-Range"))
            assertEquals("secret", r.header("x-seen-token"))
            assertArrayEquals(film.copyOfRange(50_000, 100_000), r.body!!.bytes())
        }
        val sent = requests.single()
        assertEquals("/file?id=42", sent["path"]!!.jsonPrimitive.content)
        assertEquals("bytes=50000-99999", sent["range"]!!.jsonPrimitive.content)
    }

    @Test fun `a whole film plays through the stream client`() {
        Http.streamClient().newCall(Request.Builder().url("https://nick.beebo.tv/file?id=42&mt=t").build()).execute().use { r ->
            assertEquals(200, r.code)
            assertArrayEquals(film, r.body!!.bytes())
        }
    }

    @Test fun `a login page from the tunnel is a plain sign-in message, not a broken film`() {
        try {
            Http.streamClient().newCall(Request.Builder().url("https://nick.beebo.tv/login-page").build()).execute().close()
            fail("expected the login-page guard")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("sign in again"))
        }
    }
}
