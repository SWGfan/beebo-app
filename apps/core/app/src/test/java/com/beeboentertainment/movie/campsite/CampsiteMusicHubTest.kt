package com.beeboentertainment.movie.campsite

import java.io.File
import java.net.HttpURLConnection
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.file.Files
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The synced-music channel end to end: a real [CampsiteServer] on a real socket, a hand-rolled
 * WebSocket client that behaves like a browser (masked frames, cookie from /join), and the
 * guards that keep a guest from doing anything but listen.
 */
class CampsiteMusicHubTest {
    private lateinit var dir: File
    private lateinit var server: CampsiteServer
    private val audio = HashMap<String, File>()
    private val clients = mutableListOf<WsClient>()

    private fun track(id: String, ms: Long = 60_000) = MusicTrackInfo(id, "Song $id", "Artist", "Album", ms)

    @Before fun setUp() {
        dir = Files.createTempDirectory("music-hub").toFile()
        server = CampsiteServer(0, { emptyList() }, { null }, musicTrackFile = { audio[it] }, musicScript = { "/*SCRIPT-MARKER*/" })
        server.start()
    }

    @After fun tearDown() {
        clients.forEach { it.close() }
        server.stop()
        dir.deleteRecursively()
    }

    private val port get() = server.boundPort

    private fun http(path: String, cookie: String? = null, range: String? = null): HttpURLConnection =
        (URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection).apply {
            connectTimeout = 3000; readTimeout = 3000; instanceFollowRedirects = false
            if (cookie != null) setRequestProperty("Cookie", cookie)
            if (range != null) setRequestProperty("Range", range)
        }

    private fun join(name: String): String {
        val c = http("/join?name=$name&next=music")
        try {
            assertEquals(302, c.responseCode)
            assertEquals("/music", c.getHeaderField("Location"))
            return c.headerFields.entries.filter { it.key.equals("Set-Cookie", true) }.flatMap { it.value }.joinToString("; ") { it.substringBefore(';') }
        } finally { c.disconnect() }
    }

    /** A browser-like WebSocket client. */
    inner class WsClient(val socket: Socket, val status: String) {
        private val input = socket.getInputStream()
        private val reader = CampsiteWebSocket.Reader(input, maxMessage = 1 shl 20, requireMask = false)
        private val out = socket.getOutputStream()
        private val rnd = java.util.Random(3)

        fun sendRaw(bytes: ByteArray) { out.write(bytes); out.flush() }
        fun sendText(text: String) {
            val key = ByteArray(4).also { rnd.nextBytes(it) }
            CampsiteWebSocket.writeFrame(out, CampsiteWebSocket.OP_TEXT, text.toByteArray(), key)
        }
        fun send(json: String) = sendText(json)

        /** Next frame of any kind, or null on timeout/EOF. */
        fun frame(timeoutMs: Int = 3000): CampsiteWebSocket.Message? {
            socket.soTimeout = timeoutMs
            return try {
                when (val item = reader.next()) { is CampsiteWebSocket.Message -> item; else -> null }
            } catch (e: SocketTimeoutException) { null } catch (e: java.io.IOException) { null }
        }

        /** Next JSON text message whose "t" is [type], skipping others. */
        fun expect(type: String, timeoutMs: Int = 3000): JsonObject {
            val until = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < until) {
                val m = frame(500) ?: continue
                if (m.opcode != CampsiteWebSocket.OP_TEXT) continue
                val o = Json.parseToJsonElement(m.text).jsonObject
                if (o["t"]?.jsonPrimitive?.content == type) return o
            }
            throw AssertionError("no '$type' message within ${timeoutMs}ms")
        }

