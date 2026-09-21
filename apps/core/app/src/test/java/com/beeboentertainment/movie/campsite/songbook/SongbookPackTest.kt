package com.beeboentertainment.movie.campsite.songbook

import com.beeboentertainment.movie.campsite.family.Assets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The song-pack format, its validator and the import path. Every fixture here is SYNTHETIC text
 * ("Test line one ...") on purpose: no real lyric appears in the tests or in the app.
 */
class SongbookPackTest {

    /** Builds a pack file for a test. [songs] are already-JSON song objects. */
    private fun pack(
        songs: List<String>,
        packId: String = "test-pack",
        legal: String = """"legalCheck": {"by": "A. Checker", "date": "2026-09-21"},""",
    ) = """{"schema": 1, "packId": "$packId", "title": "Test pack", $legal "songs": [${songs.joinToString(",")}]}"""

    private fun song(
        id: String = "test-song",
        title: String = "Test Song",
        origin: String = "Traditional, documented in a test fixture",
        pdBasis: String = "Synthetic test text, not a real song",
        sourceUrl: String = "https://example.org/source",
        year: String = "",
        kind: String = "singalong",
        round: String = "",
        lines: String = """"Test line one", "Test line two", "Test line three", "Test line four"""",
    ) = """{"id": "$id", "title": "$title", "origin": "$origin", "pdBasis": "$pdBasis", "sourceUrl": "$sourceUrl",
        $year "kind": "$kind", $round "lines": [$lines]}"""

    private fun parse(text: String, imported: Boolean = true) = SongbookPackParser.parse(text, imported)

    private fun problems(text: String, imported: Boolean = true) = parse(text, imported).problems

    // ---- the built-in demo pack ------------------------------------------------------------

    @Test fun demoPackIsValidAndSmallAndClearlyOriginal() {
        val result = parse(Assets.text("songbook/demo-pack.json"), imported = false)
        assertEquals(emptyList<String>(), result.problems)
        val pack = result.pack!!
        assertTrue(pack.demo)
        assertEquals(2, pack.songs.size)
        pack.songs.forEach { s ->
            assertEquals(4, s.lines.size)
            assertTrue(s.origin, s.origin.startsWith("Original"))
            assertTrue(s.pdBasis.contains("not a traditional song"))
            assertEquals("", s.sourceUrl)
        }
        assertEquals(setOf("round", "singalong"), pack.songs.map { it.kind }.toSet())
    }

    @Test fun demoRoundGetsItsEntryPointFromTheEntryMarker() {
        val round = parse(Assets.text("songbook/demo-pack.json"), false).pack!!.songs.first { it.kind == "round" }
        assertEquals(RoundSpec(groups = 3, offsetLines = 2, repeats = 3), round.round)
    }

    @Test fun onlyTheDemoPackShipsAndItIsTheOnlySongFileInTheAssets() {
        val dir = java.io.File("src/main/assets/songbook").takeIf { it.exists() } ?: java.io.File("app/src/main/assets/songbook")
        assertEquals(listOf("demo-pack.json"), dir.listFiles().orEmpty().map { it.name })
    }

    // ---- validator rules -------------------------------------------------------------------

    @Test fun aWellFormedPackPasses() {
        assertEquals(emptyList<String>(), problems(pack(listOf(song()))))
    }

    @Test fun everyProvenanceFieldIsRequired() {
        assertTrue(problems(pack(listOf(song(origin = "")))).any { it.contains("origin") })
        assertTrue(problems(pack(listOf(song(pdBasis = "n/a")))).any { it.contains("pdBasis") })
        assertTrue(problems(pack(listOf(song(sourceUrl = "")))).any { it.contains("sourceUrl") })
        assertTrue(problems(pack(listOf(song(sourceUrl = "not a url")))).any { it.contains("sourceUrl") })
        assertTrue(problems(pack(listOf(song(sourceUrl = "javascript:alert(1)")))).any { it.contains("sourceUrl") })
        // original work may leave the source blank
        assertEquals(emptyList<String>(), problems(pack(listOf(song(origin = "Original to Beebo, 2026", sourceUrl = "")))))
    }

    @Test fun aLegalCheckRecordIsRequiredForImportedPacksOnly() {
        val noLegal = pack(listOf(song()), legal = "")
        assertTrue(problems(noLegal, imported = true).any { it.contains("legalCheck") })
        assertEquals(emptyList<String>(), problems(noLegal, imported = false))
    }

    @Test fun songsNewerThanTheCutoffAreRefusedUnlessTheyAreOriginalWork() {
        assertTrue(problems(pack(listOf(song(year = """"year": 1975,""")))).any { it.contains("not public domain") })
        assertEquals(emptyList<String>(), problems(pack(listOf(song(year = """"year": 1852,""")))))
        assertEquals(emptyList<String>(), problems(pack(listOf(song(origin = "Original to Beebo", year = """"year": 2026,""")))))
    }

