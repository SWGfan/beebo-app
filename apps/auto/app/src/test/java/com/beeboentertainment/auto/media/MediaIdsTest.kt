package com.beeboentertainment.auto.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The mediaId namespace has to round-trip exactly, because Android Auto hands the
 * string straight back to us and the server ids embedded in it are opaque tokens.
 *
 * Every server id used here is a REAL base64url encoding (alphabet A-Za-z0-9-_,
 * no padding) of a real filename or a Windows relPath, which is what the server
 * actually emits — that matters because '-', '_' and long unpadded runs are
 * exactly the characters a naive parser gets wrong.
 */
class MediaIdsTest {

    private companion object {
        /** base64url("Stranger Things\S01E01.mkv") */
        const val EP_STRANGER = "U3RyYW5nZXIgVGhpbmdzXFMwMUUwMS5ta3Y"

        /** base64url("Severance\S02E10.mkv") */
        const val EP_SEVERANCE = "U2V2ZXJhbmNlXFMwMkUxMC5ta3Y"

        /** base64url("Breaking Bad\Season 01\Breaking Bad - S01E03 - ...And the Bag's in the River.mkv") */
        const val EP_LONG =
            "QnJlYWtpbmcgQmFkXFNlYXNvbiAwMVxCcmVha2luZyBCYWQgLSBTMDFFMDMgLSAuLi5BbmQgdGhlIEJhZydzIGluIHRoZSBSaXZlci5ta3Y"

        /** base64url("The Matrix (1999).mkv") */
        const val MOVIE_MATRIX = "VGhlIE1hdHJpeCAoMTk5OSkubWt2"

        /** base64url("The Shawshank Redemption (1994) [1080p].mp4") */
        const val MOVIE_SHAWSHANK = "VGhlIFNoYXdzaGFuayBSZWRlbXB0aW9uICgxOTk0KSBbMTA4MHBdLm1wNA"

        /** base64url("Stranger Things") — a show key */
        const val SHOW_STRANGER = "U3RyYW5nZXIgVGhpbmdz"

        /** base64url("Better Call Saul") — a show key ending in the base64url 'A' */
        const val SHOW_SAUL = "QmV0dGVyIENhbGwgU2F1bA"

        // Pure-ASCII names never produce base64url's two special characters, so the
        // '-' / '_' half of the alphabet only shows up for non-Latin titles — which a
        // real library certainly has. These are the ids that would break a parser
        // that treats '-' as a separator or '_' as padding.

        /** base64url("Ирония судьбы (1975).mkv") — contains '-' */
        const val MOVIE_CYRILLIC = "0JjRgNC-0L3QuNGPINGB0YPQtNGM0LHRiyAoMTk3NSkubWt2"

        /** base64url("Пыль\S01E01.mkv") — contains '_' */
        const val EP_CYRILLIC = "0J_Ri9C70YxcUzAxRTAxLm1rdg"

        /** base64url("Пыль") — a show key containing '_' */
        const val SHOW_CYRILLIC = "0J_Ri9C70Yw"

        val ALL_SERVER_IDS = listOf(
            EP_STRANGER, EP_SEVERANCE, EP_LONG, MOVIE_MATRIX,
            MOVIE_SHAWSHANK, SHOW_STRANGER, SHOW_SAUL,
            MOVIE_CYRILLIC, EP_CYRILLIC, SHOW_CYRILLIC,
        )
    }

    @Test
    fun fixturesReallyAreBase64UrlWithoutPadding() {
        // Guards the guard: if someone swaps in a toy id the rest of this file
        // stops testing what it claims to test.
        val alphabet = Regex("^[A-Za-z0-9_-]+$")
        for (id in ALL_SERVER_IDS) {
            assertTrue("not base64url: $id", alphabet.matches(id))
            assertTrue("unexpected padding: $id", !id.contains('='))
        }
        // At least one fixture must exercise each of '-' and '_'.
        assertTrue(ALL_SERVER_IDS.any { it.contains('-') })
        assertTrue(ALL_SERVER_IDS.any { it.contains('_') })
    }

