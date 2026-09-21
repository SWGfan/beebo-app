package com.beeboentertainment.movie.campsite.quiz

import com.beeboentertainment.movie.campsite.family.Assets
import com.beeboentertainment.movie.campsite.family.FakeClock
import com.beeboentertainment.movie.campsite.games.CampsiteMatchHistory
import com.beeboentertainment.movie.campsite.games.ChampionRecord
import com.beeboentertainment.movie.campsite.games.MatchRecord
import com.beeboentertainment.movie.campsite.games.Standing
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class QuizSessionTest {

    private val bank = Assets.quizBank()
    private val clock = FakeClock()

    private class RecordingHistory : CampsiteMatchHistory {
        val matches = mutableListOf<MatchRecord>()
        override fun record(record: MatchRecord) { matches += record }
        override fun recordChampion(record: ChampionRecord) {}
        override fun recent(limit: Int): List<MatchRecord> = matches.takeLast(limit)
        override fun leaderboard(gameId: String?): List<Standing> = emptyList()
        override fun champions(limit: Int): List<ChampionRecord> = emptyList()
        override fun clear() { matches.clear() }
    }

    private fun questions(n: Int, band: AgeBand? = AgeBand.KIDS) = bank.select(emptySet(), band).take(n)

    private fun session(settings: QuizSettings = QuizSettings(), n: Int = 4, seed: Int = 1) =
        QuizSession(settings.normalised(), questions(n), Random(seed), clock)

    /** The displayed index of the right answer, worked out by the test from the source question. */
    private fun rightIndex(s: QuizSession, source: List<QuizQuestion>): Int {
        val snap = s.snapshot()
        val q = source.first { it.prompt == snap.prompt }
        return snap.options.indexOf(q.options[q.answer])
    }

    @Test fun correctAnswerAndFactStayHiddenUntilTheReveal() {
        val qs = questions(3)
        val s = QuizSession(QuizSettings().normalised(), qs, Random(3), clock)
        s.join("a", "Ann"); s.start()
        val asking = s.snapshot()
        assertEquals(QuizPhase.ASKING, asking.phase)
        assertEquals(-1, asking.correct)
        assertEquals("", asking.fact)
        assertEquals(4, asking.options.size)
        assertTrue(asking.rows.all { it.right == null && it.choice == null })
        val right = rightIndex(s, qs)
        s.answer("a", right)
        val revealed = s.snapshot()
        assertEquals(QuizPhase.REVEALED, revealed.phase)
        assertEquals(right, revealed.correct)
        assertTrue(revealed.fact.isNotBlank())
        assertEquals(1, revealed.rows.single().score)
    }

    @Test fun optionOrderIsShuffledSoTheDataFilePositionIsNotAPattern() {
        val qs = questions(20)
        val positions = HashSet<Int>()
        repeat(6) { seed ->
            val s = QuizSession(QuizSettings(rounds = 20).normalised(), qs, Random(seed), clock)
            s.join("a", "Ann"); s.start()
            repeat(qs.size) {
                positions += rightIndex(s, qs)
                s.reveal(); s.next()
            }
        }
        assertEquals(setOf(0, 1, 2, 3), positions)
    }

    @Test fun answersCanBeChangedUntilTheRevealAndTheQuestionRevealsWhenEveryoneAnswered() {
        val qs = questions(3)
        val s = QuizSession(QuizSettings().normalised(), qs, Random(5), clock)
        s.join("a", "Ann"); s.join("b", "Ben"); s.start()
        val right = rightIndex(s, qs)
        val wrong = (0..3).first { it != right }
        s.answer("a", wrong)
        s.answer("a", right)            // changed her mind
        assertEquals(QuizPhase.ASKING, s.snapshot().phase)
        s.answer("b", wrong)
        val snap = s.snapshot()
        assertEquals(QuizPhase.REVEALED, snap.phase)
        assertEquals(1, s.scoreOf("a"))
        assertEquals(0, s.scoreOf("b"))
        assertEquals(mapOf(true to 1, false to 1), snap.rows.groupingBy { it.right!! }.eachCount())
        assertEquals(1, snap.counts[right]); assertEquals(1, snap.counts[wrong])
    }

    @Test fun aGuestWhoLeftDoesNotHoldTheRoundUp() {
        val qs = questions(3)
        val s = QuizSession(QuizSettings().normalised(), qs, Random(5), clock)
        s.join("a", "Ann"); s.join("b", "Ben"); s.start()
        clock.advance(QuizSession.PRESENT_MS + 1)
        s.touch("a")
        s.answer("a", 0)
        assertEquals(QuizPhase.REVEALED, s.snapshot().phase)
    }

    @Test fun timerIsOffByDefaultAndHostControlledWhenOn() {
        val qs = questions(3)
        val off = QuizSession(QuizSettings().normalised(), qs, Random(1), clock)
        off.join("a", "Ann"); off.start()
        assertEquals(-1L, off.snapshot().remainingMs)
        clock.advance(10 * 60_000)
        assertEquals(QuizPhase.ASKING, off.snapshot().phase)   // no countdown, no pressure

        val on = QuizSession(QuizSettings(timerSeconds = 15).normalised(), qs, Random(1), clock)
        on.join("a", "Ann"); on.join("b", "Ben"); on.start()
        assertEquals(15_000L, on.snapshot().remainingMs)
        clock.advance(10_000)
        assertEquals(5_000L, on.snapshot().remainingMs)
        assertNull(on.answer("a", 1))
        clock.advance(6_000)                       // time is up
        assertEquals(QuizPhase.REVEALED, on.snapshot().phase)
        assertNotNull(on.answer("b", 1))           // too late, refused
        assertFalse(on.snapshot().rows.first { it.id == "b" }.answered)
    }

    @Test fun teamsAreBalancedLockedAfterTheStartAndScoredAsTheSumOfTheirMembers() {
        val qs = questions(3)
        val s = QuizSession(QuizSettings(teams = 2).normalised(), qs, Random(2), clock)
        listOf("a", "b", "c", "d").forEach { s.join(it, it.uppercase()) }
        assertEquals(listOf(2, 2), s.snapshot().teams.map { it.members })
        assertNull(s.setTeam("a", 1)); assertNotNull(s.setTeam("a", 5))
        s.start()
        assertNotNull(s.setTeam("a", 0))
        val right = rightIndex(s, qs)
        listOf("a", "b", "c", "d").forEach { id -> s.answer(id, if (s.teamOf(id) == 0) right else (right + 1) % 4) }
        val snap = s.snapshot()
        assertEquals(s.teamScore(0), snap.teams[0].score)
        assertEquals(s.teamScore(0) + s.teamScore(1), s.standings().sumOf { it.score })
        assertTrue(s.teamScore(0) > s.teamScore(1))
        assertEquals(listOf("Team Red"), s.winners())
    }

    @Test fun turnsModeRotatesTeamsAndOnlyTheirTurnCounts() {
        val qs = questions(4)
        val settings = QuizSettings(mode = QuizMode.TURNS, turnNames = listOf("Team Red", "Team Blue")).normalised()
        val s = QuizSession(settings, qs, Random(4), clock)
        assertNull(s.start())
        assertEquals("Team Red", s.currentTurn()!!.name)
        assertNotNull(s.answer("t1", 0))                       // not Blue's turn
        val right = rightIndex(s, qs)
        assertNull(s.answer("t0", right))
        assertEquals(QuizPhase.REVEALED, s.snapshot().phase)
        s.next()
        assertEquals("Team Blue", s.currentTurn()!!.name)
        assertNotNull(s.join("x", "Guest"))                    // phones cannot join a host-phone quiz
        assertEquals(1, s.scoreOf("t0")); assertEquals(0, s.scoreOf("t1"))
    }

    @Test fun startingWithNobodyOrNoQuestionsIsRefusedPolitely() {
        assertNotNull(session().start())
        val empty = QuizSession(QuizSettings().normalised(), emptyList(), Random(1), clock)
        empty.join("a", "Ann")
        assertNotNull(empty.start())
    }

    @Test fun serviceRecordsOneUnratedHistoryLineAndOneBadgeRoundNoMatterHowOften() {
        val history = RecordingHistory()
        var rounds = 0
        val service = QuizService(bank, clock, Random(9), history) { rounds++ }
        assertNull(service.open(QuizSettings(band = AgeBand.KIDS, rounds = 3)))
        service.post("t1", "Ann", buildJsonObject { put("action", "join") })
        assertNull(service.start())
        repeat(3) { service.reveal(); service.next() }
        service.next(); service.end(); service.close()
        assertEquals(1, history.matches.size)
        val record = history.matches.single()
        assertEquals("roadsidequiz", record.game)
        assertFalse("no cross-household leaderboard", record.rated)
        assertEquals(listOf("Ann"), record.players.map { it.name })
        assertEquals(1, rounds)
    }

    @Test fun aQuizStoppedBeforeAnyAnswerIsShownWritesNothing() {
        val history = RecordingHistory()
        val service = QuizService(bank, clock, Random(9), history)
        service.open(QuizSettings(band = AgeBand.KIDS, rounds = 3))
        service.post("t1", "Ann", buildJsonObject { put("action", "join") })
        service.start(); service.end()
        assertTrue(history.matches.isEmpty())
    }

    @Test fun anEarlyEndKeepsThePointsAndSaysSo() {
        val service = QuizService(bank, clock, Random(9))
        service.open(QuizSettings(band = AgeBand.KIDS, rounds = 5))
        service.post("t1", "Ann", buildJsonObject { put("action", "join") })
        service.start(); service.reveal(); service.end()
        val host = service.hostState()
        assertEquals(QuizPhase.DONE, host.snapshot!!.phase)
        assertTrue(host.aborted)
    }

    @Test fun questionsAreNotRepeatedWithinAndAcrossQuizzesWhileFreshOnesRemain() {
        val service = QuizService(bank, clock, Random(11))
        val seen = HashSet<String>()
        repeat(3) {
            service.open(QuizSettings(band = AgeBand.KIDS, rounds = 15))
            service.post("t1", "Ann", buildJsonObject { put("action", "join") })
            service.start()
            repeat(15) {
                val prompt = service.hostState().snapshot!!.prompt
                assertTrue("repeated: $prompt", seen.add(prompt))
                service.reveal(); service.next()
            }
            service.close()
        }
    }

    // ---- the guest door: privacy, XSS, limits -------------------------------------------------

    private fun open(rounds: Int = 5): QuizService {
        val service = QuizService(bank, clock, Random(7))
        assertNull(service.open(QuizSettings(band = AgeBand.MIDDLE, rounds = rounds)))
        return service
    }

    private fun act(service: QuizService, token: String, name: String, vararg pairs: Pair<String, Any>): com.beeboentertainment.movie.campsite.family.FamilyReply =
        service.post(token, name, buildJsonObject { pairs.forEach { (k, v) -> if (v is Int) put(k, v) else put(k, v.toString()) } })

    @Test fun guestViewNeverContainsTheAnswerOrTheFactBeforeTheReveal() {
        val service = open()
        act(service, "t1", "Ann", "action" to "join")
        service.start()
        val body = service.get("t1", "Ann").body
        assertEquals(-1, body["correct"]!!.jsonPrimitive.content.toInt())
        assertEquals("", body["fact"]!!.jsonPrimitive.content)
        val q = bank.questions.first { it.prompt == body["prompt"]!!.jsonPrimitive.content }
        assertFalse(body.toString().contains(q.fact))
    }

    @Test fun guestNamesAreCleanedAndNeverBecomeMarkup() {
        val service = open()
        act(service, "t1", "<img src=x onerror=alert(1)>\u0007Ann & \"Co\"", "action" to "join")
        service.start()
        val text = service.get("t1", "x").body.toString()
        assertFalse(text.contains("<")); assertFalse(text.contains(">")); assertFalse(text.contains("&"))
        assertFalse(text.contains("\u0007"))
        val me = service.get("t1", "x").body["me"]!!.jsonObject["name"]!!.jsonPrimitive.content
        assertTrue(me.length <= 24)
        val long = act(service, "t2", "N".repeat(500), "action" to "join").body["me"]!!.jsonObject["name"]!!.jsonPrimitive.content
        assertEquals(24, long.length)
    }

    @Test fun anAnswerForAnOldQuestionCannotLandOnTheNewOne() {
        val service = open()
        act(service, "t1", "Ann", "action" to "join")
        service.start()
        val stale = act(service, "t1", "Ann", "action" to "answer", "q" to 99, "choice" to 1)
        assertEquals(409, stale.status)
        assertEquals(409, act(service, "t1", "Ann", "action" to "answer", "q" to 1, "choice" to 9).status)
        assertEquals(409, act(service, "t1", "Ann", "action" to "nonsense").status)
        assertEquals(200, act(service, "t1", "Ann", "action" to "answer", "q" to 1, "choice" to 2).status)
    }

    @Test fun theRoomHasAHardPlayerLimit() {
        val service = open()
        repeat(QuizSession.MAX_PLAYERS) { assertEquals(200, act(service, "t$it", "P$it", "action" to "join").status) }
        val over = act(service, "extra", "Late", "action" to "join")
        assertEquals(409, over.status)
        assertEquals(QuizSession.MAX_PLAYERS, service.hostState().snapshot!!.rows.size)
    }

    @Test fun writesAndReadsAreRateLimitedPerGuestAndRecoverAfterTheWindow() {
        val service = open()
        repeat(20) { assertEquals(200, act(service, "t1", "Ann", "action" to "join").status) }
        assertEquals(429, act(service, "t1", "Ann", "action" to "join").status)
        assertEquals(200, act(service, "t2", "Ben", "action" to "join").status)   // another guest is unaffected
        repeat(60) { assertEquals(200, service.get("t3", "Cy").status) }
        assertEquals(429, service.get("t3", "Cy").status)
        clock.advance(10_001)
        assertEquals(200, service.get("t3", "Cy").status)
        assertEquals(200, act(service, "t1", "Ann", "action" to "join").status)
    }

    @Test fun noQuizOpenGivesAFriendlyIdleStateAndAConflictOnWrites() {
        val service = QuizService(bank, clock, Random(1))
        assertEquals("idle", service.get("t1", "Ann").body["phase"]!!.jsonPrimitive.content)
        assertEquals(409, act(service, "t1", "Ann", "action" to "join").status)
    }

    @Test fun tooFewQuestionsIsRefused() {
        val tiny = QuizBank(bank.questions.take(2))
        assertNotNull(QuizService(tiny, clock, Random(1)).open(QuizSettings()))
    }

    @Test fun jsonViewCarriesTeamsAndStandingsForThePage() {
        val service = QuizService(bank, clock, Random(3))
        service.open(QuizSettings(band = AgeBand.OLDER, rounds = 3, teams = 3))
        act(service, "t1", "Ann", "action" to "join"); act(service, "t2", "Ben", "action" to "join")
        val body: JsonObject = service.get("t1", "Ann").body
        assertEquals(3, body["teamNames"]!!.jsonArray.size)
        assertEquals(2, body["players"]!!.jsonArray.size)
        assertEquals("lobby", body["phase"]!!.jsonPrimitive.content)
    }
}
