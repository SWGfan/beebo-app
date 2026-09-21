package com.beeboentertainment.auto.family

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Roadside Stories: the text, the age bands, the parts, and the content rules. */
class StoriesTest {

    @Test
    fun `there are eight stories, with unique ids and titles, spread over the age bands`() {
        val all = Stories.ALL
        assertEquals(8, all.size)
        assertEquals(8, all.map { it.id }.toSet().size)
        assertEquals(8, all.map { it.title }.toSet().size)
        assertEquals(3, Stories.forBand(AgeBand.LITTLE).size)
        assertEquals(3, Stories.forBand(AgeBand.MIDDLE).size)
        assertEquals(2, Stories.forBand(AgeBand.OLDER).size)
        all.forEach { assertTrue(it.id.matches(Regex("[a-z0-9-]{1,40}"))) }
    }

    @Test
    fun `each story is about three hundred words`() {
        Stories.ALL.forEach { s ->
            assertTrue("${s.id} has ${s.wordCount} words", s.wordCount in 250..380)
        }
    }

    @Test
    fun `stories are found by id and the list starts with the chosen age band`() {
        assertNotNull(Stories.byId("milo-mail-truck"))
        assertNull(Stories.byId("nope"))
        for (band in AgeBand.entries) {
            val list = Stories.listFor(band)
            assertEquals(8, list.size)
            val firstBand = list.takeWhile { it.band == band }
            assertEquals(Stories.forBand(band).size, firstBand.size)
        }
    }

    @Test
    fun `parts cover every paragraph once, in order, and the first sound is only a few words away`() {
        Stories.ALL.forEach { s ->
            val parts = Stories.parts(s)
            assertEquals(s.paragraphs, parts.flatten())
            assertTrue("${s.id}: ${parts.size} parts", parts.size in 2..6)
            val firstWords = parts.first().joinToString(" ").split(" ").size
            assertTrue("${s.id}: first part is $firstWords words", firstWords <= 160)
            assertEquals(parts.size, Stories.partCount(s))
        }
    }

    @Test
    fun `the first part opens with the title and only the last part ends the story`() {
        val s = Stories.ALL.first()
        val n = Stories.partCount(s)
        val first = Stories.script(s, 0, calm = false)
        val last = Stories.script(s, n - 1, calm = false)
        val middle = Stories.script(s, 1, calm = false)
        assertEquals(s.title + ".", first.steps.filterIsInstance<Step.Say>().first().text)
        assertTrue(last.steps.filterIsInstance<Step.Say>().last().text == "The end.")
        assertFalse(middle.spokenText.contains("The end."))
        assertFalse(middle.spokenText.contains(s.title + "."))
        // Reading every part gives back every paragraph.
        val all = (0 until n).joinToString(" ") { Stories.script(s, it, false).spokenText }
        s.paragraphs.forEach { assertTrue(all.contains(it)) }
    }

    @Test
    fun `calm reading leaves longer silences and says the same words`() {
        val s = Stories.ALL[3]
        for (p in 0 until Stories.partCount(s)) {
            val normal = Stories.script(s, p, calm = false)
            val calm = Stories.script(s, p, calm = true)
            assertEquals(normal.spokenText, calm.spokenText)
            assertTrue(calm.pauseMs > normal.pauseMs)
        }
    }

    @Test
    fun `an out-of-range part is silent rather than a crash`() {
        val s = Stories.ALL.first()
        assertEquals("", Stories.script(s, 99, false).spokenText.replace("The end.", "").trim())
    }

    // ---- content rules ----------------------------------------------------------------------------

    private val scary = listOf(
        "scary", "monster", "ghost", "blood", "kill", "dead", "die", "died", "dying", "death", "nightmare",
        "haunted", "demon", "witch", "weapon", "gun", "afraid", "terrified", "attack", "hurt", "wound", "fear",
        "scream", "creepy", "spooky", "danger", "storm", "lost",
    )

    private val brands = listOf(
        "disney", "pixar", "pokemon", "nintendo", "mario", "minecraft", "lego", "barbie", "marvel", "batman",
        "netflix", "youtube", "google", "coca", "pepsi", "mcdonald", "nike", "toyota", "tesla", "bluey",
    )

    private fun words(text: String) = Regex("[a-z']+").findAll(text.lowercase()).map { it.value }.toSet()

    @Test
    fun `no story has a frightening word in it`() {
        Stories.ALL.forEach { s ->
            val used = words(s.title + " " + s.text)
            scary.forEach { assertFalse("${s.id} uses \"$it\"", it in used) }
        }
    }

    @Test
    fun `no story names a brand or a franchise`() {
        Stories.ALL.forEach { s ->
            val text = (s.title + " " + s.text).lowercase()
            brands.forEach { assertFalse("${s.id} mentions $it", text.contains(it)) }
        }
    }

    @Test
    fun `every story settles down at the end`() {
        // A calm ending: the last paragraph is short-ish and uses at least one quiet word.
        val quiet = listOf("quiet", "slept", "sleep", "goodnight", "peaceful", "content", "calm", "still", "hush", "whisper", "rhythm", "carry", "gentle", "stars", "kept watch", "sea whispering")
        Stories.ALL.forEach { s ->
            val last = s.paragraphs.last().lowercase()
            assertTrue("${s.id}: ending is ${last.split(" ").size} words", last.split(" ").size <= 80)
            assertTrue("${s.id}: no quiet word in the ending: $last", quiet.any { last.contains(it) })
        }
    }

    @Test
    fun `stories read well aloud, no digits and no symbols`() {
        Stories.ALL.forEach { s ->
            val text = s.title + " " + s.text
            assertFalse("${s.id} has a digit", text.any { it.isDigit() })
            assertFalse("${s.id} has a symbol", text.any { it in "&@#%*<>[]{}_=+/\\|~^`" })
            assertFalse(text.contains("  "))
        }
    }

    @Test
    fun `no story claims to help anyone sleep or to treat anything`() {
        val claims = listOf("sleep aid", "cure", "treat", "therapy", "insomnia", "medicine", "doctor")
        Stories.ALL.forEach { s ->
            val text = s.text.lowercase()
            claims.forEach { assertFalse("${s.id} says $it", text.contains(it)) }
        }
    }

    @Test
    fun `the reading time shown in the car list is a small whole number`() {
        Stories.ALL.forEach { assertTrue(it.minutes in 1..5) }
    }
}
