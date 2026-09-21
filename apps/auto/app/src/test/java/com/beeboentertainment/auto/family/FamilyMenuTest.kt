package com.beeboentertainment.auto.family

import com.beeboentertainment.auto.drive.VideoGate.Signals
import com.beeboentertainment.movie.campsite.quiet.QuietSettings
import com.beeboentertainment.movie.campsite.tripclock.KidUnit
import com.beeboentertainment.movie.campsite.tripclock.TripClockLogic
import com.beeboentertainment.movie.campsite.tripclock.TripClockState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.GregorianCalendar
import java.util.TimeZone

/** The folder the car shows, the ids behind it, and the rules applied when something is asked to play. */
class FamilyMenuTest {

    private val toronto = TimeZone.getTimeZone("America/Toronto")
    private val noon = GregorianCalendar(toronto).apply { clear(); set(2026, 6, 10, 12, 0, 0) }.timeInMillis
    private val late = GregorianCalendar(toronto).apply { clear(); set(2026, 6, 10, 23, 0, 0) }.timeInMillis
    private val nightly = QuietSettings(enabled = true)
    private val car = FamilyGate.Surface.CAR_MEDIA_BROWSER
    private val screen = FamilyGate.Surface.THIS_APP_SCREEN
    private val passenger = Signals(isAutomotive = false, passengerConfirmed = true)

    private fun env(
        now: Long = noon, handsFree: Boolean = false, quiet: QuietSettings = QuietSettings(),
        band: AgeBand = AgeBand.MIDDLE, clock: TripClockState = TripClockState(),
    ) = FamilyEnv(now, toronto, quiet, band, clock, handsFree)

    // ---- ids -----------------------------------------------------------------------------------------

    @Test
    fun `ids round trip`() {
        assertEquals(FamilyIds.Parsed.Root, FamilyIds.parse(FamilyIds.ROOT))
        assertEquals(FamilyIds.Parsed.Clock, FamilyIds.parse(FamilyIds.CLOCK))
        assertEquals(FamilyIds.Parsed.Stories, FamilyIds.parse(FamilyIds.STORIES))
        assertEquals(FamilyIds.Parsed.Games, FamilyIds.parse(FamilyIds.GAMES))
        assertEquals(FamilyIds.Parsed.Story("milo-mail-truck"), FamilyIds.parse(FamilyIds.story("milo-mail-truck")))
        assertEquals(FamilyIds.Parsed.StoryPart("milo-mail-truck", 2), FamilyIds.parse(FamilyIds.storyPart("milo-mail-truck", 2)))
        GameKind.entries.forEach {
            assertEquals(FamilyIds.Parsed.GameStart(it), FamilyIds.parse(FamilyIds.gameStart(it)))
            assertEquals(
                FamilyIds.Parsed.Round(it, 77, it.rounds - 1, AgeBand.OLDER),
                FamilyIds.parse(FamilyIds.round(it, 77, it.rounds - 1, AgeBand.OLDER)),
            )
        }
    }

    @Test
    fun `malformed ids are rejected, not guessed at`() {
        listOf(
            "", "family", "family/", "family/unknown", "family/story/", "family/story/Has Space", "family/story/UPPER",
            "family/story/a/b", "family/game/nope", "family/game/twenty/extra", "family/round/twenty/x/0/middle",
            "family/round/twenty/1/99/middle", "family/round/twenty/1/-1/middle", "family/round/twenty/1/0/tiny",
            "family/round/twenty/1/0", "family/part/x/-1", "family/part/x/999", "family/part//1", "play/movie/abc",
            "family/story/../../etc", "family/story/" + "a".repeat(41),
        ).forEach { assertNull("'$it'", FamilyIds.parse(it)) }
    }

    @Test
    fun `the audio address only means anything inside this app`() {
        val uri = FamilyIds.audioUri(FamilyIds.story("milo-mail-truck"))
        assertTrue(uri.startsWith("beebo-tts://"))
        assertEquals("family/story/milo-mail-truck", FamilyIds.mediaIdFromAudioUri(uri))
        assertNull(FamilyIds.mediaIdFromAudioUri("https://example.com/family/story/x"))
        assertNull(FamilyIds.mediaIdFromAudioUri("beebo-tts://voice/play/movie/abc"))
        assertNull(FamilyIds.mediaIdFromAudioUri("file:///sdcard/family/story/x"))
    }

    @Test
    fun `family ids are kept apart from the library and music ids`() {
        assertTrue(FamilyIds.isFamily(FamilyIds.ROOT))
        assertFalse(FamilyIds.isFamily("play/movie/abc"))
        assertFalse(FamilyIds.isFamily("tab/movies"))
        assertFalse(FamilyIds.isFamily("root/auto"))
    }

    // ---- the folder ------------------------------------------------------------------------------------