    // ------------------------------------------------------------- playables

    @Test
    fun movieIdRoundTrips() {
        for (id in listOf(MOVIE_MATRIX, MOVIE_SHAWSHANK, MOVIE_CYRILLIC)) {
            val mediaId = MediaIds.movie(id)
            assertEquals("play/movie/$id", mediaId)
            assertEquals("movie" to id, MediaIds.parsePlayable(mediaId))
        }
    }

    @Test
    fun episodeIdRoundTrips_andReportsKindTv() {
        for (id in listOf(EP_STRANGER, EP_SEVERANCE, EP_LONG, EP_CYRILLIC)) {
            val mediaId = MediaIds.episode(id)
            assertEquals("play/ep/$id", mediaId)
            assertEquals("tv" to id, MediaIds.parsePlayable(mediaId))
        }
    }

    @Test
    fun parsePlayableRejectsNonPlayableNamespaces() {
        assertNull(MediaIds.parsePlayable(MediaIds.ROOT_AUTO))
        assertNull(MediaIds.parsePlayable(MediaIds.TAB_MOVIES))
        assertNull(MediaIds.parsePlayable(MediaIds.MOVIES_AZ))
        assertNull(MediaIds.parsePlayable(MediaIds.moviesLetter("A")))
        assertNull(MediaIds.parsePlayable(MediaIds.moviesGenre(18)))
        assertNull(MediaIds.parsePlayable(MediaIds.show(SHOW_STRANGER)))
        assertNull(MediaIds.parsePlayable(MediaIds.season(SHOW_STRANGER, 1)))
    }

    @Test
    fun parsePlayableRejectsMalformedPlayIds() {
        assertNull(MediaIds.parsePlayable("play/"))
        assertNull(MediaIds.parsePlayable("play/movie"))
        assertNull(MediaIds.parsePlayable("play/movie/"))
        assertNull(MediaIds.parsePlayable("play//$MOVIE_MATRIX"))
    }

    // ------------------------------------------------------------- A-Z letters

    @Test
    fun letterRoundTrips() {
        for (letter in listOf("A", "M", "Z", "#")) {
            val mediaId = MediaIds.moviesLetter(letter)
            assertEquals("movies/az/$letter", mediaId)
            assertEquals(letter, MediaIds.parseLetter(mediaId))
        }
    }

    @Test
    fun parseLetterRejectsOtherNamespaces() {
        assertNull(MediaIds.parseLetter(MediaIds.MOVIES_AZ))
        assertNull(MediaIds.parseLetter(MediaIds.MOVIES_GENRES))
        assertNull(MediaIds.parseLetter(MediaIds.moviesGenre(28)))
        assertNull(MediaIds.parseLetter(MediaIds.movie(MOVIE_MATRIX)))
        assertNull(MediaIds.parseLetter(MediaIds.show(SHOW_STRANGER)))
        assertNull(MediaIds.parseLetter(MediaIds.season(SHOW_STRANGER, 2)))
    }

    // ----------------------------------------------------- TV A-Z letters

    /**
     * The TV letter tier shares the "tv/" stem with shows and seasons, and its
     * shape mirrors the movie one, so it is exactly the sort of id a parser
     * gets wrong in both directions.
     */
    @Test
    fun tvLetterRoundTrips() {
        for (letter in listOf("A", "M", "Z", "#")) {
            val mediaId = MediaIds.tvLetter(letter)
            assertEquals("tv/az/$letter", mediaId)
            assertEquals(letter, MediaIds.parseTvLetter(mediaId))
        }
    }

    @Test
    fun tvAndMovieLetterNamespacesDoNotOverlap() {
        assertNull(MediaIds.parseLetter(MediaIds.tvLetter("A")))
        assertNull(MediaIds.parseTvLetter(MediaIds.moviesLetter("A")))
    }

