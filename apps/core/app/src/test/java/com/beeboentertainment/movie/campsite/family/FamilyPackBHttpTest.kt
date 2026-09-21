package com.beeboentertainment.movie.campsite.family

import com.beeboentertainment.movie.campsite.CampsiteServer
import com.beeboentertainment.movie.campsite.quiz.AgeBand
import com.beeboentertainment.movie.campsite.quiz.QuizService
import com.beeboentertainment.movie.campsite.quiz.QuizSettings
import com.beeboentertainment.movie.campsite.songbook.MemoryPackStore
import com.beeboentertainment.movie.campsite.songbook.SongbookLibrary
import com.beeboentertainment.movie.campsite.songbook.SongbookService
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.Socket
import kotlin.random.Random

/** Real HTTP against a real CampsiteServer: the two pages, the two JSON doors, and their guards. */
class FamilyPackBHttpTest {

    private lateinit var server: CampsiteServer
    private lateinit var songbook: SongbookService
    private lateinit var quiz: QuizService
    private val port: Int get() = server.boundPort

    @Before fun start() {
        songbook = SongbookService(SongbookLibrary({ Assets.text("songbook/demo-pack.json") }, MemoryPackStore()))
        quiz = QuizService(Assets.quizBank(), random = Random(5))
        val family = FamilyPackBServices(
            songbookProvider = { songbook }, quizProvider = { quiz },
            songbookPage = { Assets.text("campsite-songbook.html") }, quizPage = { Assets.text("campsite-quiz.html") },
        )
        server = CampsiteServer(0, { emptyList() }, { null }, familyB = family)
        server.start()
    }

    @After fun stop() { server.stop() }

    private class Raw(val status: Int, val headers: Map<String, String>, val setCookies: List<String>, val body: String)

    private fun raw(method: String, path: String, headers: Map<String, String> = emptyMap(), body: String? = null, declaredLength: Int? = null): Raw {
        Socket("127.0.0.1", port).use { socket ->
            socket.soTimeout = 5000
            val bytes = body?.toByteArray(Charsets.UTF_8)
            val request = StringBuilder("$method $path HTTP/1.1\r\nHost: 127.0.0.1:$port\r\n")
            headers.forEach { (k, v) -> request.append("$k: $v\r\n") }
            if (bytes != null || declaredLength != null) request.append("Content-Length: ${declaredLength ?: bytes!!.size}\r\n")
            request.append("Connection: close\r\n\r\n")
            socket.getOutputStream().apply { write(request.toString().toByteArray()); if (bytes != null) write(bytes); flush() }
            val all = socket.getInputStream().readBytes().toString(Charsets.UTF_8)
            val split = all.indexOf("\r\n\r\n")
            val head = all.substring(0, split).split("\r\n")
            val hs = HashMap<String, String>(); val cookies = ArrayList<String>()
            head.drop(1).forEach { line ->
                val i = line.indexOf(':'); if (i <= 0) return@forEach
                val k = line.substring(0, i).trim(); val v = line.substring(i + 1).trim()
                if (k.equals("Set-Cookie", true)) cookies += v.substringBefore(';') else hs[k.lowercase()] = v
            }
            return Raw(head[0].split(" ")[1].toInt(), hs, cookies, all.substring(split + 4))
        }
    }

    private fun join(name: String = "Ann", next: String = "songbook"): String =
        raw("GET", "/join?name=${java.net.URLEncoder.encode(name, "UTF-8")}&next=$next").setCookies.joinToString("; ")

    private fun api(path: String, cookie: String, marker: String, body: String, extra: Map<String, String> = emptyMap()) =
        raw("POST", path, mapOf("Cookie" to cookie, marker to "1", "Content-Type" to "application/json") + extra, body)

    private fun json(r: Raw): JsonObject = Json.parseToJsonElement(r.body).jsonObject

    // ---- pages ---------------------------------------------------------------------------

    @Test fun pagesNeedTheJoinCookieAndSendAStrictContentSecurityPolicy() {
        listOf("songbook", "quiz").forEach { name ->
            val redirect = raw("GET", "/$name")
            assertEquals(302, redirect.status)
            assertEquals("/join?next=$name", redirect.headers["location"])
            val cookie = join("Ann", name)
            val page = raw("GET", "/$name", mapOf("Cookie" to cookie))
            assertEquals(200, page.status)
            val csp = page.headers["content-security-policy"]!!
            assertTrue(csp, csp.contains("default-src 'none'") && csp.contains("connect-src 'self'"))
            assertFalse(csp, csp.contains("http:") || csp.contains("https:") || csp.contains("*"))
            assertEquals("no-referrer", page.headers["referrer-policy"])
            assertTrue(page.headers["permissions-policy"]!!.contains("microphone=()"))
            assertTrue(page.headers["content-type"]!!.startsWith("text/html"))
        }
    }

