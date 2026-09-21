package com.beeboentertainment.auto.family

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The game logic: word lists, determinism, round structure, and the content rules. */
class VoiceGamesTest {

    private val seeds = listOf(1, 2, 7, 42, 999_999)

    private fun allRounds(kind: GameKind, seed: Int, band: AgeBand) =
        (0 until kind.rounds).map { VoiceGames.round(kind, seed, it, band)!! }

    // ---- shape -----------------------------------------------------------------------------------

    @Test
    fun `there are three games and every round of every game exists for every band and seed`() {
        assertEquals(3, GameKind.entries.size)
        for (kind in GameKind.entries) for (band in AgeBand.entries) for (seed in seeds) {
            val rounds = allRounds(kind, seed, band)
            assertEquals(kind.rounds, rounds.size)
            rounds.forEach { r ->
                assertTrue(r.script.spokenText.isNotBlank())
                assertTrue("title short enough for a car list: ${r.title}", r.title.length <= 40)
                assertTrue(r.subtitle.length <= 40)
            }
        }
    }

    @Test
    fun `a round outside the game does not exist`() {
        assertNull(VoiceGames.round(GameKind.TWENTY, 1, -1, AgeBand.MIDDLE))
        assertNull(VoiceGames.round(GameKind.TWENTY, 1, GameKind.TWENTY.rounds, AgeBand.MIDDLE))
        assertNull(VoiceGames.round(GameKind.ALPHABET, 1, 26, AgeBand.MIDDLE))
    }

    @Test
    fun `the same seed always gives the same round and a different seed a different order`() {
        for (kind in GameKind.entries) {
            val a = allRounds(kind, 5, AgeBand.MIDDLE).map { it.script.spokenText }
            val b = allRounds(kind, 5, AgeBand.MIDDLE).map { it.script.spokenText }
            assertEquals(a, b)
        }
        val one = allRounds(GameKind.TWENTY, 1, AgeBand.OLDER).map { it.script.spokenText }
        val two = allRounds(GameKind.TWENTY, 2, AgeBand.OLDER).map { it.script.spokenText }
        assertNotEquals(one, two)
    }

    @Test
    fun `only the first round explains the game, and every game opens by saying it is for passengers`() {
        for (kind in GameKind.entries) {
            val rounds = allRounds(kind, 3, AgeBand.MIDDLE)
            assertTrue(rounds[0].script.spokenText.contains(VoiceGames.PASSENGERS_LINE))
            rounds.drop(1).forEach { assertFalse(it.script.spokenText.contains(VoiceGames.PASSENGERS_LINE)) }
        }
    }

    // ---- 20 Questions ------------------------------------------------------------------------------

    @Test
    fun `20 Questions gives clues from tricky to easy then reveals the answer`() {
        val r = VoiceGames.round(GameKind.TWENTY, 4, 1, AgeBand.MIDDLE)!!
        val says = r.script.steps.filterIsInstance<Step.Say>().map { it.text }
        assertTrue(says.first().startsWith("Round 2 of 6."))
        val clues = says.filter { it.startsWith("Clue ") }
        assertEquals(5, clues.size)
        assertTrue(clues.first().startsWith("Clue 1."))
        assertTrue(clues.last().startsWith("Clue 5."))
        assertTrue(says.last().startsWith("Time is up. It was "))
        // A silent gap follows every clue so passengers can guess out loud.
        val steps = r.script.steps
        clues.forEach { clue ->
            val i = steps.indexOfFirst { it is Step.Say && it.text == clue }
            assertTrue("a pause after $clue", steps[i + 1] is Step.Pause)
        }
    }

    @Test
    fun `no round's title or subtitle gives the answer away`() {
        for (band in AgeBand.entries) for (seed in seeds) for (i in 0 until GameKind.TWENTY.rounds) {
            val r = VoiceGames.round(GameKind.TWENTY, seed, i, band)!!
            val item = VoiceGames.twentyOrder(seed, band)[i]
            val core = item.answer.removePrefix("a ").removePrefix("an ").removePrefix("the ")
            assertFalse(r.title.contains(core, ignoreCase = true))
            assertFalse(r.subtitle.contains(core, ignoreCase = true))
        }
    }

    @Test
    fun `a clue never says the answer`() {
        for (item in FamilyContent.CLUE_ITEMS) {
            val core = item.answer.removePrefix("a ").removePrefix("an ").removePrefix("the ").lowercase()
            item.clues.forEach { clue ->
                assertFalse("\"$clue\" gives away $core", clue.lowercase().contains(core))
            }
        }
    }