    @Test
    fun parseTvLetterRejectsShowsSeasonsAndTabs() {
        assertNull(MediaIds.parseTvLetter(MediaIds.TAB_TV))
        assertNull(MediaIds.parseTvLetter(MediaIds.show(SHOW_STRANGER)))
        assertNull(MediaIds.parseTvLetter(MediaIds.season(SHOW_STRANGER, 1)))
        assertNull(MediaIds.parseTvLetter(MediaIds.episode(EP_STRANGER)))
    }

    @Test
    fun parseShowAndParseSeasonRejectTvLetters() {
        assertNull(MediaIds.parseShow(MediaIds.tvLetter("S")))
        assertNull(MediaIds.parseSeason(MediaIds.tvLetter("S")))
        assertNull(MediaIds.parsePlayable(MediaIds.tvLetter("S")))
    }

    // -------------------------------------------------------------- genres

    @Test
    fun genreRoundTrips() {
        for (id in listOf(0, 18, 28, 10770, -1)) {
            val mediaId = MediaIds.moviesGenre(id)
            assertEquals("movies/genre/$id", mediaId)
            assertEquals(id, MediaIds.parseGenre(mediaId))
        }
    }

    @Test
    fun parseGenreRejectsNonNumericAndOtherNamespaces() {
        assertNull(MediaIds.parseGenre("movies/genre/abc"))
        assertNull(MediaIds.parseGenre(MediaIds.MOVIES_GENRES))
        assertNull(MediaIds.parseGenre(MediaIds.moviesLetter("G")))
        assertNull(MediaIds.parseGenre(MediaIds.movie(MOVIE_MATRIX)))
    }

    // ---------------------------------------------------------------- shows

    @Test
    fun showRoundTrips() {
        for (key in listOf(SHOW_STRANGER, SHOW_SAUL, SHOW_CYRILLIC)) {
            val mediaId = MediaIds.show(key)
            assertEquals("tv/show/$key", mediaId)
            assertEquals(key, MediaIds.parseShow(mediaId))
        }
    }

    /**
     * The important cross-namespace case: "tv/show/" and "tv/season/" share the
     * "tv/" stem, and a season id embeds a show key. parseShow must not claim it —
     * Catalog.kt tests parseShow BEFORE parseSeason, so a false positive here
     * would silently route every season row to the show handler.
     */
    @Test
    fun parseShowReturnsNullForSeasonIds() {
        assertNull(MediaIds.parseShow(MediaIds.season(SHOW_STRANGER, 1)))
        assertNull(MediaIds.parseShow(MediaIds.season(SHOW_STRANGER, 0)))
        assertNull(MediaIds.parseShow(MediaIds.season(SHOW_SAUL, null)))
        assertNull(MediaIds.parseShow(MediaIds.season(SHOW_CYRILLIC, 3)))
        assertNull(MediaIds.parseShow("tv/season/$SHOW_STRANGER/-1"))
    }

    @Test
    fun parseShowRejectsOtherNamespaces() {
        assertNull(MediaIds.parseShow(MediaIds.TAB_TV))
        assertNull(MediaIds.parseShow(MediaIds.ROOT_APP))
        assertNull(MediaIds.parseShow(MediaIds.episode(EP_STRANGER)))
        assertNull(MediaIds.parseShow(MediaIds.moviesLetter("S")))
    }

    // -------------------------------------------------------------- seasons

    @Test
    fun seasonRoundTripsForRealSeasonNumbers() {
        for (key in listOf(SHOW_STRANGER, SHOW_SAUL, SHOW_CYRILLIC)) {
            for (season in listOf(0, 1, 2, 10)) {
                val mediaId = MediaIds.season(key, season)
                assertEquals("tv/season/$key/$season", mediaId)
                assertEquals(key to season, MediaIds.parseSeason(mediaId))
            }
        }
    }

    /** The "no season" bucket is encoded as -1 on the wire and comes back as null. */
    @Test
    fun nullSeasonBucketRoundTripsThroughMinusOne() {
        val mediaId = MediaIds.season(SHOW_STRANGER, null)
        assertEquals("tv/season/$SHOW_STRANGER/-1", mediaId)

        val parsed = MediaIds.parseSeason(mediaId)
        assertNotNull(parsed)
        assertEquals(SHOW_STRANGER, parsed!!.first)
        assertNull(parsed.second)
    }

