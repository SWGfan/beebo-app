package com.beeboentertainment.movie.distribution

import com.beeboentertainment.movie.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * Runs only with the play unit tests. The merged manifest/resource/asset scan lives in the
 * checkPlay<BuildType>Policy Gradle task (which testPlayDebugUnitTest depends on); this
 * covers what a JVM test can see directly: the flags, the compiled classpath, and the
 * source sets that feed the play variant.
 */
class PlayBuildPolicyTest {

    @Test fun `play flags are set`() {
        assertTrue(BuildConfig.IS_PLAY_BUILD)
        assertFalse(BuildConfig.FEATURE_BEEBOBOOK)
    }

    @Test fun `no BeeboBook classes are compiled into play`() {
        val names = listOf(
            "com.beeboentertainment.movie.stories.StoryBookScreenKt",
            "com.beeboentertainment.movie.stories.StoryDeepLink",
            "com.beeboentertainment.movie.stories.StoryNarrationService",
            "com.beeboentertainment.movie.stories.StoryCowriterService",
        )
        for (name in names) {
            try {
                Class.forName(name)
                fail("$name is on the play classpath")
            } catch (_: ClassNotFoundException) { /* expected */ }
        }
    }

    @Test fun `play stub exposes no pending story`() {
        assertEquals(null, DistributionFeatures.pendingStorySlug.value)
        DistributionFeatures.requestStory("fairytale")
        assertEquals(null, DistributionFeatures.pendingStorySlug.value)
    }

    @Test fun `shared and play source sets carry no BeeboBook files or declarations`() {
        // Gradle runs unit tests with the module directory as the working directory.
        val main = File("src/main")
        val play = File("src/play")
        assertTrue("run from the app module directory", main.isDirectory)
        for (root in listOf(main, play).filter { it.isDirectory }) {
            root.walkTopDown().filter { it.isFile }.forEach { f ->
                val path = f.invariantSeparatorsPath
                assertFalse("BeeboBook file in a play source set: $path",
                    path.contains("/beebobook/") || path.contains("/stories/"))
            }
        }
        val manifest = File(main, "AndroidManifest.xml").readText()
        assertFalse("BeeboBook service in the shared manifest", manifest.contains(".stories."))
    }
}