    @Test
    fun `the root has the clock glance, stories and games and nothing else`() {
        val rows = FamilyMenu.root(env())
        assertEquals(listOf(FamilyIds.CLOCK, FamilyIds.STORIES, FamilyIds.GAMES), rows.map { it.id })
        assertTrue(rows[0].playable)
        assertFalse(rows[1].playable)
        assertFalse(rows[2].playable)
    }

    @Test
    fun `every row is short enough to read at a glance`() {
        val e = env(clock = TripClockLogic.start(noon, noon + 300 * 60_000L, 0, KidUnit.NONE, 0).copy(kidUnit = "movies"), handsFree = true)
        val rows = FamilyMenu.root(e) + FamilyMenu.stories(e) + FamilyMenu.games(e) + FamilyMenu.rootEntry().let { listOf(it) }
        rows.forEach {
            assertTrue("title '${it.title}'", it.title.length <= 44)
            assertTrue("subtitle '${it.subtitle}'", it.subtitle.length <= 60)
        }
        // Lists stay small: no folder ever has more than eight rows.
        assertTrue(FamilyMenu.stories(e).size <= 8)
        assertTrue(FamilyMenu.games(e).size <= 8)
    }

    @Test
    fun `the clock row is the glance with the estimate line under it`() {
        val running = TripClockLogic.start(noon, noon + 300 * 60_000L, 0, KidUnit.NONE, 0).copy(kidUnit = "movies")
        val row = FamilyMenu.root(env(clock = running)).first()
        assertEquals("About 3 more movies", row.title)
        assertEquals("Estimate only. Use your navigation app for directions.", row.subtitle)
        val off = FamilyMenu.root(env()).first()
        assertEquals("Trip Clock is not running", off.title)
    }

    @Test
    fun `the stories folder lists all eight with the chosen age band first`() {
        val rows = FamilyMenu.stories(env(band = AgeBand.OLDER))
        assertEquals(8, rows.size)
        assertTrue(rows.all { it.playable })
        assertEquals(Stories.forBand(AgeBand.OLDER).map { FamilyIds.story(it.id) }, rows.take(2).map { it.id })
    }

    @Test
    fun `the games folder offers the three games only when a game may start`() {
        val closed = FamilyMenu.games(env(handsFree = false))
        assertEquals(1, closed.size)
        assertEquals(FamilyIds.NOTE, closed[0].id)
        assertEquals(FamilyGate.CAR_NOTE_NEEDS_PARENT, closed[0].title)
        val open = FamilyMenu.games(env(handsFree = true))
        assertEquals(GameKind.entries.map { FamilyIds.gameStart(it) }, open.map { it.id })
        assertTrue(open.all { it.playable })
        val quiet = FamilyMenu.games(env(now = late, handsFree = true, quiet = nightly))
        assertEquals(FamilyGate.CAR_NOTE_QUIET, quiet.single().title)
    }

    @Test
    fun `the root says games are resting instead of hiding them`() {
        val games = FamilyMenu.root(env(handsFree = false)).first { it.id == FamilyIds.GAMES }
        assertEquals("Resting for now", games.subtitle)
        val ok = FamilyMenu.root(env(handsFree = true)).first { it.id == FamilyIds.GAMES }
        assertTrue(ok.subtitle.startsWith("For passengers"))
    }

    @Test
    fun `children and entries answer only for family ids`() {
        val e = env(handsFree = true)
        assertNotNull(FamilyMenu.children(FamilyIds.ROOT, e))
        assertNotNull(FamilyMenu.children(FamilyIds.STORIES, e))
        assertEquals(emptyList<MenuEntry>(), FamilyMenu.children(FamilyIds.NOTE, e))
        assertNull(FamilyMenu.children("tab/movies", e))
        assertNull(FamilyMenu.children("family/nonsense", e))
        assertNotNull(FamilyMenu.entryFor(FamilyIds.story("milo-mail-truck"), e))
        assertNotNull(FamilyMenu.entryFor(FamilyIds.round(GameKind.TWENTY, 1, 0, AgeBand.MIDDLE), e))
        assertNotNull(FamilyMenu.entryFor(FamilyIds.storyPart("milo-mail-truck", 0), e))
        assertNull(FamilyMenu.entryFor(FamilyIds.story("missing"), e))
        assertNull(FamilyMenu.entryFor("family/nonsense", e))
    }

    // ---- asking something to play -------------------------------------------------------------------------

    @Test
    fun `tapping a story queues every part in order`() {
        val id = Stories.ALL.first().id
        val queue = FamilyScripts.storyQueue(id)
        assertEquals(Stories.partCount(Stories.ALL.first()), queue.size)
        assertEquals((0 until queue.size).map { FamilyIds.storyPart(id, it) }, queue.map { it.id })
        assertTrue(FamilyScripts.storyQueue("missing").isEmpty())
    }