    @Test
    fun seasonZeroIsNotConfusedWithTheNullBucket() {
        // Season 0 is a real bucket (specials) and must survive as 0, not null.
        assertEquals(SHOW_SAUL to 0, MediaIds.parseSeason(MediaIds.season(SHOW_SAUL, 0)))
    }

    @Test
    fun parseSeasonReturnsNullForShowIds() {
        assertNull(MediaIds.parseSeason(MediaIds.show(SHOW_STRANGER)))
        assertNull(MediaIds.parseSeason(MediaIds.show(SHOW_SAUL)))
    }

    @Test
    fun parseSeasonRejectsOtherNamespacesAndMalformedIds() {
        assertNull(MediaIds.parseSeason(MediaIds.TAB_TV))
        assertNull(MediaIds.parseSeason(MediaIds.episode(EP_STRANGER)))
        assertNull(MediaIds.parseSeason("tv/season/$SHOW_STRANGER"))
        assertNull(MediaIds.parseSeason("tv/season//1"))
    }

    // ----------------------------------------------- namespace disjointness

    /**
     * Sweeps every constructor's output past every parser: exactly one parser may
     * claim each id.
     */
    @Test
    fun everyIdIsClaimedByExactlyOneParser() {
        val ids = listOf(
            MediaIds.movie(MOVIE_MATRIX),
            MediaIds.movie(MOVIE_SHAWSHANK),
            MediaIds.movie(MOVIE_CYRILLIC),
            MediaIds.episode(EP_STRANGER),
            MediaIds.episode(EP_LONG),
            MediaIds.episode(EP_CYRILLIC),
            MediaIds.moviesLetter("A"),
            MediaIds.moviesLetter("#"),
            MediaIds.tvLetter("A"),
            MediaIds.tvLetter("#"),
            MediaIds.moviesGenre(18),
            MediaIds.show(SHOW_STRANGER),
            MediaIds.show(SHOW_SAUL),
            MediaIds.season(SHOW_STRANGER, 1),
            MediaIds.season(SHOW_SAUL, null),
            MediaIds.season(SHOW_CYRILLIC, 3),
            MediaIds.show(SHOW_CYRILLIC),
        )
        for (id in ids) {
            val claims = listOfNotNull(
                MediaIds.parsePlayable(id)?.let { "playable" },
                MediaIds.parseLetter(id)?.let { "letter" },
                MediaIds.parseTvLetter(id)?.let { "tvLetter" },
                MediaIds.parseGenre(id)?.let { "genre" },
                MediaIds.parseShow(id)?.let { "show" },
                MediaIds.parseSeason(id)?.let { "season" },
            )
            assertEquals("wrong number of parsers claimed '$id': $claims", 1, claims.size)
        }
    }

    /** No parser may claim a root or tab id. */
    @Test
    fun rootsAndTabsAreClaimedByNoParser() {
        val ids = listOf(
            MediaIds.ROOT_AUTO, MediaIds.ROOT_APP, MediaIds.ROOT_RECENT,
            MediaIds.TAB_CONTINUE, MediaIds.TAB_MOVIES, MediaIds.TAB_TV,
            MediaIds.TAB_SURPRISE, MediaIds.TAB_PLAYLISTS, MediaIds.MOVIES_RECENT, MediaIds.MOVIES_AZ,
            MediaIds.MOVIES_GENRES, MediaIds.NOTICE,
        )
        for (id in ids) {
            assertNull(id, MediaIds.parsePlayable(id))
            assertNull(id, MediaIds.parseLetter(id))
            assertNull(id, MediaIds.parseTvLetter(id))
            assertNull(id, MediaIds.parseGenre(id))
            assertNull(id, MediaIds.parseShow(id))
            assertNull(id, MediaIds.parseSeason(id))
        }
    }
}
