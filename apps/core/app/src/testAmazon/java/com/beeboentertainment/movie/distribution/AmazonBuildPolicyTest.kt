package com.beeboentertainment.movie.distribution

import android.content.Context
import android.content.ContextWrapper
import androidx.media3.common.Player
import com.beeboentertainment.movie.BuildConfig
import com.beeboentertainment.movie.player.CastHelper
import com.beeboentertainment.movie.player.CastLoadResult
import com.beeboentertainment.movie.player.CastMedia
import com.beeboentertainment.movie.player.PlayServices
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Runs only with the amazon unit tests (Fire TV / Fire tablets / Amazon Appstore). The merged
 * manifest, resource and dependency scan lives in the checkAmazon<BuildType>Policy Gradle task,
 * which testAmazonDebugUnitTest depends on; this covers what a JVM test can see directly.
 */
class AmazonBuildPolicyTest {

    // The Cast facade never looks at the context in the amazon build, so a bare wrapper will do.
    private val context: Context = ContextWrapper(null)

    @Test fun `amazon flags are set`() {
        assertTrue(BuildConfig.IS_AMAZON_BUILD)
        assertTrue("store rules apply", BuildConfig.IS_PLAY_BUILD)
        assertFalse(BuildConfig.FEATURE_BEEBOBOOK)
        assertFalse("purchases stay on the website", BuildConfig.FEATURE_IN_APP_PURCHASES)
    }

    @Test fun `no Google Play services classes are compiled into amazon`() {
        val names = listOf(
            "com.google.android.gms.cast.framework.CastContext",
            "com.google.android.gms.common.GoogleApiAvailability",
            "androidx.media3.cast.CastPlayer",
            "com.android.billingclient.api.BillingClient",
            "com.beeboentertainment.movie.player.GmsCastSupport",
            "com.beeboentertainment.movie.player.CastOptionsProvider",
            "com.beeboentertainment.movie.billing.PlayBillingManager",
            "com.beeboentertainment.movie.stories.StoryDeepLink",
        )
        for (name in names) {
            try {
                Class.forName(name)
                org.junit.Assert.fail("$name is on the amazon classpath")
            } catch (_: ClassNotFoundException) { /* expected */ }
        }
    }

    @Test fun `cast reports unavailable and every call is a harmless no-op`() {
        assertFalse(CastHelper.isAvailable(context))
        assertFalse(CastHelper.isPlayServicesAvailable(context))
        assertFalse(PlayServices.isAvailable(context))
        assertFalse(CastHelper.isSessionConnected(context))
        assertNull(CastHelper.observeSession(context) { })
        assertNull(CastHelper.createReceiver(context, object : Player.Listener {}))
        assertEquals(
            CastLoadResult.NoSession,
            CastHelper.loadOnReceiver(context, CastMedia("https://x/y.jpg", "image/jpeg", "y", isVideo = false))
        )
        CastHelper.reset()
    }

    @Test fun `the amazon manifest overlay drops the Cast entry point and requires no hardware`() {
        val overlay = File("src/amazon/AndroidManifest.xml")
        assertTrue("run from the app module directory", overlay.isFile)
        val text = overlay.readText()
        assertTrue(text.contains("OPTIONS_PROVIDER_CLASS_NAME") && text.contains("""tools:node="remove""""))
        val features = Regex("""<uses-feature\b[^>]*>""").findAll(text).map { it.value }.toList()
        assertTrue(features.isNotEmpty())
        for (tag in features) assertTrue("must be optional: $tag", tag.contains("""android:required="false""""))
    }

    @Test fun `the shared and amazon source sets carry no BeeboBook, billing or Cast SDK code`() {
        val googleOnly = listOf("com.google.android.gms", "androidx.media3.cast", "com.android.billingclient")
        for (root in listOf(File("src/main"), File("src/amazon")).filter { it.isDirectory }) {
            root.walkTopDown().filter { it.isFile }.forEach { f ->
                val path = f.invariantSeparatorsPath
                assertFalse("BeeboBook file in an amazon source set: $path", path.contains("/beebobook/") || path.contains("/stories/"))
                if (f.extension == "kt") {
                    // Comments may name these (docs); imports and code may not.
                    val code = f.readLines().filterNot {
                        val t = it.trimStart()
                        t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")
                    }
                    for (bad in googleOnly) assertFalse("$path uses $bad", code.any { it.contains(bad) })
                }
            }
        }
    }
}