    @Test
    fun `a game from the car needs the parent's switch, and then queues every round with one seed`() {
        val worst = FamilyRuntime.WORST_CASE
        assertTrue(FamilyScripts.gameQueue(GameKind.SOUND, 9, env(handsFree = false), car, worst).isEmpty())
        val q = FamilyScripts.gameQueue(GameKind.SOUND, 9, env(handsFree = true), car, worst)
        assertEquals(GameKind.SOUND.rounds, q.size)
        q.forEachIndexed { i, row ->
            assertEquals(FamilyIds.Parsed.Round(GameKind.SOUND, 9, i, AgeBand.MIDDLE), FamilyIds.parse(row.id))
        }
    }

    @Test
    fun `a passenger's own phone can start a game without the parent's switch`() {
        val q = FamilyScripts.gameQueue(GameKind.ALPHABET, 4, env(handsFree = false), screen, passenger)
        assertEquals(26, q.size)
        // The same phone while projecting to the car may not.
        val projecting = passenger.copy(projectingToAndroidAuto = true)
        assertTrue(FamilyScripts.gameQueue(GameKind.ALPHABET, 4, env(handsFree = false), screen, projecting).isEmpty())
    }

    @Test
    fun `a single item is refused when the gate says no and spoken when it says yes`() {
        val round = FamilyIds.round(GameKind.TWENTY, 3, 0, AgeBand.MIDDLE)
        val worst = FamilyRuntime.WORST_CASE
        assertNull(FamilyScripts.forMedia(round, env(handsFree = false), car, worst))
        assertNotNull(FamilyScripts.forMedia(round, env(handsFree = true), car, worst))
        assertNull(FamilyScripts.forMedia(round, env(now = late, handsFree = true, quiet = nightly), car, worst))
        // Stories and the clock always speak.
        assertNotNull(FamilyScripts.forMedia(FamilyIds.storyPart("milo-mail-truck", 0), env(), car, worst))
        assertNotNull(FamilyScripts.forMedia(FamilyIds.CLOCK, env(), car, worst))
        // Folders and unknown ids are not speakable.
        assertNull(FamilyScripts.forMedia(FamilyIds.ROOT, env(), car, worst))
        assertNull(FamilyScripts.forMedia("family/nonsense", env(), car, worst))
    }

    @Test
    fun `the clock is spoken with the estimate line every time`() {
        val running = TripClockLogic.start(noon, noon + 300 * 60_000L, 0, KidUnit.NONE, 0).copy(kidUnit = "movies")
        val said = FamilyScripts.forPlayback(FamilyIds.CLOCK, env(clock = running))!!
        assertTrue(said.script.spokenText.startsWith("About 3 more movies."))
        assertTrue(said.script.spokenText.contains("Estimate only. Use your navigation app for directions."))
    }

    // ---- speech files ----------------------------------------------------------------------------------------

    @Test
    fun `the same words at the same speed are the same file, and anything else is another`() {
        val a = SpokenItem("t", "s", Script(listOf(Step.Say("Hello there."), Step.Pause(1_000))), 0.95f)
        val same = SpokenItem("other title", "other", Script(listOf(Step.Say("Hello there."), Step.Pause(1_000))), 0.95f)
        val slower = a.copy(speechRate = 0.82f)
        val longer = SpokenItem("t", "s", Script(listOf(Step.Say("Hello there."), Step.Pause(2_000))), 0.95f)
        val words = SpokenItem("t", "s", Script(listOf(Step.Say("Hello there!"), Step.Pause(1_000))), 0.95f)
        assertEquals(SpeechCache.key(a), SpeechCache.key(same))
        assertNotEquals(SpeechCache.key(a), SpeechCache.key(slower))
        assertNotEquals(SpeechCache.key(a), SpeechCache.key(longer))
        assertNotEquals(SpeechCache.key(a), SpeechCache.key(words))
        assertTrue(SpeechCache.key(a).matches(Regex("[0-9a-f]{32}")))
    }

    @Test
    fun `only the newest speech files are kept`() {
        val files = (1..50).map { "f$it.wav" to it * 1_000L }
        val doomed = SpeechCache.trimPlan(files, keep = 40)
        assertEquals(10, doomed.size)
        assertEquals((1..10).map { "f$it.wav" }.toSet(), doomed.toSet())
        assertTrue(SpeechCache.trimPlan(files.take(5), keep = 40).isEmpty())
    }

    @Test
    fun `long text is spoken in pieces that end at sentence ends`() {
        val text = (1..40).joinToString(" ") { "This is sentence number $it of many." }
        val pieces = SpeechCache.chunks(text, 200)
        assertTrue(pieces.size > 3)
        pieces.forEach { assertTrue("${it.length}", it.length <= 200) }
        assertEquals(text.replace(" ", ""), pieces.joinToString("").replace(" ", ""))
        pieces.dropLast(1).forEach { assertTrue(it.endsWith(".")) }
        assertEquals(listOf("short"), SpeechCache.chunks("short", 200))
        // Text with no spaces at all still splits rather than looping.
        assertTrue(SpeechCache.chunks("x".repeat(1_000), 200).all { it.length <= 200 })
    }
}
