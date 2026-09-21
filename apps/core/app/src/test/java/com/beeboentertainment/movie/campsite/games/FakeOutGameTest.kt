package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class FakeOutGameTest {

    private fun start(n: Int = 4, ctx: TestCtx = TestCtx(), setup: String = "") =
        FakeOutGame.create(seats(n), setup, ctx) as FakeOutGame.Match

    private fun FakeOutGame.Match.stage() = view(null).str("stage")

    /** Fakes guaranteed to be far from any answer and from each other. */
    private fun fakeFor(id: String) = "zqx invented reply $id"

    @Test fun `answers that match or nearly match the truth are too close`() {
        assertTrue(FakeOutGame.tooClose("Flamboyance", "flamboyance"))
        assertTrue(FakeOutGame.tooClose("a flamboyance", "flamboyance"))
        assertTrue(FakeOutGame.tooClose("flamboyence", "flamboyance"))
        assertTrue(FakeOutGame.tooClose("8", "eight"))
        assertTrue(FakeOutGame.tooClose("chocolate bars", "chocolate bar"))
        assertTrue(FakeOutGame.tooClose("a big chocolate bar", "chocolate bar"))
        assertTrue(FakeOutGame.tooClose("pocket watch", "pocket watches"))
        assertFalse(FakeOutGame.tooClose("sparkle", "flamboyance"))
        assertFalse(FakeOutGame.tooClose("nine", "eight"))
        assertFalse(FakeOutGame.tooClose("cat", "bat"))
    }

    @Test fun `a too-close fake and a duplicate fake are refused, and fakes stay hidden while writing`() {
        val m = start()
        val answer = m.fact.answer
        val e = assertThrows(IllegalArgumentException::class.java) { m.apply(mv("p0", "fake", "text" to answer.uppercase())) }
        assertTrue(e.message!!.contains("Too close"))
        m.apply(mv("p0", "fake", "text" to "zqx lie"))
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv("p1", "fake", "text" to "ZQX  lie!")) }
        assertEquals(0, m.view("p1").getValue("choices").jsonArray.size)
        assertEquals("", m.view("p1").str("myFake"))
        assertEquals("zqx lie", m.view("p0").str("myFake"))
    }

    @Test fun `voting shows every fake plus the truth, and scores truth-finders and foolers`() {
        val m = start(4)
        m.players.forEach { m.apply(mv(it, "fake", "text" to fakeFor(it))) }
        assertEquals("voting", m.stage())
        assertEquals(5, m.options.size)
        assertEquals(1, m.options.count { it.truth })
        val truth = m.options.indexOfFirst { it.truth }
        val p0fake = m.options.indexOfFirst { "p0" in it.authors }
        // No author is revealed during the vote.
        assertFalse(m.view("p1").getValue("choices").jsonArray[0].jsonObject.containsKey("authors"))
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv("p0", "vote", "choice" to p0fake)) }
        m.apply(mv("p0", "vote", "choice" to truth))
        m.apply(mv("p1", "vote", "choice" to p0fake))
        m.apply(mv("p2", "vote", "choice" to p0fake))
        m.apply(mv("p3", "vote", "choice" to truth))
        assertEquals("results", m.stage())
        assertEquals(FakeOutGame.TRUTH_POINTS + 2 * FakeOutGame.FOOL_POINTS, m.scoreOf("p0"))
        assertEquals(0, m.scoreOf("p1"))
        assertEquals(FakeOutGame.TRUTH_POINTS, m.scoreOf("p3"))
        assertEquals(m.fact.answer, m.view("p1").str("answer"))
    }

    @Test fun `clocks move writing to voting to results to the next fact, and rounds end the game`() {
        val ctx = TestCtx()
        val m = start(3, ctx, "rounds=3;seconds=60")
        repeat(3) { round ->
            assertEquals("writing", m.stage())
            assertEquals(round + 1, m.view(null).num("question"))
            m.apply(mv("p0", "fake", "text" to fakeFor("p0")))
            ctx.clock += 60_000; assertTrue(m.tick())
            assertEquals("voting", m.stage())
            // One fake is not a vote worth having: the house tops it up to two.
            assertEquals(3, m.options.size)
            ctx.clock += FakeOutGame.VOTE_MS; assertTrue(m.tick())
            assertEquals("results", m.stage())
            ctx.clock += FakeOutGame.RESULTS_MS; assertTrue(m.tick())
        }
        assertEquals("done", m.phase)
        assertEquals(Outcome.SCORES, m.result()!!.outcome)
    }

    @Test fun `house decoys are never close to the answer or to a written fake`() {
        repeat(30) { seed ->
            val m = start(3, TestCtx(seed))
            val decoys = m.decoys(2, Random(seed))
            assertEquals(2, decoys.size)
            decoys.forEach { assertFalse(it, FakeOutGame.tooClose(it, m.fact.answer)) }
            assertNotEquals(decoys[0].lowercase(), decoys[1].lowercase())
        }
    }

    @Test fun `players who leave are not waited for, can come back, and too few ends the game`() {
        val m = start(4)
        m.apply(mv("p0", "fake", "text" to fakeFor("p0")))
        m.apply(mv("p1", "fake", "text" to fakeFor("p1")))
        m.apply(mv("p2", "fake", "text" to fakeFor("p2")))
        assertTrue(m.playerLeft("p3"))
        assertEquals("voting", m.stage())
        m.playerReturned("p3")
        m.apply(mv("p3", "vote", "choice" to m.options.indexOfFirst { it.truth }))
        m.playerLeft("p0"); m.playerLeft("p1"); m.playerLeft("p2")
        assertEquals(Outcome.VOID, m.result()!!.outcome)
    }

    @Test fun `bots write legal fakes and vote legally through a whole game`() {
        val ctx = TestCtx(3)
        val m = start(5, ctx, "rounds=3")
        val random = Random(8)
        var guard = 0
        while (m.phase != "done" && guard++ < 50) {
            m.players.forEach { id -> FakeOutGame.botMove(m, id, random)?.let { m.apply(it) } }
            if (m.stage() == "results") m.apply(mv("p0", "next"))
        }
        assertEquals("done", m.phase)
    }

    @Test fun `facts are 150, unique, have a blank, and answers are short`() {
        val all = FakeOutFacts.ALL
        assertEquals(150, all.size)
        assertEquals(all.size, all.map { it.prompt.lowercase() }.toSet().size)
        all.forEach {
            assertEquals(it.prompt, 1, Regex("____").findAll(it.prompt).count())
            assertTrue(it.prompt, it.prompt.length <= 140)
            assertTrue(it.answer, it.answer.isNotBlank() && it.answer.length <= 20)
            assertTrue(it.kind.isNotBlank())
        }
    }
}
