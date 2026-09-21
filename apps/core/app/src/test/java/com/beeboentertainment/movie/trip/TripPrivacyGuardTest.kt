package com.beeboentertainment.movie.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Source-level guards for the Trip Journal's promises, in the style of ForegroundServiceTypesTest:
 * the export service is declared as the type it does, no new permissions crept in for it, nothing in
 * the trip code reaches the network or the phone's media library, and the export shares through the
 * app's one FileProvider.
 */
class TripPrivacyGuardTest {

    private val manifest by lazy { File("src/main/AndroidManifest.xml").readText() }
    private val tripDir = File("src/main/java/com/beeboentertainment/movie/trip")
    private val tripSources by lazy { tripDir.listFiles { f -> f.extension == "kt" }!!.associate { it.name to it.readText() } }

    /** Kotlin source with comments removed, so a warning in a comment is not mistaken for code. */
    private fun code(text: String): String =
        text.replace(Regex("""/\*[\s\S]*?\*/"""), " ").lines().joinToString("\n") { line ->
            val cut = line.indexOf("//")
            if (cut >= 0 && !line.substring(0, cut).contains('"')) line.substring(0, cut) else line
        }

    @Test
    fun `the export service is a data sync foreground service and starts as that type`() {
        val declared = Regex("""android:name="\.trip\.TripExportService"[^>]*?android:foregroundServiceType="([^"]+)"""")
            .find(manifest)?.groupValues?.get(1)
        assertEquals("dataSync", declared)
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_DATA_SYNC"))
        val src = tripSources.getValue("TripExportService.kt")
        assertTrue(src.contains("FOREGROUND_SERVICE_TYPE_DATA_SYNC"))
        assertFalse(src.contains("FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING"))
        assertTrue(Regex("""android:name="\.trip\.TripExportService"\s+android:exported="false"""").containsMatchIn(manifest))
    }

    @Test
    fun `the export has a cancel action on its progress notification`() {
        val src = tripSources.getValue("TripExportService.kt")
        assertTrue(src.contains("addAction(0, \"Cancel\""))
        assertTrue(src.contains("setProgress("))
    }

    @Test
    fun `the manifest gained no camera, microphone or location permission and no new media permission`() {
        val perms = Regex("""<uses-permission[^>]*android:name="([^"]+)"""").findAll(manifest).map { it.groupValues[1] }.toSet()
        assertFalse(perms.contains("android.permission.CAMERA"))
        assertFalse(perms.contains("android.permission.RECORD_AUDIO"))
        // Location was already declared for the scavenger hunt and Wi-Fi Direct; the trip code adds none.
        assertEquals(
            setOf("android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_MEDIA_VISUAL_USER_SELECTED"),
            perms.filter { it.contains("READ_MEDIA") }.toSet(),
        )
        assertFalse(perms.contains("android.permission.ACCESS_MEDIA_LOCATION"))
        assertFalse(perms.contains("android.permission.MANAGE_EXTERNAL_STORAGE"))
    }

    @Test
    fun `the trip code never asks for storage or media permissions and never queries the media library`() {
        tripSources.forEach { (name, text) ->
            val c = code(text)
            assertFalse("$name asks for a media permission", c.contains("READ_MEDIA") || c.contains("READ_EXTERNAL_STORAGE"))
            assertFalse("$name touches ACCESS_MEDIA_LOCATION", c.contains("ACCESS_MEDIA_LOCATION"))
            assertFalse("$name lists the media library", c.contains("MediaStore.Images") || c.contains("MediaStore.Video") || c.contains("MediaStore.Files"))
            assertFalse("$name requests permissions at runtime", c.contains("requestPermissions") || c.contains("RequestPermission"))
        }
    }

    @Test
    fun `photos and videos are chosen through the system photo picker`() {
        val recap = File("src/main/java/com/beeboentertainment/movie/recap/TripRecapScreen.kt").readText()
        assertTrue(recap.contains("ActivityResultContracts.PickMultipleVisualMedia"))
    }

    @Test
    fun `the trip code makes no network calls`() {
        tripSources.forEach { (name, text) ->
            val c = code(text)
            listOf("okhttp", "OkHttp", "HttpURLConnection", "java.net.URL", "URLConnection", "ApiClient.http", "Socket(", "WebView").forEach {
                assertFalse("$name mentions $it", c.contains(it))
            }
            // ApiClient.JSON is only a JSON configuration, not the network client.
            assertFalse("$name uses the API client", Regex("""ApiClient\(""").containsMatchIn(c))
        }
    }

    @Test
    fun `the export never uses the music library`() {
        tripSources.forEach { (name, text) ->
            val c = code(text)
            assertFalse("$name reads the music library", c.contains("MediaStore.Audio") || c.contains("music.") || c.contains("MusicRepository"))
        }
        // The only audio the export can carry is the synthesized ambience.
        val engine = tripSources.getValue("TripExportEngine.kt")
        assertTrue(engine.contains("AmbienceWav.write"))
        assertTrue(engine.contains(".setRemoveAudio(true)"))
    }

    @Test
    fun `the export shares through the app's existing FileProvider and adds no second provider`() {
        val paths = File("src/main/res/xml/file_paths.xml").readText()
        assertTrue(paths.contains("""<cache-path name="trip_export" path="trip-export/" />"""))
        assertTrue(paths.contains("""<cache-path name="recap" path="recap/" />"""))
        assertEquals(1, Regex("androidx.core.content.FileProvider").findAll(manifest).count())
        assertTrue(tripSources.getValue("TripExportScreen.kt").contains("\"\${context.packageName}.fileprovider\""))
        assertEquals("trip-export", TripExportEngine.WORK_DIR)
    }

    @Test
    fun `the export screen carries the plain-language note`() {
        assertEquals("Personal home video for sharing with family.", EXPORT_NOTE)
    }

    @Test
    fun `saved trips are excluded from cloud backup and device transfer with the prefs file they live in`() {
        val persistence = tripSources.getValue("TripStore.kt")
        assertTrue(persistence.contains("SessionStore.plain") || persistence.contains("plain SharedPreferences"))
        listOf("backup_rules.xml", "data_extraction_rules.xml").forEach {
            assertTrue(it, File("src/main/res/xml/$it").readText().contains("beebo_prefs.xml"))
        }
    }

    @Test
    fun `hunt coordinates are handed to the trip only through the opt-in gate`() {
        val logic = tripSources.getValue("TripLogic.kt")
        assertTrue(logic.contains("trip.saveLocation && find.lat != null && find.lng != null"))
        assertTrue(File("src/main/java/com/beeboentertainment/movie/trip/Trip.kt").readText().contains("val saveLocation: Boolean = false"))
    }

    @Test
    fun `the trip journal is styled for adults`() {
        // The app's audience declaration is 18+ and not child-directed, so none of the trip screens
        // may address or market to children.
        tripSources.forEach { (name, text) ->
            val strings = Regex(""""(?:[^"\\]|\\.)*"""").findAll(code(text)).joinToString("\n") { it.value }
            assertFalse(name, Regex("""(?i)\b(kids?|children|child|toddlers?)\b""").containsMatchIn(strings))
        }
    }
}
