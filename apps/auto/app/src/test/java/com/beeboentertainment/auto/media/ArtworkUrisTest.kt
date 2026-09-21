package com.beeboentertainment.auto.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ArtworkProvider is exported with no permission, so `isArtworkPath` is the
 * whole of its access control: whatever it lets through becomes a request the
 * provider makes to the user's server on behalf of an arbitrary caller, with
 * the bytes handed back down a ParcelFileDescriptor.
 *
 * A prefix test is not enough, which is the point of most of these cases. The
 * decoded path is later concatenated onto the base URL and parsed by OkHttp,
 * and OkHttp normalises dot-segments away — so "/media/poster/../../x" starts
 * with an allowed prefix but is really a request for "/x".
 *
 * Both functions are pure and touch no Android API.
 */
class ArtworkUrisTest {

    // ------------------------------------------------------ the real paths

    @Test
    fun theThreePosterEndpointsTheServerActuallyServesAreAllowed() {
        assertTrue(ArtworkUris.isArtworkPath("/media/poster/603.jpg"))
        assertTrue(ArtworkUris.isArtworkPath("/media/poster-tv/1396.jpg"))
        assertTrue(ArtworkUris.isArtworkPath("/media/actor/287.jpg"))
    }

    @Test
    fun idsMayUseTheBase64UrlAlphabet() {
        assertTrue(ArtworkUris.isArtworkPath("/media/poster/abc_XYZ-123.jpg"))
        assertTrue(ArtworkUris.isArtworkPath("/media/poster/" + "a".repeat(40) + ".jpg"))
    }

    @Test
    fun anAbsurdlyLongIdIsRejected() {
        assertFalse(ArtworkUris.isArtworkPath("/media/poster/" + "a".repeat(41) + ".jpg"))
        assertFalse(ArtworkUris.isArtworkPath("/media/poster/.jpg"))
    }

    // ------------------------------------------------------------ traversal

    @Test
    fun dotSegmentsAreRejectedEvenThoughTheyStartWithAnAllowedPrefix() {
        val payloads = listOf(
            "/media/poster/../../whatever",
            "/media/poster/../../../etc/passwd",
            "/media/poster/../secret.jpg",
            "/media/poster/..%2F..%2Fsecret.jpg",
            "/media/poster-tv/../../api/movies",
            "/media/actor/./../../file",
            "/media/poster/1.jpg/../../x.jpg",
            "/media/poster//../x.jpg",
        )
        for (p in payloads) {
            assertFalse("traversal accepted: $p", ArtworkUris.isArtworkPath(p))
        }
    }

    @Test
    fun onlyTheThreeEndpointsCount() {
        val payloads = listOf(
            "/api/movies",
            "/file?id=x&mt=y",
            "/media/posterx/1.jpg",
            "/media/poster2/1.jpg",
            "/media/1.jpg",
            "media/poster/1.jpg",
            "//evil.example.com/media/poster/1.jpg",
            "http://evil.example.com/media/poster/1.jpg",
            "/media/poster/1.png",
            "/media/poster/1.jpg?redirect=/api/me",
            "/media/poster/1.jpg#x",
            "",
        )
        for (p in payloads) {
            assertFalse("accepted: $p", ArtworkUris.isArtworkPath(p))
        }
    }

    /**
     * Regex anchors are not enough on their own for this — a trailing newline
     * is the classic way past a `$`. Kotlin's `matches` needs the whole string,
     * which is why it is used instead of `containsMatchIn`.
     */
    @Test
    fun aTrailingNewlineDoesNotSmuggleAnythingPastTheAnchor() {
        assertFalse(ArtworkUris.isArtworkPath("/media/poster/1.jpg\n"))
        assertFalse(ArtworkUris.isArtworkPath("/media/poster/1.jpg\n/evil"))
        assertFalse(ArtworkUris.isArtworkPath("\n/media/poster/1.jpg"))
    }

    // ------------------------------------------------------------ cache key

    @Test
    fun cacheKeyIsAFullSha256Hex() {
        val key = ArtworkUris.cacheKey("/media/poster/603.jpg")
        assertEquals(64, key.length)
        assertTrue(Regex("^[0-9a-f]{64}$").matches(key))
    }

    @Test
    fun cacheKeyIsStableAndDistinguishesEveryEndpoint() {
        assertEquals(
            ArtworkUris.cacheKey("/media/poster/603.jpg"),
            ArtworkUris.cacheKey("/media/poster/603.jpg"),
        )
        val keys = listOf(
            "/media/poster/603.jpg",
            "/media/poster-tv/603.jpg",
            "/media/actor/603.jpg",
            "/media/poster/604.jpg",
        ).map { ArtworkUris.cacheKey(it) }
        assertEquals(keys.size, keys.distinct().size)
    }
}
