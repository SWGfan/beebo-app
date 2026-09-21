package com.beeboentertainment.movie.movienight

import com.beeboentertainment.movie.server.FeatureProbe
import com.beeboentertainment.movie.server.ServerFeature
import com.beeboentertainment.movie.server.Availability
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Movie Night (docs/MOVIE-NIGHT.md): the room reply is checked before a web view opens anything. */
class MovieNightTest {
    private val lenient = Json { ignoreUnknownKeys = true }
    private val base = "http://192.168.1.20:47811"
    private val ticket = "aB3_dE6-gH9jK2mN5pQ8rS1tU4vW7xYz"

    private fun room(json: String) = lenient.decodeFromString<MovieNightRoom>(json)

    private val good get() = room("""{"ok":true,"code":"K7M2QX","ticket":"$ticket","tvPath":"/movie-night/tv","hash":"k=$ticket","poolCount":12}""")

    @Test fun aGoodReplyBecomesTheComputersOwnPageWithTheTicketInTheFragment() {
        assertEquals("$base/movie-night/tv#k=$ticket", MovieNight.tvUrl(base, good))
        assertEquals("https://nick.home.beebo.tv:47811/movie-night/tv#k=$ticket", MovieNight.tvUrl("https://nick.home.beebo.tv:47811/", good))
        assertEquals("https://nick.example.com/movie-night/tv#k=$ticket", MovieNight.tvUrl("https://nick.example.com:443/some/path", good))
        assertFalse("the ticket is never in the query string", MovieNight.tvUrl(base, good)!!.contains("?"))
    }

    @Test fun aWrongOrHostileReplyNeverYieldsAnAddress() {
        val bad = listOf(
            """{"ok":false}""",
            """{}""",
            """{"ok":true,"tvPath":"//evil.example/x","ticket":"$ticket","hash":"k=$ticket"}""",
            """{"ok":true,"tvPath":"https://evil.example/movie-night/tv","ticket":"$ticket","hash":"k=$ticket"}""",
            """{"ok":true,"tvPath":"/movie-night/tv/../../login","ticket":"$ticket","hash":"k=$ticket"}""",
            """{"ok":true,"tvPath":"/other","ticket":"$ticket","hash":"k=$ticket"}""",
            """{"ok":true,"tvPath":"/movie-night/tv","ticket":"short","hash":"k=short"}""",
            """{"ok":true,"tvPath":"/movie-night/tv","ticket":"${ticket}x","hash":"k=${ticket}x"}""",
            """{"ok":true,"tvPath":"/movie-night/tv","ticket":"${ticket.dropLast(1)}/","hash":"k=${ticket.dropLast(1)}/"}""",
            """{"ok":true,"tvPath":"/movie-night/tv","ticket":"${ticket.dropLast(1)}#","hash":"k=${ticket.dropLast(1)}#"}""",
            """{"ok":true,"tvPath":"/movie-night/tv","ticket":"$ticket","hash":"k=$ticket&x=1"}""",
            """{"ok":true,"tvPath":"/movie-night/tv","ticket":"$ticket","hash":"k=other"}""",
            """{"ok":true,"tvPath":"/movie-night/tv","hash":"k=$ticket"}""",
        )
        for (json in bad) assertNull(json, MovieNight.tvUrl(base, room(json)))
        for (b in listOf(null, "", "ftp://192.168.1.20", "javascript:alert(1)", "192.168.1.20:47811", "http://user:pw@192.168.1.20", "http://a b")) {
            assertNull("base=$b", MovieNight.tvUrl(b, good))
        }
    }

    @Test fun theWebViewMayOnlyVisitTheComputersOwnPages() {
        assertTrue(MovieNight.allowsNavigation(base, "$base/movie-night/tv#k=x"))
        assertTrue(MovieNight.allowsNavigation(base, "$base/tvwatch?id=abc"))
        assertTrue(MovieNight.allowsNavigation(base, "HTTP://192.168.1.20:47811/x"))
        assertTrue(MovieNight.allowsNavigation(base, "about:blank"))
        assertFalse("another host", MovieNight.allowsNavigation(base, "http://192.168.1.21:47811/movie-night/tv"))
        assertFalse("another port", MovieNight.allowsNavigation(base, "http://192.168.1.20:8080/x"))
        assertFalse("another scheme", MovieNight.allowsNavigation(base, "https://192.168.1.20:47811/x"))
        assertFalse(MovieNight.allowsNavigation(base, "https://evil.example/"))
        assertFalse(MovieNight.allowsNavigation(base, "javascript:alert(1)"))
        assertFalse(MovieNight.allowsNavigation(base, "file:///etc/passwd"))
        assertFalse(MovieNight.allowsNavigation(base, "intent://x#Intent;scheme=http;end"))
        assertFalse(MovieNight.allowsNavigation(base, "http://192.168.1.20:47811@evil.example/"))
        assertFalse(MovieNight.allowsNavigation(base, null))
        assertFalse(MovieNight.allowsNavigation(null, "$base/x"))
        // a default port matches the scheme's own default
        assertTrue(MovieNight.allowsNavigation("https://nick.example.com", "https://nick.example.com:443/x"))
        assertFalse(MovieNight.allowsNavigation("https://nick.example.com", "https://nick.example.com:47811/x"))
    }

    @Test fun theBrowserPageIsTheComputersTvAddress() {
        assertEquals("$base/tv", MovieNight.browserPage(base))
        assertEquals("https://nick.home.beebo.tv:47811/tv", MovieNight.browserPage("https://nick.home.beebo.tv:47811/"))
    }

    @Test fun failuresAreSaidInPlainWords() {
        assertTrue(MovieNight.explain(401, "", null).contains("signed in"))
        assertTrue(MovieNight.explain(403, "", null).contains("home Wi-Fi"))
        assertTrue(MovieNight.explain(404, "", null).contains("isn't available"))
        assertTrue(MovieNight.explain(429, "", null).contains("Too many"))
        assertEquals("Custom.", MovieNight.explain(500, "x", "Custom."))
        assertEquals("Could not start Movie Night.", MovieNight.explain(500, "", null))
    }

    @Test fun theStatusIsParsedLeniently() {
        val on = lenient.decodeFromString<MovieNightStatus>("""{"ok":true,"enabled":true,"available":true}""")
        assertTrue(on.available)
        val off = lenient.decodeFromString<MovieNightStatus>("""{"ok":true,"enabled":false,"available":false,"reason":"off","message":"Turned off."}""")
        assertFalse(off.available)
        assertEquals("Turned off.", off.message)
        assertFalse(lenient.decodeFromString<MovieNightStatus>("{}").available)
    }

    @Test fun theMoreMenuEntryFollowsWhatTheComputerSays() {
        val f = ServerFeature.MOVIE_NIGHT
        assertEquals("GET", f.probeMethod)
        assertEquals("/api/movie-night/status", f.probePath)
        assertEquals(Availability.AVAILABLE, FeatureProbe.decide(f, 200, """{"ok":true,"enabled":true,"available":true}"""))
        assertEquals(Availability.NOT_SET_UP, FeatureProbe.decide(f, 200, """{"ok":true,"enabled":false,"available":false,"reason":"disabled"}"""))
        assertEquals(Availability.OLDER_SERVER, FeatureProbe.decide(f, 404, """{"ok":false}"""))
        assertEquals(Availability.OLDER_SERVER, FeatureProbe.decide(f, 200, "<html>not beebo</html>"))
        assertEquals(Availability.NOT_ALLOWED, FeatureProbe.decide(f, 403, """{"ok":false,"error":"not_home"}"""))
    }
}