        /** Reads state messages until [until] accepts one (or fails after the timeout). */
        fun stateUntil(timeoutMs: Int = 4000, until: (JsonObject) -> Boolean): JsonObject {
            val end = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < end) {
                val m = frame(500) ?: continue
                if (m.opcode != CampsiteWebSocket.OP_TEXT) continue
                val o = Json.parseToJsonElement(m.text).jsonObject
                if (o["t"]?.jsonPrimitive?.content == "state" && until(o)) return o
            }
            throw AssertionError("no matching state message within ${timeoutMs}ms")
        }

        fun closeCode(timeoutMs: Int = 3000): Int? {
            val until = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < until) {
                val m = frame(500) ?: continue
                if (m.opcode == CampsiteWebSocket.OP_CLOSE) return ((m.payload[0].toInt() and 255) shl 8) or (m.payload[1].toInt() and 255)
            }
            return null
        }

        fun close() { runCatching { socket.close() } }
    }

    private fun connect(cookie: String?, origin: String? = null, extra: String = ""): WsClient {
        val s = Socket("127.0.0.1", port)
        s.soTimeout = 3000
        val req = "GET /api/music/ws HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
            (if (cookie != null) "Cookie: $cookie\r\n" else "") + (if (origin != null) "Origin: $origin\r\n" else "") + extra + "\r\n"
        s.getOutputStream().write(req.toByteArray()); s.getOutputStream().flush()
        // status line + headers, byte by byte so no frame bytes are swallowed
        val head = StringBuilder()
        val ins = s.getInputStream()
        while (!head.endsWith("\r\n\r\n")) { val b = ins.read(); if (b < 0) break; head.append(b.toChar()) }
        val c = WsClient(s, head.lineSequence().first())
        if (c.status.contains("101")) {
            assertTrue(head.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="))
            clients += c
        } else s.close()
        return c
    }

    private fun waitFor(what: String, ms: Long = 4000, check: () -> Boolean) {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) { if (check()) return; Thread.sleep(25) }
        throw AssertionError("timed out waiting for $what")
    }

    // ---- who may connect ----------------------------------------------------------------------

    @Test fun refusesTheUpgradeWithoutAJoinCookie() {
        assertTrue(connect(null).status.contains("403"))
        assertTrue(connect("beebo_play=notatoken; beebo_guest=x").status.contains("403"))
    }

    @Test fun refusesCrossSiteOriginsButAllowsTheSameOrigin() {
        val cookie = join("Alex")
        assertTrue(connect(cookie, origin = "http://evil.example").status.contains("403"))
        assertTrue(connect(cookie, origin = "https://127.0.0.1:$port").status.contains("403"))
        assertTrue(connect(cookie, extra = "Sec-Fetch-Site: cross-site\r\n").status.contains("403"))
        assertTrue(connect(cookie, origin = "http://127.0.0.1:$port").status.contains("101"))
    }

    @Test fun aPlainGetOnTheSocketAddressIsNotAnUpgrade() {
        val cookie = join("Alex")
        val c = http("/api/music/ws", cookie)
        try { assertEquals(426, c.responseCode) } finally { c.disconnect() }
    }

    // ---- protocol ------------------------------------------------------------------------------

    @Test fun guestGetsHelloAndTheCurrentStateThenPingPong() {
        val a = connect(join("Alex"))
        val hello = a.expect("hello")
        assertEquals(1, hello["v"]!!.jsonPrimitive.content.toInt())
        assertEquals(12, hello["guest"]!!.jsonPrimitive.content.length)
        val state = a.expect("state")
        assertEquals("idle", state["state"]!!.jsonPrimitive.content)
        assertEquals("everyone", state["role"]!!.jsonPrimitive.content)

        a.send("""{"t":"ping","id":7,"c":123.456}""")
        val pong = a.expect("pong")
        assertEquals(7, pong["id"]!!.jsonPrimitive.content.toInt())
        assertEquals(123.456, pong["c"]!!.jsonPrimitive.content.toDouble(), 1e-6)
        val r = pong["r"]!!.jsonPrimitive.content.toDouble(); val s = pong["s"]!!.jsonPrimitive.content.toDouble()
        assertTrue("received before sent", s >= r)
        assertTrue("host processing is tiny", s - r < 500)
    }

    @Test fun hostCommandsReachEveryGuestAndLateJoinersCatchUp() {
        val a = connect(join("Alex")); val b = connect(join("Sam"))
        a.expect("state"); b.expect("state")
        server.music.load(listOf(track("aaa"), track("bbb")))
        val sa = a.expect("state"); val sb = b.expect("state")
        assertEquals("preparing", sa["state"]!!.jsonPrimitive.content)
        assertEquals(2, sb["queue"]!!.jsonArray.size)
        // nobody has unlocked audio, so nobody is waited for: the tick starts playback on its own
        waitFor("playback to start") { server.music.engine.stateNow == CampsiteMusicEngine.State.PLAYING }
        val playing = a.expect("state")
        assertEquals("playing", playing["state"]!!.jsonPrimitive.content)
        val epoch = playing["epochStart"]!!.jsonPrimitive.content.toDouble()

        val late = connect(join("Casey"))
        late.expect("hello")
        val snap = late.expect("state")
        assertEquals("playing", snap["state"]!!.jsonPrimitive.content)
        assertEquals(epoch, snap["epochStart"]!!.jsonPrimitive.content.toDouble(), 1e-3)
        assertEquals(2, snap["queue"]!!.jsonArray.size)

        server.music.pause()
        a.stateUntil { it["state"]!!.jsonPrimitive.content == "paused" }
    }

    @Test fun rolesArePerGuest() {
        val a = connect(join("Alex")); val b = connect(join("Sam"))
        val ida = a.expect("hello")["guest"]!!.jsonPrimitive.content
        b.expect("hello"); a.expect("state"); b.expect("state")
        server.music.load(listOf(track("aaa")))
        server.music.setRole(ida, MusicRole.LEFT)
        a.stateUntil { it["role"]!!.jsonPrimitive.content == "left" }
        val other = b.stateUntil { it["queue"]!!.jsonArray.size == 1 }
        assertEquals("everyone", other["role"]!!.jsonPrimitive.content)
        assertEquals(setOf(MusicRole.EVERYONE, MusicRole.LEFT), server.music.guests().map { it.role }.toSet())
    }

    @Test fun playbackWaitsForEveryUnlockedGuestToReportTheTrackReady() {
        val a = connect(join("Alex"))
        a.expect("state")
        a.send("""{"t":"status","state":"loading","unlocked":true,"errMs":2.5}""")
        waitFor("status to land") { server.music.guests().firstOrNull()?.unlocked == true }
        server.music.load(listOf(track("aaa")))
        Thread.sleep(700)
        assertEquals("still waiting: the unlocked guest is not ready", CampsiteMusicEngine.State.PREPARING, server.music.engine.stateNow)
        a.send("""{"t":"status","state":"ready","unlocked":true,"ready":"aaa","errMs":2.5,"driftMs":1,"rttMs":4}""")
        waitFor("playback after ready") { server.music.engine.stateNow == CampsiteMusicEngine.State.PLAYING }
        val g = server.music.guests().single()
        assertTrue(g.ready); assertTrue(g.inSync); assertEquals("Alex", g.name)
    }

    @Test fun aGuestCannotChangeWhatPlaysOrClaimHostPowers() {
        val a = connect(join("Alex"))
        a.expect("state")
        server.music.load(listOf(track("aaa")))
        for (cmd in listOf("""{"t":"play"}""", """{"t":"load","queue":[{"id":"x"}]}""", """{"t":"role","role":"left"}""", """{"t":"seek","ms":5}""")) a.send(cmd)
        Thread.sleep(400)
        assertEquals(1, server.music.engine.summary().queueSize)
        assertEquals(listOf("aaa"), server.music.engine.wantedTrackIds())
        assertEquals(MusicRole.EVERYONE, server.music.engine.roleOf(server.music.guests().single().id))
        assertEquals("a few unknown messages are tolerated", 1, server.music.connectionCount())
    }

    // ---- abuse ---------------------------------------------------------------------------------

    @Test fun oversizedFramesGetCloseCode1009() {
        val a = connect(join("Alex")); a.expect("state")
        a.sendText("x".repeat(5000))
        assertEquals(CampsiteWebSocket.CLOSE_TOO_BIG, a.closeCode())
    }

    @Test fun unmaskedFramesGetCloseCode1002() {
        val a = connect(join("Alex")); a.expect("state")
        val out = java.io.ByteArrayOutputStream()
        CampsiteWebSocket.writeFrame(out, CampsiteWebSocket.OP_TEXT, "{}".toByteArray(), maskKey = null)
        a.sendRaw(out.toByteArray())
        assertEquals(CampsiteWebSocket.CLOSE_PROTOCOL_ERROR, a.closeCode())
    }

    @Test fun binaryFramesAreRefused() {
        val a = connect(join("Alex")); a.expect("state")
        val out = java.io.ByteArrayOutputStream()
        CampsiteWebSocket.writeFrame(out, CampsiteWebSocket.OP_BINARY, byteArrayOf(1, 2, 3), maskKey = byteArrayOf(1, 2, 3, 4))
        a.sendRaw(out.toByteArray())
        assertEquals(CampsiteWebSocket.CLOSE_UNSUPPORTED, a.closeCode())
    }

    @Test fun garbageIsToleratedAFewTimesThenTheGuestIsDropped() {
        val a = connect(join("Alex")); a.expect("state")
        runCatching { repeat(30) { a.sendText("not json at all") } }
        assertEquals(CampsiteWebSocket.CLOSE_POLICY, a.closeCode())
    }

    @Test fun aMessageFloodIsRateLimited() {
        val a = connect(join("Alex")); a.expect("state")
        runCatching { repeat(600) { a.sendText("""{"t":"hello"}""") } }
        assertEquals(CampsiteWebSocket.CLOSE_POLICY, a.closeCode())
    }

    @Test fun statusValuesAreValidatedAndClamped() {
        val a = connect(join("Alex")); a.expect("state")
        a.send("""{"t":"status","state":"hacked","unlocked":true}""")
        a.send("""{"t":"status","state":"playing","unlocked":true,"ready":"../../etc","errMs":-5,"driftMs":1e99,"rttMs":"x"}""")
        waitFor("status") { server.music.guests().firstOrNull()?.driftMs == 10_000.0 }
        val g = server.music.guests().single()
        assertFalse("bad ready id is dropped", g.ready)
        assertEquals(Double.POSITIVE_INFINITY, g.errorMs, 0.0)
        assertEquals(10_000.0, g.driftMs, 0.0)
        assertFalse(g.inSync)
    }

    @Test fun oneSocketPerGuestNewerReplacesOlder() {
        val cookie = join("Alex")
        val first = connect(cookie); first.expect("state")
        val second = connect(cookie); second.expect("state")
        assertEquals(CampsiteWebSocket.CLOSE_NORMAL, first.closeCode())
        waitFor("one connection") { server.music.connectionCount() == 1 }
    }

    @Test fun stoppingTheServerHangsUpOnGuests() {
        val a = connect(join("Alex")); a.expect("state")
        server.stop()
        val code = a.closeCode()
        assertTrue(code == null || code == CampsiteWebSocket.CLOSE_GOING_AWAY)
        assertEquals(0, server.music.connectionCount())
    }

    // ---- pages and files -----------------------------------------------------------------------

    @Test fun musicPageRedirectsUnjoinedGuestsAndInlinesTheScriptForJoinedOnes() {
        val anon = http("/music")
        try { assertEquals(302, anon.responseCode); assertEquals("/join?next=music", anon.getHeaderField("Location")) } finally { anon.disconnect() }
        val c = http("/music", join("A<b>lex"))
        try {
            assertEquals(200, c.responseCode)
            val html = c.inputStream.bufferedReader().readText()
            assertTrue(html.contains("/*SCRIPT-MARKER*/"))
            assertTrue(html.contains("Tap to enable audio"))
            assertFalse("guest name is escaped", html.contains("A<b>lex"))
        } finally { c.disconnect() }
    }

    @Test fun trackDownloadsAreForJoinedGuestsAndQueuedTracksOnly() {
        val bytes = ByteArray(1000) { (it % 251).toByte() }
        val file = File(dir, "aaa.mp3").also { it.writeBytes(bytes) }
        audio["aaa"] = file; audio["secret"] = File(dir, "secret.mp3").also { it.writeBytes(ByteArray(10)) }
        val cookie = join("Alex")

        assertEquals(403, http("/music/track?id=aaa").let { val c = it.responseCode; it.disconnect(); c })
        assertEquals("nothing queued yet", 404, http("/music/track?id=aaa", cookie).let { val c = it.responseCode; it.disconnect(); c })

        server.music.load(listOf(track("aaa"), track("later")))
        val whole = http("/music/track?id=aaa", cookie)
        try {
            assertEquals(200, whole.responseCode)
            assertEquals("audio/mpeg", whole.contentType)
            assertTrue(whole.inputStream.readBytes().contentEquals(bytes))
            assertNull("no wildcard CORS on guest media", whole.getHeaderField("Access-Control-Allow-Origin"))
        } finally { whole.disconnect() }
        val part = http("/music/track?id=aaa", cookie, range = "bytes=10-19")
        try {
            assertEquals(206, part.responseCode)
            assertEquals("bytes 10-19/1000", part.getHeaderField("Content-Range"))
            assertTrue(part.inputStream.readBytes().contentEquals(bytes.copyOfRange(10, 20)))
        } finally { part.disconnect() }
        assertEquals("queued but not downloaded yet", 503, http("/music/track?id=later", cookie).let { val c = it.responseCode; it.disconnect(); c })
        assertEquals("a file the host has but is not queued", 404, http("/music/track?id=secret", cookie).let { val c = it.responseCode; it.disconnect(); c })
        assertEquals(404, http("/music/track?id=..%2F..%2Fetc%2Fpasswd", cookie).let { val c = it.responseCode; it.disconnect(); c })
    }

    // ---- the script shipped to guests ------------------------------------------------------------

    @Test fun theGuestScriptAssetIsInStepWithTheHost() {
        val js = File("src/main/assets/campsite-music.js").readText()
        assertTrue(js.contains("var PROTOCOL = ${CampsiteMusicEngine.PROTOCOL_VERSION};"))
        assertFalse("an inlined script must never contain a closing script tag", js.contains("</script", ignoreCase = true))
        assertTrue(js.contains("/api/music/ws") && js.contains("/music/track?id="))
        for (state in CampsiteMusicEngine.State.entries) assertTrue(state.wire, js.contains("${state.wire}: 1"))
        for (role in MusicRole.entries) assertTrue(role.wire, js.contains("${role.wire}: 1"))
        assertTrue(js.contains("MAX_TRACK") || CampsiteMusicEngine.MAX_TRACK_MS > 0)
    }
}
