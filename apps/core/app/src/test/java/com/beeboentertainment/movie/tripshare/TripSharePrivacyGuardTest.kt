package com.beeboentertainment.movie.tripshare

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Source-level guards for the promises of sharing a trip, in the style of TripPrivacyGuardTest:
 * the phone only talks to the person's own computer, never to a Beebo server; it asks for no new
 * permission; the song is a file the sender picks, never the music library; nothing needs Google
 * Play services (the Amazon build has none); and the defaults are private.
 */
class TripSharePrivacyGuardTest {

    private val dir = File("src/main/java/com/beeboentertainment/movie/tripshare")
    private val sources by lazy { dir.listFiles { f -> f.extension == "kt" }!!.associate { it.name to it.readText() } }
    private val manifest by lazy { File("src/main/AndroidManifest.xml").readText() }

    private fun code(text: String): String =
        text.replace(Regex("""/\*[\s\S]*?\*/"""), " ").lines().joinToString("\n") { line ->
            val cut = line.indexOf("//")
            if (cut >= 0 && !line.substring(0, cut).contains('"')) line.substring(0, cut) else line
        }

    @Test
    fun `the package is present`() {
        assertTrue(sources.keys.containsAll(listOf("TripShareClient.kt", "TripShareWorker.kt", "TripShareScreen.kt", "TripShareManifest.kt")))
    }

    @Test
    fun `no web address is written anywhere in the sharing code`() {
        sources.forEach { (name, text) ->
            val c = code(text)
            assertFalse("$name has an http(s) address", Regex("""https?://""").containsMatchIn(c.replace("\"https://x", "")))
            assertFalse("$name mentions a Beebo host", c.contains("beeboentertainment.com") || c.contains("beebo.tv") || c.contains("workers.dev"))
        }
    }

    @Test
    fun `every request goes to the trip-shares routes of the saved server address`() {
        val client = code(sources.getValue("TripShareClient.kt"))
        val paths = Regex(""""(/api/[^"?$]*)""").findAll(client).map { it.groupValues[1] }.toSet()
        assertTrue(paths.isNotEmpty())
        paths.forEach { assertTrue("$it is not a trip-shares route", it.startsWith("/api/trip-shares")) }
        assertTrue(client.contains("UrlUtils.endpoint(session.baseUrl"))
        assertFalse(client.contains("OkHttpClient.Builder"))
    }

    @Test
    fun `nothing here reaches the hub, the rewards service or any other backend`() {
        sources.forEach { (name, text) ->
            val c = code(text)
            listOf("movie.hub", "HubClient", "hubToken", "rewards", "Rewards", "movie.billing", "movie.account", "Firebase", "Crashlytics", "Analytics").forEach {
                assertFalse("$name mentions $it", c.contains(it))
            }
        }
    }

    @Test
    fun `no Google Play services and no cast, so the Amazon build stays clean`() {
        sources.forEach { (name, text) ->
            val c = code(text)
            assertFalse("$name uses Google services", c.contains("com.google.android.gms") || c.contains("com.google.firebase"))
        }
    }

