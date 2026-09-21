package com.beeboentertainment.movie.campsite.hunt

import com.beeboentertainment.movie.campsite.CampsiteServer
import com.beeboentertainment.movie.campsite.family.Assets
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.Socket
import kotlin.random.Random

/**
 * Real HTTP against a real CampsiteServer: the page, the JSON door and its guards, plus static checks of the
 * page and of the sources (no network, location, camera or microphone code anywhere in the hunt).
 */
class HuntHttpTest {

    private lateinit var server: CampsiteServer
    private lateinit var hunt: HuntService
    private val port: Int get() = server.boundPort

    @Before fun start() {
        hunt = HuntService(random = Random(5))
        val pack = HuntServices(huntProvider = { hunt }, page = { Assets.text("campsite-hunt.html") })
        server = CampsiteServer(0, { emptyList() }, { null }, huntPack = pack)
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

    private fun join(name: String = "Ann", next: String = "hunt"): String =
        raw("GET", "/join?name=${java.net.URLEncoder.encode(name, "UTF-8")}&next=$next").setCookies.joinToString("; ")

    private fun api(cookie: String, body: String, marker: String = "X-Beebo-Hunt", extra: Map<String, String> = emptyMap()) =
        raw("POST", "/api/hunt", mapOf("Cookie" to cookie, marker to "1", "Content-Type" to "application/json") + extra, body)

    private fun json(r: Raw): JsonObject = Json.parseToJsonElement(r.body).jsonObject

    private fun open(settings: HuntSettings = HuntSettings(itemCount = 8)) = assertEquals(null, hunt.open(settings))

    // ---- the page --------------------------------------------------------------------------

    @Test fun thePageNeedsTheJoinCookieAndCarriesAStrictPolicyThatAllowsOnlyOnPhonePictures() {
        val redirect = raw("GET", "/hunt")
        assertEquals(302, redirect.status)
        assertEquals("/join?next=hunt", redirect.headers["location"])
        val cookie = join()
        val joined = raw("GET", "/join?name=Ann&next=hunt")
        assertEquals("/hunt", joined.headers["location"])
        val page = raw("GET", "/hunt", mapOf("Cookie" to cookie))
        assertEquals(200, page.status)
        val csp = page.headers["content-security-policy"]!!
        assertTrue(csp, csp.contains("default-src 'none'") && csp.contains("connect-src 'self'"))
        assertTrue("a photo may only be SHOWN from this phone's own memory", csp.contains("img-src blob: data:"))
        assertFalse(csp, csp.contains("http:") || csp.contains("https:") || csp.contains("*") || csp.contains("frame-src") || csp.contains("media-src"))
        assertEquals("no-referrer", page.headers["referrer-policy"])
        val policy = page.headers["permissions-policy"]!!
        assertTrue(policy, policy.contains("microphone=()") && policy.contains("geolocation=()"))
        assertTrue(page.headers["content-type"]!!.startsWith("text/html"))
        assertTrue("the quiet-hours banner is on this page like every other", page.body.contains("id=\"beebo-quiet\""))
    }

    @Test fun thePageLoadsNothingFromOutsideAndUsesNoUnsafeBrowserCalls() {
        val page = Assets.text("campsite-hunt.html")
        assertFalse("external address", Regex("(?i)(https?:)?//[a-z0-9]").containsMatchIn(page.replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), "")))
        listOf(
            "<link", "@import", "<img", "<iframe", "<object", "<embed", "<script src", "url(http",
            "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "getUserMedia", "mediaDevices", "geolocation",
            "SpeechRecognition", "MediaRecorder", "localStorage", "sessionStorage", "document.cookie", "indexedDB",
            "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setTimeout('", "setTimeout(\"",
        ).forEach { assertFalse("page uses $it", page.contains(it)) }
        assertTrue(page.contains("textContent"))
        assertTrue(page.contains("prefers-reduced-motion"))
        assertTrue(page.contains("lang=\"en\"") && page.contains("viewport"))
        assertTrue(page.contains("X-Beebo-Hunt"))
        assertFalse("the page must not break out of its own script", page.substringAfter("<script>").substringBefore("</script>").contains("</"))
    }

    @Test fun aPhotoIsOnlyEverShownFromThePhonesOwnMemoryAndNeverReadOrSent() {
        val page = Assets.text("campsite-hunt.html")
        assertTrue(page.contains("createObjectURL")); assertTrue(page.contains("revokeObjectURL"))
        assertTrue(page.contains("capture=\"environment\""))
        listOf("FormData", "FileReader", "readAsDataURL", "readAsArrayBuffer", "arrayBuffer(", ".stream()", "canvas", "toBlob", "toDataURL", "navigator.share", "clipboard", "drawImage")
            .forEach { assertFalse("page uses $it", page.contains(it)) }
        assertEquals("the only network call is the hunt's own JSON door", 1, Regex("fetch\\(").findAll(page).count())
        assertTrue(page.contains("fetch('/api/hunt'"))
        assertTrue("the only body sent is the small JSON action object", page.contains("opt.body = JSON.stringify(body)"))
        assertTrue(page.contains("Photos stay on your own phone. Nothing is sent to anyone."))
        assertTrue(page.contains("Photograph things, not people: no faces, no other campers, no signs with names or numbers."))
    }

    @Test fun thePageSaysTheSafetyWordsAndHasNoHostControlsOrSounds() {
        val page = Assets.text("campsite-hunt.html")
        HuntSafety.CORE.forEach { assertTrue("missing: $it", page.contains(it)) }
        assertTrue(page.contains(HuntSafety.ASK_FIRST))
        assertTrue(page.contains(HuntSafety.PHOTO_LOCAL)); assertTrue(page.contains(HuntSafety.PHOTO_THINGS))
        listOf("Start the hunt", "End the hunt", "Approve", "Yes, it counts", "Open the hunt for guests").forEach {
            assertFalse("guests get no host controls: $it", page.contains(it))
        }
        assertTrue("sound starts off", page.contains("soundOn = false"))
        assertTrue("sound is silenced by quiet hours", page.contains("__beeboQuiet") && page.contains("st.quiet"))
        assertFalse("no audio element", page.contains("<audio") || page.contains("new Audio("))
        assertTrue("colour is never the only team cue", page.contains("▲") && page.contains("Team "))
        assertTrue(page.contains("min-height:64px") || page.contains("min-height:56px"))
    }

    @Test fun theWebSidebarLinksToTheHunt() {
        val library = raw("GET", "/library")
        assertEquals(200, library.status)
        assertTrue(library.body.contains("/hunt"))
        assertTrue(library.body.contains("Scavenger hunt"))
    }

    // ---- the door --------------------------------------------------------------------------

    @Test fun theDoorRefusesAnyoneWhoHasNotJoinedAndAnythingCrossSite() {
        assertEquals(403, raw("GET", "/api/hunt").status)
        val cookie = join()
        assertEquals(200, raw("GET", "/api/hunt", mapOf("Cookie" to cookie)).status)
        val joinBody = "{\"action\":\"join\"}"
        open()
        // no custom header
        assertEquals(403, raw("POST", "/api/hunt", mapOf("Cookie" to cookie, "Content-Type" to "application/json"), joinBody).status)
        // another door's marker
        assertEquals(403, api(cookie, joinBody, "X-Beebo-Quiz").status)
        // another origin
        assertEquals(403, api(cookie, joinBody, extra = mapOf("Origin" to "https://elsewhere.invalid")).status)
        assertEquals(403, api(cookie, joinBody, extra = mapOf("Sec-Fetch-Site" to "cross-site")).status)
        // a forged token
        assertEquals(403, api("beebo_play=forged", joinBody).status)
        assertEquals(403, raw("POST", "/api/hunt", mapOf("X-Beebo-Hunt" to "1", "Content-Type" to "application/json"), joinBody).status)
        // the real thing
        assertEquals(200, api(cookie, joinBody).status)
    }

    @Test fun oversizedWrongTypedAndBrokenBodiesAreRefused() {
        val cookie = join()
        open()
        val jsonHeaders = mapOf("Cookie" to cookie, "X-Beebo-Hunt" to "1", "Content-Type" to "application/json")
        assertEquals(400, raw("POST", "/api/hunt", jsonHeaders, null, declaredLength = 20_000).status)
        assertEquals(400, api(cookie, "not json").status)
        assertEquals(400, api(cookie, "[1,2]").status)
        assertEquals(400, raw("POST", "/api/hunt", mapOf("Cookie" to cookie, "X-Beebo-Hunt" to "1", "Content-Type" to "text/plain"), "{}").status)
        assertEquals(405, raw("DELETE", "/api/hunt", mapOf("Cookie" to cookie)).status)
        assertEquals(405, raw("PUT", "/api/hunt", jsonHeaders, "{}").status)
    }

    @Test fun theRateLimitReachesTheGuestOverHttpAndOnlyThatGuest() {
        open()
        val a = join("Ann"); val b = join("Ben")
        val statuses = (1..25).map { api(a, "{\"action\":\"join\"}").status }
        assertEquals(20, statuses.count { it == 200 }); assertEquals(5, statuses.count { it == 429 })
        assertEquals(200, api(b, "{\"action\":\"join\"}").status)
    }

    @Test fun aHostileNameTypedIntoTheJoinBoxNeverReachesAnotherPageAsMarkup() {
        open()
        val cookie = join("<img src=x onerror=alert(1)>")
        val joined = json(api(cookie, "{\"action\":\"join\"}"))
        assertFalse(joined.toString().contains("<")); assertFalse(joined.toString().contains(">"))
        val view = raw("GET", "/api/hunt", mapOf("Cookie" to cookie)).body
        assertFalse(view.contains("<")); assertFalse(view.contains(">"))
    }

    // ---- end to end ------------------------------------------------------------------------

    @Test fun twoGuestsPlayATeamHuntOverHttpAndSeeALiveLeaderboard() {
        open(HuntSettings(itemCount = 8, teams = 2, approval = false))
        val ann = join("Ann"); val ben = join("Ben")
        assertEquals("lobby", json(api(ann, "{\"action\":\"join\"}"))["phase"]!!.jsonPrimitive.content)
        json(api(ben, "{\"action\":\"join\"}"))
        assertEquals(200, api(ben, "{\"action\":\"team\",\"team\":0}").status)
        assertEquals(null, hunt.start())
        val view = json(raw("GET", "/api/hunt", mapOf("Cookie" to ann)))
        assertEquals("running", view["phase"]!!.jsonPrimitive.content)
        val first = view["items"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
        val ticked = json(api(ben, "{\"action\":\"tick\",\"item\":\"$first\"}"))
        assertEquals("1", ticked["me"]!!.jsonObject["found"]!!.jsonPrimitive.content)
        // Ann is on Ben's team (Ben moved to team 0 before the start), so she sees it as found too.
        val annNow = json(raw("GET", "/api/hunt", mapOf("Cookie" to ann)))
        val state = annNow["items"]!!.jsonArray.first { it.jsonObject["id"]!!.jsonPrimitive.content == first }.jsonObject
        assertEquals("found", state["state"]!!.jsonPrimitive.content)
        assertEquals("Ben", state["by"]!!.jsonPrimitive.content)
        val board = annNow["board"]!!.jsonArray
        assertEquals(1, board.size)
        assertEquals("1", board[0].jsonObject["found"]!!.jsonPrimitive.content)
        hunt.end()
        assertEquals("done", json(raw("GET", "/api/hunt", mapOf("Cookie" to ann)))["phase"]!!.jsonPrimitive.content)
    }

    // ---- static: the sources ---------------------------------------------------------------

    @Test fun theHuntPackageContainsNoNetworkLocationCameraMicrophoneOrTrackingCode() {
        val forbidden = listOf(
            "java.net.", "HttpURLConnection", "okhttp", "OkHttp", "Socket(", "android.location", "LocationManager", "FusedLocation",
            "ACCESS_FINE", "ACCESS_COARSE", "MediaRecorder", "AudioRecord", "SpeechRecognizer", "android.hardware.camera", "CameraManager",
            "androidx.camera", "ContactsContract", "firebase", "Firebase", "Analytics", "analytics", "Crashlytics", "AdMob", "play.core", "com.google.android.gms",
        )
        val sources = Assets.sources("hunt")
        assertTrue("found ${sources.size} hunt sources", sources.size >= 10)
        sources.forEach { f ->
            val text = f.readText()
            forbidden.forEach { assertFalse("${f.name} uses $it", text.contains(it)) }
        }
    }

    @Test fun noCopyClaimsToBeKidSafeOrCompliantOrGuaranteedAnywhereInTheHuntOrItsDocs() {
        val everything = Assets.sources("hunt").map { it.readText() } + Assets.text("campsite-hunt.html") + Assets.doc("CAMPSITE-SCAVENGER-HUNT.md")
        val claims = listOf("kid-safe", "kid safe", "safe for kids", "coppa compliant", "coppa-compliant", "guaranteed safe", "100% safe", "will keep your child safe")
        everything.forEach { text -> claims.forEach { assertFalse("claim: $it", text.lowercase().contains(it)) } }
    }

    @Test fun theDocsSayWhatNeedsRealPhonesAndWhatIsDeferred() {
        val doc = Assets.doc("CAMPSITE-SCAVENGER-HUNT.md")
        assertTrue(doc.contains("What needs real phones"))
        assertTrue(doc.contains("Deferred"))
        HuntCards.ALL.forEach { assertTrue("doc names ${it.title}", doc.contains(it.title)) }
    }
}