    @Test
    fun `every clue item has five clues, a unique answer and a sensible level`() {
        val items = FamilyContent.CLUE_ITEMS
        assertTrue(items.size >= 30)
        assertEquals(items.size, items.map { it.answer }.toSet().size)
        items.forEach {
            assertEquals(5, it.clues.size)
            assertTrue(it.level in 1..3)
            it.clues.forEach { c -> assertTrue(c.length in 8..90) }
        }
    }

    @Test
    fun `each band has enough words for a whole play without repeats`() {
        for (band in AgeBand.entries) {
            val order = VoiceGames.twentyOrder(1, band)
            assertTrue("${band.wire} has ${order.size}", order.size >= GameKind.TWENTY.rounds)
            assertTrue(order.all { it.level <= band.maxLevel })
            val answers = (0 until GameKind.TWENTY.rounds).map { order[it].answer }
            assertEquals(answers.size, answers.toSet().size)
        }
    }

    // ---- Name That Sound -----------------------------------------------------------------------------

    @Test
    fun `Name That Sound mixes sound riddles, category races and quiet listening`() {
        val rounds = allRounds(GameKind.SOUND, 9, AgeBand.MIDDLE)
        val texts = rounds.map { it.script.spokenText }
        assertEquals(5, texts.count { it.contains("Sound riddle.") })
        assertEquals(3, texts.count { it.contains("Category race.") })
        assertEquals(2, rounds.count { it.title.startsWith("Listening round") })
        // Every listening round tells the driver to keep looking at the road (the driver never closes their eyes).
        rounds.filter { it.title.startsWith("Listening round") }.forEach { r ->
            assertTrue(r.script.spokenText.contains("except the driver") || r.script.spokenText.contains("but the driver") || r.script.spokenText.contains("Passengers"))
        }
    }

    @Test
    fun `a category race has a countdown with a halfway call and a time call`() {
        val race = allRounds(GameKind.SOUND, 9, AgeBand.MIDDLE).first { it.script.spokenText.contains("Category race.") }
        val says = race.script.steps.filterIsInstance<Step.Say>().map { it.text }
        assertTrue(says.any { it.startsWith("Halfway there") })
        assertTrue(says.last().startsWith("Time."))
        assertTrue(race.script.pauseMs >= 15_000)
    }

    @Test
    fun `sound riddles are unique and the youngest band only gets the easy ones`() {
        val riddles = FamilyContent.SOUND_RIDDLES
        assertTrue(riddles.size >= 20)
        assertEquals(riddles.size, riddles.map { it.sound }.toSet().size)
        assertTrue(riddles.count { it.level == 1 } >= 5)
        val little = allRounds(GameKind.SOUND, 4, AgeBand.LITTLE).map { it.script.spokenText }.filter { it.contains("Sound riddle.") }
        val easy = riddles.filter { it.level == 1 }
        little.forEach { text -> assertTrue(easy.any { text.contains(it.sound) }) }
    }

    @Test
    fun `category prompts are unique`() {
        assertEquals(FamilyContent.CATEGORY_PROMPTS.size, FamilyContent.CATEGORY_PROMPTS.toSet().size)
        assertTrue(FamilyContent.CATEGORY_PROMPTS.size >= 20)
    }

    // ---- Alphabet Road -------------------------------------------------------------------------------

    @Test
    fun `Alphabet Road goes through every letter in order`() {
        val rounds = allRounds(GameKind.ALPHABET, 11, AgeBand.MIDDLE)
        assertEquals(26, rounds.size)
        ('A'..'Z').forEachIndexed { i, letter ->
            assertTrue(rounds[i].title.endsWith("letter $letter"))
            assertTrue(FamilyContent.LETTER_HINTS.getValue(letter).isNotEmpty())
        }
        assertTrue(rounds.last().script.spokenText.contains("That was the whole alphabet"))
    }

    @Test
    fun `every letter's examples really start with that letter`() {
        FamilyContent.LETTER_HINTS.forEach { (letter, hints) ->
            assertEquals(2, hints.size)
            hints.forEach { hint ->
                // "ice, or igloo" and "the letter X on a sign": at least the first word is about the letter.
                val first = hint.removePrefix("the letter ").trim().first().uppercaseChar()
                assertEquals("$hint for $letter", letter, first)
            }
        }
        assertEquals(26, FamilyContent.LETTER_HINTS.size)
    }

    // ---- pauses and age bands ------------------------------------------------------------------------