    @Test
    fun `no new permission and no runtime permission prompt`() {
        val perms = Regex("""<uses-permission[^>]*android:name="([^"]+)"""").findAll(manifest).map { it.groupValues[1] }.toSet()
        assertFalse(perms.contains("android.permission.ACCESS_MEDIA_LOCATION"))
        assertFalse(perms.contains("android.permission.MANAGE_EXTERNAL_STORAGE"))
        assertFalse(perms.contains("android.permission.RECORD_AUDIO"))
        assertFalse(perms.contains("android.permission.CAMERA"))
        assertFalse("no foreground service was added for sharing", manifest.contains("tripshare"))
        sources.forEach { (name, text) ->
            val c = code(text)
            assertFalse("$name asks for a permission", c.contains("requestPermissions") || c.contains("RequestPermission") || c.contains("READ_MEDIA") || c.contains("READ_EXTERNAL_STORAGE"))
            assertFalse("$name reads the media library", c.contains("MediaStore."))
        }
    }

    @Test
    fun `the song is a file the sender picks, never the music library`() {
        val screen = code(sources.getValue("TripShareScreen.kt"))
        assertTrue(screen.contains("ActivityResultContracts.OpenDocument"))
        sources.forEach { (name, text) ->
            val c = code(text)
            assertFalse("$name reads the music library", c.contains("MediaStore.Audio") || c.contains("MusicRepository") || c.contains("movie.music"))
        }
        // The rights confirmation is on the screen and must be ticked before a song link can be made.
        assertTrue(screen.contains("SONG_RIGHTS_TEXT"))
        assertTrue(SONG_RIGHTS_TEXT.contains("I have the right to share"))
        assertFalse(ShareOptions(includeSong = true).problem(hasSong = true) == null)
    }

    @Test
    fun `photos and clips come only from the system picker's grants and are copied to the app's cache`() {
        val prep = code(sources.getValue("TripShareMediaPrep.kt"))
        assertTrue(prep.contains("context.cacheDir"))
        assertTrue(prep.contains("Mp4LocationStripper.strip"))
        assertTrue(prep.contains("Bitmap.CompressFormat.JPEG"))
        // The redraw is the metadata strip: no ExifInterface is ever written to.
        assertFalse(prep.contains("saveAttributes") || prep.contains("setAttribute") || prep.contains("setLatLong"))
    }

    @Test
    fun `the Beebo-hosted stub stays disabled and no code path can reach it`() {
        assertFalse(ShareHosting.BEEBO_HOSTED.available)
        sources.filterKeys { it != "TripShareModels.kt" && it != "TripShareScreen.kt" }.forEach { (name, text) ->
            assertFalse("$name refers to Beebo hosting", code(text).contains("BEEBO_HOSTED"))
        }
        // The screen may only draw it (as an unselectable, disabled choice).
        val screen = code(sources.getValue("TripShareScreen.kt"))
        assertTrue(screen.contains("enabled = h.available"))
        assertTrue(screen.contains("onClick = null"))
    }

    @Test
    fun `the defaults are private`() {
        val o = ShareOptions()
        assertFalse(o.includeLocation)
        assertFalse(o.includeSong)
        assertFalse(o.rightsAck)
        assertEquals(ShareExpiry.MONTH, o.expiry)
        assertTrue("guests are hidden until ticked", o.shownNames.isEmpty())
        val screen = code(sources.getValue("TripShareScreen.kt"))
        assertTrue(screen.contains("includeLocation by rememberSaveable { mutableStateOf(false) }"))
        assertTrue(screen.contains("includeSong by rememberSaveable { mutableStateOf(false) }"))
        assertTrue(screen.contains("wifiOnly by rememberSaveable { mutableStateOf(true) }"))
    }

    @Test
    fun `links are kept only in the encrypted store and forgotten on sign-out`() {
        val store = code(sources.getValue("TripShareStore.kt"))
        assertTrue(store.contains("session.tripLinksJson"))
        val session = File("src/main/java/com/beeboentertainment/movie/data/SessionStore.kt").readText()
        assertTrue(session.contains("if (usingEncryptedStorage) secure.getString(K_TRIP_LINKS, null) else null"))
        assertTrue(session.contains(".remove(K_TRIP_LINKS)"))
        // The job (plain preferences) never carries a link or token.
        assertFalse(code(sources.getValue("TripShareStore.kt")).substringAfter("data class ShareJob").substringBefore("class TripShareJobStore").contains("token"))
    }

    @Test
    fun `the sharing screens carry no wording aimed at children`() {
        sources.forEach { (name, text) ->
            val strings = Regex(""""(?:[^"\\]|\\.)*"""").findAll(code(text)).joinToString("\n") { it.value }
            assertFalse(name, Regex("""(?i)\b(kids?|children|child|toddlers?)\b""").containsMatchIn(strings))
        }
    }

    @Test
    fun `sharing shows the plain limits of view-only, expiry and turning off`() {
        val screen = sources.getValue("TripShareScreen.kt")
        assertTrue(screen.contains("view-only"))
        assertTrue(screen.contains("turn it off yourself at any time"))
        assertTrue(screen.contains("stops on its own"))
    }
}
