package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.AlphaIndex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The A–Z jump bar. The sort key and the bucket key must never disagree. */
class AlphaIndexTest {

    @Test
    fun `the bar is hash then A to Z`() {
        assertEquals(27, AlphaIndex.LETTERS.size)
        assertEquals('#', AlphaIndex.LETTERS.first())
        assertEquals('A', AlphaIndex.LETTERS[1])
        assertEquals('Z', AlphaIndex.LETTERS.last())
    }

    @Test
    fun `ordinary titles file under their first letter`() {
        assertEquals('H', AlphaIndex.letterFor("Heat"))
        assertEquals('Z', AlphaIndex.letterFor("Zodiac"))
        assertEquals('A', AlphaIndex.letterFor("alien"))
    }

    @Test
    fun `leading articles are NOT stripped - The Matrix files under T, like the website`() {
        assertEquals('T', AlphaIndex.letterFor("The Matrix"))
        assertEquals('A', AlphaIndex.letterFor("A Few Good Men"))
        assertEquals('A', AlphaIndex.letterFor("An American Werewolf in London"))
        assertEquals('T', AlphaIndex.letterFor("Theatre of Blood"))
        assertEquals("THE MATRIX", AlphaIndex.sortKey("The Matrix"))
    }

    @Test
    fun `the article-stripping flag still exists but is off by default`() {
        // kept only so the behaviour is explicit and cannot silently drift from the website
        assertEquals('M', AlphaIndex.letterFor("The Matrix", ignoreArticles = true))
        assertEquals('T', AlphaIndex.letterFor("The Matrix", ignoreArticles = false))
        assertEquals('T', AlphaIndex.letterFor("The Matrix"))
    }

    @Test
    fun `titles starting with digits file under hash`() {
        assertEquals('#', AlphaIndex.letterFor("300"))
        assertEquals('#', AlphaIndex.letterFor("2001: A Space Odyssey"))
        assertEquals('#', AlphaIndex.letterFor("12 Angry Men"))
    }

    @Test
    fun `leading punctuation is skipped before deciding`() {
        assertEquals('A', AlphaIndex.letterFor("…And Justice for All"))
        assertEquals('#', AlphaIndex.letterFor("'71"))
        assertEquals('B', AlphaIndex.letterFor("(Batman) Begins"))
    }

    @Test
    fun `accents fold so Amelie files under A`() {
        assertEquals('A', AlphaIndex.letterFor("Amélie"))
        assertEquals('E', AlphaIndex.letterFor("Étoile"))
    }

    @Test
    fun `empty and blank titles file under hash rather than crashing`() {
        assertEquals('#', AlphaIndex.letterFor(""))
        assertEquals('#', AlphaIndex.letterFor("   "))
        assertEquals('#', AlphaIndex.letterFor(null))
    }

    @Test
    fun `sorting uses the same key the bar buckets on`() {
        val titles = listOf("The Matrix", "Alien", "300", "Zodiac", "A Few Good Men", "Amélie")
        val sorted = AlphaIndex.sorted(titles) { it }
        // literal first-character ordering: "A Few Good Men" sorts under A, "The Matrix" under T
        assertEquals(listOf("300", "A Few Good Men", "Alien", "Amélie", "The Matrix", "Zodiac"), sorted)
    }

    @Test
    fun `available letters is what the bar enables, everything else is dimmed`() {
        val titles = listOf("Heat", "The Matrix", "300")
        val available = AlphaIndex.availableLetters(titles) { it }
        assertEquals(setOf('H', 'T', '#'), available)
        assertTrue('H' in available)
        assertFalse('Q' in available)
    }

    @Test
    fun `sections come back in bar order with no empty ones`() {
        val titles = AlphaIndex.sorted(listOf("Zodiac", "Heat", "300", "The Matrix")) { it }
        val sections = AlphaIndex.sections(titles) { it }
        assertEquals(listOf('#', 'H', 'T', 'Z'), sections.map { it.first })
        assertEquals(listOf("300"), sections[0].second)
        assertEquals(listOf("The Matrix"), sections[2].second)
        assertTrue(sections.none { it.second.isEmpty() })
    }

    @Test
    fun `header indices account for the header row itself`() {
        val sections = listOf(
            '#' to listOf("300", "2001"),
            'H' to listOf("Heat"),
            'T' to listOf("The Matrix", "The Thing", "Tenet")
        )
        val idx = AlphaIndex.headerIndices(sections)
        assertEquals(0, idx['#'])          // header
        assertEquals(3, idx['H'])          // 1 header + 2 tiles
        assertEquals(5, idx['T'])          // + 1 header + 1 tile
    }

    @Test
    fun `jumping to a letter finds its first item, and reports -1 when there is none`() {
        val titles = AlphaIndex.sorted(listOf("Zodiac", "Heat", "Hunt for Red October")) { it }
        assertEquals(0, AlphaIndex.firstIndexOf(titles, 'H') { it })
        assertEquals(2, AlphaIndex.firstIndexOf(titles, 'Z') { it })
        assertEquals(-1, AlphaIndex.firstIndexOf(titles, 'Q') { it })
    }

    @Test
    fun `an empty library produces no sections and no available letters`() {
        val empty = emptyList<String>()
        assertTrue(AlphaIndex.sections(empty) { it }.isEmpty())
        assertTrue(AlphaIndex.availableLetters(empty) { it }.isEmpty())
        assertTrue(AlphaIndex.headerIndices(AlphaIndex.sections(empty) { it }).isEmpty())
    }
}
