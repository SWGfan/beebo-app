package com.beeboentertainment.movie.rtc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okio.ByteString.Companion.decodeBase64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class TunnelProtocolTest {

    private val v2 = TunnelProtocol.HostFeatures(2, setOf("headers", "body-chunks", "set-cookies", "resp-headers"), 8L * 1024 * 1024, 16384)
    private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject
    private fun text(f: TunnelProtocol.Frame) = (f as TunnelProtocol.Frame.Text).text

    @Test fun `hello and abort are what the host agent expects`() {
        assertEquals("""{"kind":"hello","proto":2}""", TunnelProtocol.hello())
        assertEquals("""{"kind":"abort","id":"7"}""", TunnelProtocol.abort("7"))
    }

    @Test fun `a GET with Range and Authorization`() {
        val frames = TunnelProtocol.encodeRequest(
            "7", "GET", "/file?id=a%20b",
            listOf("Range" to "bytes=100-", "Authorization" to "Bearer t", "Accept-Encoding" to "gzip", "Host" to "x", "Connection" to "keep-alive"),
            null, null, null, v2,
        )
        assertEquals(1, frames.size)
        val o = obj(text(frames[0]))
        assertEquals("req", o["kind"]!!.jsonPrimitive.content)
        assertEquals("7", o["id"]!!.jsonPrimitive.content)
        assertEquals("GET", o["method"]!!.jsonPrimitive.content)
        assertEquals("/file?id=a%20b", o["path"]!!.jsonPrimitive.content)
        assertEquals("bytes=100-", o["range"]!!.jsonPrimitive.content)
        val h = o["headers"]!!.jsonObject
        assertEquals("Bearer t", h["Authorization"]!!.jsonPrimitive.content)
        assertEquals(setOf("Authorization"), h.keys)
        assertNull(o["body"]); assertNull(o["cookie"]); assertNull(o["ctype"])
    }

    @Test fun `a small JSON body goes inline as base64 with its content type`() {
        val body = """{"sessionId":"s","currentTime":12.5}""".toByteArray()
        val frames = TunnelProtocol.encodeRequest("3", "POST", "/api/progress", emptyList(), body, "application/json; charset=utf-8", null, TunnelProtocol.HostFeatures.LEGACY)
        assertEquals(1, frames.size)
        val o = obj(text(frames[0]))
        assertEquals("application/json; charset=utf-8", o["ctype"]!!.jsonPrimitive.content)
        assertArrayEquals(body, o["body"]!!.jsonPrimitive.content.decodeBase64()!!.toByteArray())
    }

    @Test fun `a big body is chunked in binary frames framed like responses, then bend`() {
        val body = ByteArray(100_000) { (it % 251).toByte() }
        val frames = TunnelProtocol.encodeRequest("9", "PUT", "/up", emptyList(), body, "application/octet-stream", null, v2)
        val head = obj(text(frames.first()))
        assertEquals(true, head["bodyChunks"]!!.jsonPrimitive.content.toBoolean())
        assertEquals("100000", head["blen"]!!.jsonPrimitive.content)
        assertNull(head["body"])
        assertEquals("""{"kind":"bend","id":"9"}""", text(frames.last()))
        val out = java.io.ByteArrayOutputStream()
        for (f in frames.subList(1, frames.size - 1)) {
            val (id, payload) = TunnelProtocol.unframe((f as TunnelProtocol.Frame.Binary).bytes)!!
            assertEquals("9", id)
            assertTrue(payload.size <= 16384)
            out.write(payload)
        }
        assertArrayEquals(body, out.toByteArray())
        assertEquals(2 + 7, frames.size)   // ceil(100000/16384) = 7
    }

    @Test fun `a body too big for an old host, or over the cap, is refused before sending`() {
        val big = ByteArray(TunnelProtocol.INLINE_BODY_MAX + 1)
        try {
            TunnelProtocol.encodeRequest("1", "POST", "/x", emptyList(), big, null, null, TunnelProtocol.HostFeatures.LEGACY); fail()
        } catch (e: TunnelProtocol.BodyTooLargeException) { assertEquals(TunnelProtocol.INLINE_BODY_MAX.toLong(), e.max) }
        val small = v2.copy(maxBody = 40_000)
        try {
            TunnelProtocol.encodeRequest("1", "POST", "/x", emptyList(), ByteArray(40_001), null, null, small); fail()
        } catch (e: TunnelProtocol.BodyTooLargeException) { assertEquals(40_000L, e.max) }
        // Exactly the inline limit still goes inline, to either host.
        assertEquals(1, TunnelProtocol.encodeRequest("1", "POST", "/x", emptyList(), ByteArray(TunnelProtocol.INLINE_BODY_MAX), null, null, TunnelProtocol.HostFeatures.LEGACY).size)
    }

    @Test fun `cookies merge by name with the caller's own winning`() {
        assertEquals("sid=new; theme=dark", TunnelProtocol.mergeCookies("sid=new", "sid=old; theme=dark"))
        assertNull(TunnelProtocol.mergeCookies(null, null))
        val o = obj(text(TunnelProtocol.encodeRequest("1", "GET", "/", listOf("Cookie" to "a=1"), null, null, "b=2; a=0", v2)[0]))
        assertEquals("b=2; a=1", o["cookie"]!!.jsonPrimitive.content)
    }

    @Test fun `frames round-trip, and short ones are rejected`() {
        val f = TunnelProtocol.frame("12", byteArrayOf(1, 2, 3))
        assertArrayEquals(byteArrayOf(0, 2, '1'.code.toByte(), '2'.code.toByte(), 1, 2, 3), f)
        val (id, p) = TunnelProtocol.unframe(f)!!
        assertEquals("12", id); assertArrayEquals(byteArrayOf(1, 2, 3), p)
        assertNull(TunnelProtocol.unframe(byteArrayOf(0)))
        assertNull(TunnelProtocol.unframe(byteArrayOf(0, 5, 1)))
        assertEquals(0, TunnelProtocol.unframe(TunnelProtocol.frame("x", ByteArray(0)))!!.second.size)
    }

    @Test fun `a 206 head from the agent (strings, empty means absent)`() {
        val m = TunnelProtocol.parseText(
            """{"kind":"head","id":"4","status":206,"ctype":"video/mp4","clen":"100","crange":"bytes 100-199/5000","setcookie":"","location":"",""" +
                """"setcookies":["a=1; Path=/","b=2"],"headers":{"cache-control":"no-store","x-beebo-media-token-header":"1","content-length":"999","x-bad":"a\r\nb"}}"""
        ) as TunnelProtocol.Incoming.Head
        assertEquals("4", m.id)
        val h = m.head
        assertEquals(206, h.status); assertEquals(100L, h.contentLength); assertEquals("video/mp4", h.contentType)
        assertEquals(listOf("a=1; Path=/", "b=2"), h.setCookies)
        val names = h.headers.map { it.first.lowercase() }
        assertTrue("content-range" in names && "accept-ranges" in names && "cache-control" in names && "x-beebo-media-token-header" in names)
        assertEquals(1, names.count { it == "content-length" })
        assertFalse("location" in names || "x-bad" in names)
        assertEquals(2, names.count { it == "set-cookie" })
    }

    @Test fun `a head from the old in-app host (numbers and nulls)`() {
        val h = (TunnelProtocol.parseText("""{"kind":"head","id":"1","status":302,"ctype":"text/html","clen":null,"crange":null,"location":"/login","setcookie":"sid=x; HttpOnly"}""") as TunnelProtocol.Incoming.Head).head
        assertEquals(302, h.status); assertEquals(-1L, h.contentLength)
        assertEquals(listOf("sid=x; HttpOnly"), h.setCookies)
        assertTrue(h.headers.contains("Location" to "/login"))
        assertEquals(12345L, (TunnelProtocol.parseText("""{"kind":"head","id":"1","status":200,"clen":12345}""") as TunnelProtocol.Incoming.Head).head.contentLength)
    }

    @Test fun `end, err, hello and junk`() {
        assertEquals(TunnelProtocol.Incoming.End("2"), TunnelProtocol.parseText("""{"kind":"end","id":"2"}"""))
        assertEquals(TunnelProtocol.Incoming.Err("2", 413), TunnelProtocol.parseText("""{"kind":"err","id":"2","status":413}"""))
        val hello = (TunnelProtocol.parseText("""{"kind":"hello","proto":2,"features":["headers","body-chunks"],"maxBody":524288,"bodyChunk":16384}""") as TunnelProtocol.Incoming.Hello).features
        assertTrue(hello.headers && hello.bodyChunks && !hello.isLegacy)
        assertEquals(524288L, hello.maxBody)
        assertTrue(TunnelProtocol.HostFeatures.LEGACY.isLegacy)
        assertEquals(TunnelProtocol.Incoming.Ignored, TunnelProtocol.parseText("not json"))
        assertEquals(TunnelProtocol.Incoming.Ignored, TunnelProtocol.parseText("""{"kind":"head"}"""))
    }

    // ---- compatibility: every combination of an older or newer app with an older or newer host

    /** What desktop 0.1.57's agent answers (no frame, no stripes). */
    private val oldHostHello = """{"kind":"hello","proto":2,"features":["headers","body-chunks","set-cookies","resp-headers"],"maxBody":8388608,"bodyChunk":16384}"""

    /** What a newer agent answers. */
    private val newHostHello = """{"kind":"hello","proto":2,"features":["headers","body-chunks","set-cookies","resp-headers","big-frames","stripe"],"maxBody":8388608,"bodyChunk":32768,"frame":65533,"stripes":4}"""

    private fun features(text: String) = (TunnelProtocol.parseText(text) as TunnelProtocol.Incoming.Hello).features

    @Test fun `a new app on an old host reads no frame size and no stripes, everything else as before`() {
        val f = features(oldHostHello)
        assertTrue(f.headers && f.bodyChunks && !f.isLegacy)
        assertFalse(f.bigFrames)
        assertFalse(f.stripe)
        assertEquals(0, f.frame)
        assertEquals(0, f.stripes)
        assertEquals(16384, f.bodyChunk)
        // An old host never answers the hello at all: the legacy features have neither.
        assertFalse(TunnelProtocol.HostFeatures.LEGACY.stripe)
        assertFalse(TunnelProtocol.HostFeatures.LEGACY.bigFrames)
        assertEquals(1, TunnelStripe.connectionsFor(features(oldHostHello), 900L * 1024 * 1024, true))
    }

    @Test fun `a new app on a new host reads the new fields`() {
        val f = features(newHostHello)
        assertTrue(f.bigFrames)
        assertTrue(f.stripe)
        assertEquals(65533, f.frame)
        assertEquals(4, f.stripes)
        assertEquals(32768, f.bodyChunk)
        assertEquals(4, TunnelStripe.connectionsFor(f, 900L * 1024 * 1024, true))
        // An upload is cut into what the host asked for, capped below a data channel message.
        val body = ByteArray(200_000) { it.toByte() }
        val frames = TunnelProtocol.encodeRequest("9", "PUT", "/u", emptyList(), body, "application/octet-stream", null, f)
        val sizes = frames.filterIsInstance<TunnelProtocol.Frame.Binary>().map { it.bytes.size - (2 + 1) }
        assertEquals(32768, sizes.first())
        assertEquals(body.size, sizes.sum())
        // ...and an old host's smaller hint is respected exactly as before.
        val small = TunnelProtocol.encodeRequest("9", "PUT", "/u", emptyList(), body, "application/octet-stream", null, features(oldHostHello))
        assertEquals(16384, (small[1] as TunnelProtocol.Frame.Binary).bytes.size - 3)
    }

    @Test fun `an old app on a new host sends the same plain hello, and the extra fields are harmless`() {
        // What every released app sends, byte for byte.
        assertEquals("""{"kind":"hello","proto":2}""", TunnelProtocol.hello())
        assertEquals("""{"kind":"hello","proto":2}""", TunnelProtocol.hello(null))
        // The old parser read only kind/proto/features/maxBody/bodyChunk; the new host's answer
        // still holds all of them in the same shape, with the same meanings.
        val o = obj(newHostHello)
        assertEquals("hello", o["kind"]!!.jsonPrimitive.content)
        assertEquals("2", o["proto"]!!.jsonPrimitive.content)
        assertEquals("8388608", o["maxBody"]!!.jsonPrimitive.content)
        assertEquals("32768", o["bodyChunk"]!!.jsonPrimitive.content)
        assertTrue(o["features"].toString().contains("\"headers\""))
    }

    @Test fun `an extra connection names its primary, and the answer says whether it was taken in`() {
        val h = obj(TunnelProtocol.hello("vabc123"))
        assertEquals("hello", h["kind"]!!.jsonPrimitive.content)
        assertEquals("2", h["proto"]!!.jsonPrimitive.content)
        assertEquals("vabc123", h["stripeOf"]!!.jsonPrimitive.content)
        // Taken in.
        val ok = TunnelProtocol.parseStripeAnswer("""{"kind":"hello","proto":2,"stripes":4,"stripeOf":"vabc123"}""")!!
        assertEquals("vabc123", ok.joined)
        assertNull(ok.error)
        // Refused, with a reason.
        val no = TunnelProtocol.parseStripeAnswer("""{"kind":"hello","proto":2,"stripes":4,"stripeError":"not_same_viewer"}""")!!
        assertNull(no.joined)
        assertEquals("not_same_viewer", no.error)
        // An old host says nothing about it: not taken in, no reason.
        val old = TunnelProtocol.parseStripeAnswer(oldHostHello)!!
        assertNull(old.joined)
        assertNull(old.error)
        // Not a hello at all, or not JSON.
        assertNull(TunnelProtocol.parseStripeAnswer("""{"kind":"end","id":"1"}"""))
        assertNull(TunnelProtocol.parseStripeAnswer("garbage"))
    }

    @Test fun `silly frame and stripe numbers in a hello are not believed`() {
        val f = features("""{"kind":"hello","proto":2,"features":["stripe","big-frames"],"frame":5,"stripes":99}""")
        assertEquals(0, f.frame)
        assertEquals(0, f.stripes)
        assertFalse("the name without a believable count is no offer", f.stripe)
        val g = features("""{"kind":"hello","proto":2,"features":["stripe"],"frame":"65533","stripes":"3"}""")
        assertEquals("numbers sent as strings are accepted, like the other fields", 65533, g.frame)
        assertEquals(3, g.stripes)
        assertTrue(g.stripe)
        assertEquals(0, features("""{"kind":"hello","proto":2,"stripes":-1}""").stripes)
    }

    @Test fun `ranges`() {
        assertEquals(0L, TunnelProtocol.rangeStart(null))
        assertEquals(100L, TunnelProtocol.rangeStart("bytes=100-"))
        assertNull(TunnelProtocol.rangeEnd("bytes=100-"))
        assertEquals(199L, TunnelProtocol.rangeEnd("bytes=100-199"))
        assertNull(TunnelProtocol.rangeStart("bytes=-500"))
        assertEquals("bytes=150-199", TunnelProtocol.resumeRange(100, 199, 50))
        assertEquals("bytes=150-", TunnelProtocol.resumeRange(100, null, 50))
        assertEquals(100L, TunnelProtocol.contentRangeStart("bytes 100-199/5000"))
        assertNull(TunnelProtocol.contentRangeStart("bytes */5000"))
    }
}
