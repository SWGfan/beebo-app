package com.beeboentertainment.movie.campsite.solo

import com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog
import com.beeboentertainment.movie.campsite.games.GameCategory
import com.beeboentertainment.movie.campsite.solo.LetterMark.ABSENT
import com.beeboentertainment.movie.campsite.solo.LetterMark.CORRECT
import com.beeboentertainment.movie.campsite.solo.LetterMark.PRESENT
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class FiveLettersTest {

    private fun asset(name: String): File {
        // Unit tests run with the module directory as the working directory.
        val candidates = listOf(File("src/main/assets/fiveletters/$name"), File("app/src/main/assets/fiveletters/$name"))
        return candidates.first { it.exists() }
    }

    private fun raw(name: String) = asset(name).readText().lines().filter { it.isNotEmpty() }

    @Test fun `duplicate letters in the guess only light up as often as the answer has them`() {
        assertEquals(listOf(PRESENT, PRESENT, ABSENT, ABSENT, ABSENT), FiveLetters.score("llama", "hello"))
        // Only the E in place scores; the answer has one E, so the other two are grey.
        assertEquals(listOf(ABSENT, ABSENT, ABSENT, CORRECT, CORRECT), FiveLetters.score("geese", "those"))
        // Greens use their letters first: HELLO has two Ls and both are already green.
        assertEquals(listOf(ABSENT, PRESENT, CORRECT, CORRECT, ABSENT), FiveLetters.score("lolly", "hello"))
        assertEquals(listOf(ABSENT, PRESENT, CORRECT, PRESENT, ABSENT), FiveLetters.score("allot", "hello"))
        assertEquals(listOf(ABSENT, CORRECT, ABSENT, ABSENT, ABSENT), FiveLetters.score("eerie", "hello"))
        assertEquals(List(5) { CORRECT }, FiveLetters.score("hello", "hello"))
    }

    @Test fun `keyboard keeps the best state for each letter`() {
        val states = FiveLetters.keyStates(listOf("llama", "hello"), "hello")
        assertEquals(CORRECT, states['l'])
        assertEquals(ABSENT, states['a'])
        assertEquals(CORRECT, states['h'])
    }

    @Test fun `the daily word is the same for a date and changes between days`() {
        val answers = FiveLetters.parseList(asset("answers.txt").readText())
        val day = FiveLetters.puzzleNumber(2026, 9, 16)
        assertEquals(259, day)
        assertEquals(FiveLetters.dailyAnswer(answers, day), FiveLetters.dailyAnswer(answers.toList(), day))
        val month = (day until day + 30).map { FiveLetters.dailyAnswer(answers, it) }
        assertEquals("no repeats within a month", month.size, month.toSet().size)
        // A whole cycle uses every answer exactly once.
        val cycle = (1..answers.size).map { FiveLetters.dailyAnswer(answers, it) }.toSet()
        assertEquals(answers.toSet(), cycle)
    }

    @Test fun `epoch day matches known dates`() {
        assertEquals(0L, FiveLetters.epochDay(1970, 1, 1))
        assertEquals(20347L, FiveLetters.epochDay(2025, 9, 16))
        assertEquals(1, FiveLetters.puzzleNumber(2026, 1, 1))
        assertEquals(60, FiveLetters.puzzleNumber(2026, 3, 1))
    }

    @Test fun `word lists are clean five letter a to z with no duplicates and answers inside allowed`() {
        val answers = raw("answers.txt")
        val guesses = raw("guesses.txt")
        (answers + guesses).forEach { assertTrue("bad word '$it'", it.length == 5 && it.all { c -> c in 'a'..'z' }) }
        assertEquals("duplicate answers", answers.size, answers.toSet().size)
        assertEquals("duplicate guesses", guesses.size, guesses.toSet().size)
        assertTrue("answers and extra guesses overlap", answers.intersect(guesses.toSet()).isEmpty())
        val allowed = (answers + guesses).toSet()
        assertTrue(allowed.containsAll(answers))
        assertTrue("about 1,500 answers", answers.size in 1400..1700)
        assertTrue(allowed.size > answers.size * 2)
        listOf("bitch", "whore", "penis", "sperm", "semen").forEach { assertFalse(it, it in allowed) }
        listOf("drunk", "vomit", "death", "naked").forEach { assertFalse(it, it in answers) }
    }

    @Test fun `share text has squares only and never the letters`() {
        val rows = listOf(FiveLetters.score("llama", "hello"), FiveLetters.score("hello", "hello"))
        val text = FiveLetters.shareText("Beebo Five Letters #259", rows, won = true)
        assertTrue(text.startsWith("Beebo Five Letters #259 2/6"))
        assertFalse(text.contains("HELLO", ignoreCase = true))
        assertTrue(text.contains("🟩🟩🟩🟩🟩"))
    }

    @Test fun `stats count streaks and distribution for daily only`() {
        var s = FiveLettersStats()
        s = s.record(FiveLettersState(true, 10, "hello", listOf("llama", "hello")))
        s = s.record(FiveLettersState(true, 11, "hello", listOf("hello")))
        s = s.record(FiveLettersState(false, 0, "hello", listOf("hello")))
        assertEquals(2, s.played); assertEquals(2, s.streak); assertEquals(1, s.distribution[0]); assertEquals(1, s.distribution[1])
        assertEquals(1, s.practicePlayed)
        assertEquals(0, s.currentStreak(13))
        s = s.record(FiveLettersState(true, 13, "hello", listOf("hello")))
        assertEquals(1, s.streak); assertEquals(2, s.bestStreak)
    }

    @Test fun `five letters is a solo puzzle that needs no guests`() {
        val g = CampsiteGameCatalog.solo("five-letters")!!
        assertFalse(g.needsGuests)
        assertEquals(GameCategory.PUZZLE, g.category)
        assertFalse(g.title.contains("wordle", ignoreCase = true))
        assertTrue(CampsiteGameCatalog.ALL.none { it.id == g.id })
    }
}
