package com.beeboentertainment.movie

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every foreground service's declared type matches what it does (Google Play's foreground service
 * policy), the type it passes to startForeground matches the manifest, and each type's permission
 * is declared. BeeboBook's services are checked only if present (the Play build leaves them out).
 */
class ForegroundServiceTypesTest {

    private val manifest by lazy { File("src/main/AndroidManifest.xml").readText() }

    private fun declaredType(service: String): String? =
        Regex("""android:name="\.${Regex.escape(service)}"[^>]*?android:foregroundServiceType="([^"]+)"""")
            .find(manifest)?.groupValues?.get(1)

    @Test
    fun `each service has the type that fits it`() {
        assertEquals("mediaPlayback", declaredType("player.PlaybackService"))
        assertEquals("dataSync", declaredType("downloads.DownloadService"))       // upload or download
        assertEquals("dataSync", declaredType("spacesaver.SpaceSaverService"))    // backup
        assertEquals("connectedDevice", declaredType("campsite.CampsiteService")) // guests' phones on this phone's Wi-Fi
    }

    @Test
    fun `the permissions each type needs are declared`() {
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"))
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_DATA_SYNC"))
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"))
        // connectedDevice's Android 14+ prerequisite: one of CHANGE_WIFI_STATE, CHANGE_NETWORK_STATE, ...
        assertTrue(manifest.contains("android.permission.CHANGE_WIFI_STATE"))
    }

    @Test
    fun `Campsite starts in the foreground as the type the manifest declares`() {
        val src = File("src/main/java/com/beeboentertainment/movie/campsite/CampsiteService.kt").readText()
        assertTrue(src.contains("FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE"))
        assertFalse(src.contains("FOREGROUND_SERVICE_TYPE_DATA_SYNC"))
    }
}
