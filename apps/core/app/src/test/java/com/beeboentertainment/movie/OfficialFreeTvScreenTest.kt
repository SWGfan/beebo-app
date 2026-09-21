package com.beeboentertainment.movie

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Keeps the official-channel guide as a link directory, never an in-app re-streamer. */
class OfficialFreeTvScreenTest {
    private val source = File(
        "src/main/java/com/beeboentertainment/movie/ui/screens/OfficialFreeTvScreen.kt"
    ).readText()

    @Test
    fun `guide lists only https official links and opens them outside Beebo`() {
        assertTrue(source.contains("https://globalnews.ca/"))
        assertTrue(source.contains("https://www.ctvnews.ca/"))
        assertTrue(source.contains("https://www.tvo.org/"))
        assertTrue(source.contains("LocalUriHandler.current"))
        assertTrue(source.contains("uriHandler.openUri"))
        assertFalse(source.contains("WebView"))
        assertFalse(source.contains("ExoPlayer"))
    }

    @Test
    fun `guide clearly explains that broadcaster terms and availability apply`() {
        assertTrue(source.contains("Beebo does not carry these channels"))
        assertTrue(source.contains("regional availability apply"))
        assertTrue(source.contains("CBC and other broadcasters are not embedded or re-streamed"))
    }

    @Test
    fun `more tools menu and navigation expose the guide`() {
        val menu = File(
            "src/main/java/com/beeboentertainment/movie/ui/screens/PlayMoreScreens.kt"
        ).readText()
        val activity = File(
            "src/main/java/com/beeboentertainment/movie/ui/MainActivity.kt"
        ).readText()
        assertTrue(menu.contains("MenuItem(\"official-free-tv\""))
        assertTrue(activity.contains("composable(\"official-free-tv\") { OfficialFreeTvScreen() }"))
    }
}