    @Test fun denyListTitlesAreRefusedInAnyPunctuationOrCase() {
        listOf("Happy Birthday To You", "this land is your land", "Kum-ba-yah", "PUFF the magic DRAGON!", "Baby  Shark").forEach { title ->
            assertTrue(title, SongbookDenyList.isDenied(title))
            assertTrue(title, problems(pack(listOf(song(title = title)))).any { it.contains("DENY") })
        }
        assertFalse(SongbookDenyList.isDenied("Test Song"))
    }

    @Test fun provenanceDocumentListsEveryDeniedTitleAndTheTemplateTable() {
        val doc = Assets.doc("songs-provenance.md")
        SongbookDenyList.TITLES.forEach { assertTrue("missing from songs-provenance.md: $it", doc.contains("| $it |")) }
        listOf("Checklist", "DENY list", "Table 1", "Table 2", "demo-ember-round", "not legal advice").forEach { assertTrue(it, doc.contains(it, ignoreCase = true)) }
    }

    @Test fun linesMustBePlainWordsOnly() {
        fun linesProblems(lines: String) = problems(pack(listOf(song(lines = lines))))
        assertTrue(linesProblems(""""[Am] Test line", "Two"""").any { it.contains("chord") })
        assertTrue(linesProblems(""""<b>Test</b>", "Two"""").any { it.contains("chord or markup") })
        assertTrue(linesProblems(""""Test line (repeat)", "Two"""").any { it.contains("repeat") })
        assertTrue(linesProblems(""""Test line x2", "Two"""").any { it.contains("repeat") })
        assertTrue(linesProblems(""""One", "${"x".repeat(SongbookRules.MAX_LINE + 1)}"""").any { it.contains("characters") })
        assertTrue(linesProblems(""""Only one line"""").any { it.contains("2..") })
        assertTrue(linesProblems(""""Bad\u202Eline", "Two"""").any { it.contains("invisible") || it.contains("control") })
        assertTrue(linesProblems(""""One", """"").any { it.contains("characters") })
        // accented letters are fine (a foreign-language song)
        assertEquals(emptyList<String>(), linesProblems(""""Café line one", "Line two""""))
    }

    @Test fun songLengthKindAndTempoAreBounded() {
        assertTrue(problems(pack(listOf(song(kind = "opera")))).any { it.contains("kind") })
        assertTrue(problems(pack(listOf(song().replace("\"kind\"", "\"lineSeconds\": 20, \"kind\"")))).any { it.contains("lineSeconds") })
        val many = (1..SongbookRules.MAX_LINES + 1).joinToString(",") { "\"Test line $it\"" }
        assertTrue(problems(pack(listOf(song(lines = many)))).any { it.contains("lines") })
    }

    @Test fun roundsNeedAValidRoundDefinition() {
        val entry = """"Test one", {"text": "Test two", "entry": true}, "Test three", "Test four""""
        val ok = pack(listOf(song(kind = "round", lines = entry)))
        assertEquals(emptyList<String>(), problems(ok))
        assertEquals(2, parse(ok).pack!!.songs.single().round!!.offsetLines)
        val block = pack(listOf(song(kind = "round", round = """"round": {"groups": 4, "repeats": 2, "offsetLines": 1},""")))
        assertEquals(RoundSpec(4, 1, 2), parse(block).pack!!.songs.single().round)
        assertTrue(problems(pack(listOf(song(kind = "round")))).any { it.contains("round") })
        assertTrue(problems(pack(listOf(song(kind = "round", round = """"round": {"groups": 9},""", lines = entry)))).any { it.contains("groups") })
        assertTrue(problems(pack(listOf(song(kind = "singalong", lines = entry)))).any { it.contains("kind=round") || it.contains("rounds") })
        assertTrue(problems(pack(listOf(song(kind = "round", round = """"round": {"offsetLines": 4},""")))).any { it.contains("offsetLines") })
    }

    @Test fun duplicateIdsAndTitlesInsideAPackAreCaught() {
        assertTrue(problems(pack(listOf(song(), song(title = "Other Title")))).any { it.contains("duplicate id") })
        assertTrue(problems(pack(listOf(song(), song(id = "second", title = "TEST song!")))).any { it.contains("duplicate title") })
    }

    @Test fun structuralGarbageIsRejectedWithoutThrowing() {
        listOf("", "not json", "[]", """{"schema": 2, "songs": []}""", """{"schema": 1}""", """{"schema": 1, "packId": "x", "title": "t", "songs": [5]}""",
            "\u0000\u0001", """{"schema": 1, "songs": {}}""").forEach { text ->
            val result = parse(text)
            assertFalse(text, result.ok)
            assertTrue(text, result.problems.isNotEmpty())
        }
        assertFalse(parse("x".repeat(SongbookRules.MAX_PACK_BYTES + 1)).ok)
        assertTrue(problems(pack(emptyList())).any { it.contains("no songs") })
        assertTrue(problems(pack(listOf(song()), packId = "Bad Pack Id!")).any { it.contains("packId") })
    }

    @Test fun markupInATitleOrPackNameIsNeverRenderedAsMarkupByTheApp() {
        // Titles may contain odd characters; the guest page only ever uses textContent, checked in the page test.
        val page = Assets.text("campsite-songbook.html")
        assertFalse(page.contains("innerHTML")); assertFalse(page.contains("document.write")); assertFalse(page.contains("eval("))
        assertFalse(Assets.text("campsite-quiz.html").contains("innerHTML"))
    }

    // ---- import path -----------------------------------------------------------------------

    private fun library(store: SongbookPackStore = MemoryPackStore()) =
        SongbookLibrary({ Assets.text("songbook/demo-pack.json") }, store)

    @Test fun libraryStartsWithOnlyTheDemoPack() {
        val lib = library()
        assertEquals(listOf("beebo-demo"), lib.catalog.packs.map { it.packId })
        assertEquals(2, lib.catalog.songs.size)
        assertTrue(lib.isBuiltIn("beebo-demo"))
        assertFalse(lib.remove("beebo-demo"))
    }

    @Test fun importingAValidPackAddsItPersistsItAndItCanBeRemoved() {
        val store = MemoryPackStore()
        val lib = library(store)
        val outcome = lib.import(pack(listOf(song(), song(id = "second-song", title = "Second Test Song"))))
        assertTrue(outcome.message, outcome.ok)
        assertEquals(4, lib.catalog.songs.size)
        assertNotNull(lib.catalog["test-song"])
        // a fresh library over the same store sees it again (survives an app restart)
        assertEquals(4, library(store).catalog.songs.size)
        assertTrue(lib.remove("test-pack"))
        assertEquals(2, lib.catalog.songs.size)
        assertEquals(2, library(store).catalog.songs.size)
    }

    @Test fun oneBadSongRejectsTheWholePackAndNothingIsStored() {
        val store = MemoryPackStore()
        val lib = library(store)
        val outcome = lib.import(pack(listOf(song(), song(id = "bad", title = "Puff the Magic Dragon"))))
        assertFalse(outcome.ok)
        assertTrue(outcome.problems.any { it.contains("DENY") })
        assertEquals(2, lib.catalog.songs.size)
        assertTrue(store.all().isEmpty())
    }

    @Test fun clashesWithExistingSongsAreRefusedButReplacingAPackWithTheSameIdIsAllowed() {
        val lib = library()
        assertTrue(lib.import(pack(listOf(song()), packId = "first")).ok)
        val clash = lib.import(pack(listOf(song()), packId = "second"))
        assertFalse(clash.ok)
        assertTrue(clash.problems.single().contains("already"))
        val builtInClash = lib.import(pack(listOf(song(id = "demo-ember-round", title = "Something Else")), packId = "third"))
        assertFalse(builtInClash.ok)
        assertTrue(lib.import(pack(listOf(song(), song(id = "extra", title = "Extra Song")), packId = "first")).ok)
        assertEquals(4, lib.catalog.songs.size)
        assertFalse(lib.import(pack(listOf(song(id = "z", title = "Z Song")), packId = "beebo-demo")).ok)
    }

    @Test fun aStoredFileThatIsNoLongerValidIsSkippedNotTrusted() {
        val store = MemoryPackStore()
        store.save("evil", pack(listOf(song(title = "Baby Shark")), packId = "evil"))
        store.save("renamed", pack(listOf(song(id = "ok-song", title = "Ok Song")), packId = "other-id"))
        val lib = library(store)
        assertEquals(listOf("beebo-demo"), lib.catalog.packs.map { it.packId })
        assertEquals(2, lib.loadProblems.size)
    }

    @Test fun readLimitedStopsAtTheCap() {
        assertEquals("abc", readLimited("abc".byteInputStream(), 3))
        assertNull(readLimited("abcd".byteInputStream(), 3))
    }

    @Test fun songbookPackageNeverTouchesTheNetworkMicrophoneCameraOrLocation() {
        val forbidden = listOf("java.net", "okhttp", "HttpURLConnection", "URL(", "Socket", "Retrofit", "ApiClient", "RECORD_AUDIO", "MediaRecorder", "AudioRecord", "SpeechRecognizer", "LocationManager", "android.location", "CameraX")
        Assets.sources("songbook").forEach { file ->
            val text = file.readText()
            forbidden.forEach { word -> if (text.contains(word)) throw AssertionError("${file.name} mentions '$word'") }
        }
    }
}
