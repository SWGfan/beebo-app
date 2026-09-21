package com.beeboentertainment.auto.family

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The promises Family Fun makes, checked against the source. These read the real files, so a later
 * change that quietly adds a microphone, a location, a network call or a notification to this
 * feature fails a test instead of shipping.
 *
 * Gradle runs unit tests from the module folder (apps/auto/app).
 */
class FamilyPrivacyTest {

    private val familyDir = File("src/main/java/com/beeboentertainment/auto/family")
    private val manifest = File("src/main/AndroidManifest.xml")

    private fun familySources(): List<File> =
        familyDir.listFiles { f -> f.extension == "kt" }!!.sortedBy { it.name }

    /** Source with comments removed, so a comment that says "no microphone" does not trip the check. */
    private fun code(file: File): String = file.readText()
        .replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
        .lines().joinToString("\n") { it.substringBefore("//") }

    @Test
    fun `the feature is really in the source tree`() {
        assertTrue(familyDir.isDirectory)
        assertTrue("${familySources().size} family files", familySources().size >= 12)
    }

    @Test
    fun `the app has no microphone and no location permission`() {
        val text = manifest.readText()
        listOf(
            "RECORD_AUDIO", "CAPTURE_AUDIO_OUTPUT", "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION",
            "ACCESS_BACKGROUND_LOCATION", "READ_CONTACTS", "CAMERA", "READ_PHONE_STATE", "BLUETOOTH_CONNECT",
        ).forEach { assertFalse("manifest asks for $it", text.contains(it)) }
    }

    @Test
    fun `the permissions are the ones the media app already had`() {
        val declared = Regex("<uses-permission android:name=\"([^\"]+)\"").findAll(manifest.readText())
            .map { it.groupValues[1].removePrefix("android.permission.") }.toSet()
        assertEquals(
            setOf("INTERNET", "ACCESS_NETWORK_STATE", "WAKE_LOCK", "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_MEDIA_PLAYBACK", "POST_NOTIFICATIONS"),
            declared,
        )
    }

    @Test
    fun `the family code has no speech recognition, recording, location or camera`() {
        val banned = listOf(
            "SpeechRecognizer", "RecognizerIntent", "AudioRecord", "MediaRecorder", "CarAudioRecord",
            "LocationManager", "FusedLocation", "getLastKnownLocation", "requestLocationUpdates",
            "android.hardware.camera", "ContactsContract", "TelephonyManager",
        )
        familySources().forEach { f ->
            val c = code(f)
            banned.forEach { assertFalse("${f.name} uses $it", c.contains(it)) }
        }
    }

    @Test
    fun `the family code makes no network call and talks to no server`() {
        val banned = listOf(
            "okhttp", "OkHttp", "HttpURLConnection", "URLConnection", "java.net.Socket", "WebSocket",
            "http://", "https://", "auto.data.", "auto.hub.", "auto.remote.", "auto.webrtc.", "auto.party.", "ApiClient", "HubClient",
        )
        familySources().forEach { f ->
            val c = code(f)
            // The Trip Clock disclaimer in tests and docs is text, not a URL; the sources have none.
            banned.forEach { assertFalse("${f.name} uses $it", c.contains(it)) }
        }
    }

    @Test
    fun `the family code posts no notification`() {
        familySources().forEach { f ->
            val c = code(f)
            listOf("NotificationManager", "NotificationCompat", "Notification.Builder", "notify(", "setFullScreenIntent").forEach {
                assertFalse("${f.name} uses $it", c.contains(it))
            }
        }
    }

    @Test
    fun `the family code stores no audio`() {
        // The one file that writes audio is the speech renderer, and it writes the phone's own synthetic
        // voice into the cache folder. Nothing else in the feature opens a file for writing.
        familySources().filter { it.name != "TtsRenderer.kt" }.forEach { f ->
            val c = code(f)
            listOf("FileOutputStream", "writeBytes", "openFileOutput", "getExternalFilesDir", "MediaStore").forEach {
                assertFalse("${f.name} uses $it", c.contains(it))
            }
        }
        val renderer = code(File(familyDir, "TtsRenderer.kt"))
        assertTrue(renderer.contains("cacheDir"))
        assertFalse(renderer.contains("getExternalFilesDir"))
        assertFalse(renderer.contains("externalCacheDir"))
    }

    @Test
    fun `family preferences hold switches and times only`() {
        val prefs = code(File(familyDir, "FamilyPrefs.kt"))
        listOf("putString(KEY_ENABLED", "userName", "email", "token", "password", "address", "phone", "deviceId", "advertising").forEach {
            assertFalse("FamilyPrefs mentions $it", prefs.contains(it))
        }
    }

    @Test
    fun `the manifest declares no new service, receiver or provider for the feature`() {
        val text = manifest.readText()
        assertEquals("services", 1, Regex("<service\\b").findAll(text).count())
        assertEquals("receivers", 1, Regex("<receiver\\b").findAll(text).count())
        assertEquals("providers", 1, Regex("<provider\\b").findAll(text).count())
        assertFalse(text.contains("CarAppService"))
        assertFalse(text.contains("androidx.car.app.CarAppService"))
    }

    @Test
    fun `family fun audio is kept out of watch history`() {
        val service = File("src/main/java/com/beeboentertainment/auto/media/PlaybackService.kt").readText()
        assertTrue(service.contains("FamilyIds.isFamily(id)"))
    }

    @Test
    fun `the feature is off until a parent turns it on`() {
        val prefs = code(File(familyDir, "FamilyPrefs.kt"))
        assertTrue(prefs.contains("getBoolean(KEY_ENABLED, false)"))
        assertTrue(prefs.contains("getBoolean(KEY_HANDS_FREE, false)"))
    }

    @Test
    fun `nothing in the family package is marked as safe for children`() {
        // House rule: the app is not child-directed and never claims to be kid-safe.
        familySources().forEach { f ->
            val c = f.readText().lowercase()
            listOf("kid-safe", "kid safe", "child-safe", "safe for kids", "safe for children", "coppa-compliant").forEach {
                assertFalse("${f.name} says $it", c.contains(it))
            }
        }
    }
}