    @Test fun pagesLoadNothingFromOutsideAndUseNoMicrophoneCameraOrLocation() {
        listOf("campsite-songbook.html", "campsite-quiz.html").forEach { name ->
            val page = Assets.text(name)
            assertFalse("$name external address", Regex("(?i)(https?:)?//[a-z0-9]").containsMatchIn(page.replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), "")))
            listOf("<link", "@import", "<img", "<iframe", "<object", "<embed", "<script src", "url(http", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon",
                "getUserMedia", "mediaDevices", "geolocation", "SpeechRecognition", "MediaRecorder", "localStorage", "sessionStorage", "document.cookie", "indexedDB").forEach {
                assertFalse("$name uses $it", page.contains(it))
            }
            assertTrue(page.contains("textContent"))
            assertFalse(page.contains("innerHTML")); assertFalse(page.contains("insertAdjacentHTML")); assertFalse(page.contains("eval("))
            assertTrue(page.contains("prefers-reduced-motion"))
            assertTrue(page.contains("lang=\"en\"") && page.contains("viewport"))
        }
    }

    @Test fun songbookPageIsBigPrintHighContrastAndHasACampfireTheme() {
        val page = Assets.text("campsite-songbook.html")
        assertTrue("lyrics at least 28px", page.contains("--lyric-min:28px"))
        assertTrue(page.contains("max(var(--lyric-min)"))
        assertTrue("dark campfire theme by default", page.contains("--bg:#050302"))
        assertTrue(page.contains("body.bright"))                      // a brighter choice exists
        assertTrue(page.contains("Everybody"))                        // chorus cue
        assertTrue(page.contains("Group ") && page.contains("\u25B2"))   // round groups carry a shape as well as a name
        assertTrue(page.contains("X-Beebo-Songbook"))
        assertTrue(page.contains("beeboSongbookWhere"))
        listOf("Next line", "start").forEach { assertFalse("guests get no host controls: $it", page.contains("id=\"$it\"")) }
    }

    // ---- doors ---------------------------------------------------------------------------

    @Test fun jsonDoorsRefuseAnyoneWhoHasNotJoinedAndAnythingCrossSite() {
        assertEquals(403, raw("GET", "/api/songbook").status)
        assertEquals(403, raw("GET", "/api/quiz").status)
        val cookie = join()
        assertEquals(200, raw("GET", "/api/songbook", mapOf("Cookie" to cookie)).status)
        // no custom header
        assertEquals(403, raw("POST", "/api/songbook", mapOf("Cookie" to cookie, "Content-Type" to "application/json"), "{\"action\":\"join\"}").status)
        // wrong marker for the door
        assertEquals(403, api("/api/songbook", cookie, "X-Beebo-Quiz", "{\"action\":\"join\"}").status)
        // another origin
        assertEquals(403, api("/api/songbook", cookie, "X-Beebo-Songbook", "{\"action\":\"join\"}", mapOf("Origin" to "https://elsewhere.invalid")).status)
        assertEquals(403, api("/api/quiz", cookie, "X-Beebo-Quiz", "{\"action\":\"join\"}", mapOf("Origin" to "https://elsewhere.invalid")).status)
        assertEquals(403, api("/api/songbook", cookie, "X-Beebo-Songbook", "{\"action\":\"join\"}", mapOf("Sec-Fetch-Site" to "cross-site")).status)
        // a forged token
        assertEquals(403, api("/api/songbook", "beebo_play=forged", "X-Beebo-Songbook", "{\"action\":\"join\"}").status)
        // the real thing
        assertEquals(200, api("/api/songbook", cookie, "X-Beebo-Songbook", "{\"action\":\"join\"}").status)
    }

    @Test fun oversizedWrongTypedAndBrokenBodiesAreRefused() {
        val cookie = join()
        // A declared length over the 16 KB cap is refused before a single body byte is read.
        val jsonHeaders = { marker: String -> mapOf("Cookie" to cookie, marker to "1", "Content-Type" to "application/json") }
        assertEquals(400, raw("POST", "/api/songbook", jsonHeaders("X-Beebo-Songbook"), null, declaredLength = 20_000).status)
        assertEquals(400, raw("POST", "/api/quiz", jsonHeaders("X-Beebo-Quiz"), null, declaredLength = 20_000).status)
        assertEquals(400, api("/api/songbook", cookie, "X-Beebo-Songbook", "not json").status)
        assertEquals(400, api("/api/songbook", cookie, "X-Beebo-Songbook", "[1,2]").status)
        val wrongType = raw("POST", "/api/songbook", mapOf("Cookie" to cookie, "X-Beebo-Songbook" to "1", "Content-Type" to "text/plain"), "{}")
        assertEquals(400, wrongType.status)
        assertEquals(405, raw("DELETE", "/api/songbook", mapOf("Cookie" to cookie)).status)
    }

    @Test fun rateLimitReachesTheGuestOverHttpAndOnlyThatGuest() {
        val a = join("Ann"); val b = join("Ben")
        val statuses = (1..25).map { api("/api/songbook", a, "X-Beebo-Songbook", "{\"action\":\"join\"}").status }
        assertEquals(20, statuses.count { it == 200 }); assertEquals(5, statuses.count { it == 429 })
        assertEquals(200, api("/api/songbook", b, "X-Beebo-Songbook", "{\"action\":\"join\"}").status)
    }

    @Test fun guestNamesTypedIntoTheJoinBoxNeverReachAnotherPageAsMarkup() {
        val cookie = join("<img src=x onerror=alert(1)>")
        val body = json(raw("GET", "/api/songbook", mapOf("Cookie" to cookie)))
        assertFalse(body.toString().contains("<"))
        quiz.open(QuizSettings(band = AgeBand.KIDS, rounds = 3))
        val q = json(api("/api/quiz", cookie, "X-Beebo-Quiz", "{\"action\":\"join\"}"))
        assertFalse(q.toString().contains("<")); assertFalse(q.toString().contains(">"))
    }

    // ---- end to end ----------------------------------------------------------------------

    @Test fun aGuestFollowsTheHostThroughASongOverHttp() {
        val cookie = join()
        assertNull(json(raw("GET", "/api/songbook?have=-1&cat=0", mapOf("Cookie" to cookie)))["song"]?.takeIf { it.toString() != "null" })
        songbook.locked { it.select("demo-ember-round"); it.setRoundMode(true); it.start() }
        val state = json(raw("GET", "/api/songbook?have=-1&cat=0", mapOf("Cookie" to cookie)))
        val song = state["song"]!!.jsonObject
        assertEquals("Demo Chant: Ember Round", song["title"]!!.jsonPrimitive.content)
        assertEquals(4, song["lines"]!!.jsonArray.size)
        assertEquals("true", song["round"]!!.jsonPrimitive.content)
        assertEquals(2, state["songs"]!!.jsonArray.size)
        songbook.locked { it.next() }
        assertEquals("1", json(raw("GET", "/api/songbook?have=-1&cat=1", mapOf("Cookie" to cookie)))["step"]!!.jsonPrimitive.content)
        val hearted = json(api("/api/songbook", cookie, "X-Beebo-Songbook", "{\"action\":\"heart\",\"song\":\"demo-night-sounds\"}"))
        assertEquals("1", hearted["hearts"]!!.jsonObject["demo-night-sounds"]!!.jsonPrimitive.content)
    }

    @Test fun aGuestPlaysAQuizOverHttpWithoutEverSeeingTheAnswerEarly() {
        val cookie = join("Ann", "quiz")
        assertEquals("idle", json(raw("GET", "/api/quiz", mapOf("Cookie" to cookie)))["phase"]!!.jsonPrimitive.content)
        assertNull(quiz.open(QuizSettings(band = AgeBand.KIDS, rounds = 3)))
        val joined = json(api("/api/quiz", cookie, "X-Beebo-Quiz", "{\"action\":\"join\"}"))
        assertEquals("lobby", joined["phase"]!!.jsonPrimitive.content)
        assertNull(quiz.start())
        val asking = json(raw("GET", "/api/quiz", mapOf("Cookie" to cookie)))
        assertEquals("asking", asking["phase"]!!.jsonPrimitive.content)
        assertEquals("-1", asking["correct"]!!.jsonPrimitive.content)
        assertEquals("", asking["fact"]!!.jsonPrimitive.content)
        val answered = json(api("/api/quiz", cookie, "X-Beebo-Quiz", "{\"action\":\"answer\",\"q\":1,\"choice\":0}"))
        assertEquals("revealed", answered["phase"]!!.jsonPrimitive.content)     // the only guest answered, so it reveals
        assertTrue(answered["fact"]!!.jsonPrimitive.content.isNotBlank())
        assertTrue(answered["correct"]!!.jsonPrimitive.content.toInt() in 0..3)
    }
}