    @Test
    fun `younger children get longer to think and older ones less`() {
        val little = allRounds(GameKind.ALPHABET, 1, AgeBand.LITTLE)[3].script.pauseMs
        val middle = allRounds(GameKind.ALPHABET, 1, AgeBand.MIDDLE)[3].script.pauseMs
        val older = allRounds(GameKind.ALPHABET, 1, AgeBand.OLDER)[3].script.pauseMs
        assertTrue("$little > $middle", little > middle)
        assertTrue("$middle > $older", middle > older)
    }

    @Test
    fun `no round is silent for long enough to seem broken, or so long the car goes quiet`() {
        for (kind in GameKind.entries) for (band in AgeBand.entries) {
            allRounds(kind, 8, band).forEach { r ->
                r.script.steps.filterIsInstance<Step.Pause>().forEach { p ->
                    assertTrue("pause ${p.ms} ms in ${r.title}", p.ms in 1_000..90_000)
                }
                assertTrue("round ${r.title} is ${r.script.pauseMs} ms of silence", r.script.pauseMs <= 120_000)
            }
        }
    }

    // ---- content rules ---------------------------------------------------------------------------------

    private val brands = listOf(
        "disney", "pixar", "pokemon", "nintendo", "mario", "minecraft", "lego", "barbie", "marvel", "batman",
        "spiderman", "star wars", "harry potter", "netflix", "youtube", "google", "coca", "pepsi", "mcdonald",
        "nike", "toyota", "tesla", "spotify", "fortnite", "roblox", "peppa", "bluey", "frozen", "elsa",
    )

    private val scary = listOf(
        "scary", "monster", "ghost", "blood", "kill", "killed", "dead", "die", "died", "dying", "death",
        "nightmare", "haunted", "demon", "witch", "weapon", "gun", "afraid", "terrified", "terrifying",
        "attack", "hurt", "wound", "fear", "scream", "creepy", "spooky", "danger",
    )

    private fun words(text: String) = Regex("[a-z']+").findAll(text.lowercase()).map { it.value }.toSet()

    private fun everythingSaid(): List<String> = buildList {
        for (kind in GameKind.entries) for (band in AgeBand.entries) for (seed in seeds) {
            allRounds(kind, seed, band).forEach { add(it.script.spokenText) }
        }
        FamilyContent.CLUE_ITEMS.forEach { add(it.answer + " " + it.clues.joinToString(" ")) }
        FamilyContent.SOUND_RIDDLES.forEach { add(it.sound + " " + it.answer) }
        addAll(FamilyContent.CATEGORY_PROMPTS)
        addAll(FamilyContent.LISTENING_ROUNDS)
        FamilyContent.LETTER_HINTS.values.forEach { addAll(it) }
    }

    @Test
    fun `nothing the games say names a brand, a character or a franchise`() {
        val text = everythingSaid().joinToString(" ").lowercase()
        brands.forEach { assertFalse("brand word: $it", text.contains(it)) }
    }

    @Test
    fun `nothing the games say is frightening`() {
        val used = words(everythingSaid().joinToString(" "))
        scary.forEach { assertFalse("scary word: $it", it in used) }
    }

    @Test
    fun `the games use no digits or symbols a speech engine would read badly`() {
        everythingSaid().forEach { line ->
            // Round numbers are written as digits in "Round 2 of 6" and "Clue 3": those read fine.
            val stripped = line.replace(Regex("(Round|Clue|round|letter|of) \\d+"), "")
                .replace(Regex("\\d+ of \\d+"), "").replace("20 Questions", "")
            assertFalse("digits in: $line", stripped.any { it.isDigit() })
            assertFalse("symbol in: $line", stripped.any { it in "&@#%*<>[]{}_=+/\\|~^`" })
        }
    }

    // ---- scoreboard ------------------------------------------------------------------------------------

    @Test
    fun `the scoreboard counts up and down and never goes below zero`() {
        val b = Scoreboard()
        assertEquals(0, b.points)
        assertEquals(0, b.undo())
        assertEquals(1, b.add())
        assertEquals(2, b.add())
        assertEquals(1, b.undo())
        b.reset()
        assertEquals(0, b.points)
        repeat(2_000) { b.add() }
        assertEquals(Scoreboard.MAX, b.points)
    }

    @Test
    fun `the game list matches the kinds and each has a plain blurb`() {
        assertEquals(setOf("twenty", "sound", "alphabet"), GameKind.entries.map { it.wire }.toSet())
        GameKind.entries.forEach {
            assertNotNull(GameKind.fromWire(it.wire))
            assertTrue(it.blurb.length in 10..60)
        }
        assertNull(GameKind.fromWire("nope"))
    }
}
