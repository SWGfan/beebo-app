package com.beeboentertainment.movie.campsite.games

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class WerewolfGameTest {

    private fun start(n: Int, ctx: TestCtx = TestCtx(), setup: String = "") =
        WerewolfGame.create(seats(n), setup, ctx) as WerewolfGame.Match

    private fun WerewolfGame.Match.withRole(role: String) = players.filter { roles[it] == role }
    private fun WerewolfGame.Match.stage() = view(null).str("stage")

    private fun readyAll(m: WerewolfGame.Match) = m.players.forEach { if (m.stage() == "roles") m.apply(mv(it, "ready")) }

    @Test fun `roles scale with the number of players`() {
        for (n in 5..12) {
            val deck = WerewolfGame.deck(n)
            assertEquals(n, deck.size)
            assertEquals(1, deck.count { it == WerewolfGame.SEER })
            assertEquals(1, deck.count { it == WerewolfGame.HEALER })
            val wolves = deck.count { it == WerewolfGame.WOLF }
            assertEquals(if (n <= 6) 1 else if (n <= 9) 2 else 3, wolves)
            // Always fewer werewolves than a third of the camp, so the first night never ends it.
            assertTrue(wolves * 3 < n + 1)
            val m = start(n, TestCtx(n))
            assertEquals(deck.sorted(), m.roles.values.sorted())
        }
    }

    @Test fun `each phone sees only its own role, and werewolves see their pack`() {
        val m = start(8)
        val wolves = m.withRole(WerewolfGame.WOLF)
        m.players.forEach { id ->
            val v = m.view(id)
            assertEquals(m.roles[id], v.str("myRole"))
            assertFalse(v.containsKey("roles"))
            if (id in wolves) assertEquals(wolves.toSet(), v.getValue("pack").jsonArray.map { it.jsonPrimitive.content }.toSet())
            else assertFalse(v.containsKey("pack"))
        }
        assertEquals("", m.view(null).str("myRole"))
        assertFalse(m.view(null).containsKey("pack"))
    }

    @Test fun `night resolves when the werewolves, seer and healer have chosen, and the healer can save`() {
        val m = start(6, TestCtx(3))
        readyAll(m)
        assertEquals("night", m.stage())
        val wolf = m.withRole(WerewolfGame.WOLF).single()
        val seer = m.withRole(WerewolfGame.SEER).single()
        val healer = m.withRole(WerewolfGame.HEALER).single()
        val victim = m.withRole(WerewolfGame.VILLAGER).first()
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(wolf, "night", "target" to wolf)) }
        m.apply(mv(wolf, "night", "target" to victim))
        m.apply(mv(seer, "night", "target" to wolf))
        assertTrue(m.view(seer).getValue("checks").jsonObject.getValue(wolf).jsonPrimitive.boolean)
        assertFalse(m.view(wolf).containsKey("checks"))
        assertEquals("night", m.stage())
        m.apply(mv(healer, "night", "target" to victim))
        assertEquals("morning", m.stage())
        assertTrue(victim in m.alive)
        // Not the same player two nights running.
        m.apply(mv("p0", "continue"))
        assertEquals("day", m.stage())
    }

    @Test fun `a caught camper leaves the game and a day vote with a clear majority removes someone`() {
        val ctx = TestCtx(4)
        val m = start(7, ctx)
        readyAll(m)
        val wolves = m.withRole(WerewolfGame.WOLF)
        val healer = m.withRole(WerewolfGame.HEALER).single()
        val seer = m.withRole(WerewolfGame.SEER).single()
        val victim = m.withRole(WerewolfGame.VILLAGER).first()
        wolves.forEach { m.apply(mv(it, "night", "target" to victim)) }
        m.apply(mv(seer, "night", "target" to wolves.first()))
        m.apply(mv(healer, "night", "target" to healer))
        assertEquals("morning", m.stage())
        assertFalse(victim in m.alive)
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(healer, "vote", "target" to wolves.first())) }
        ctx.clock += WerewolfGame.PAUSE_MS
        assertTrue(m.tick())
        assertEquals("day", m.stage())
        // The dead do not vote.
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(victim, "vote", "target" to wolves.first())) }
        val target = wolves.first()
        m.alive.toList().forEach { voter ->
            if (m.stage() == "day") m.apply(mv(voter, "vote", "target" to if (voter == target) WerewolfGame.SKIP else target))
        }
        assertEquals("verdict", m.stage())
        assertFalse(target in m.alive)
        // Revealed by default.
        val fallen = m.view(null).getValue("fallen").jsonArray.map { it.jsonObject }
        assertEquals(WerewolfGame.WOLF, fallen.first { it.str("id") == target }.str("role"))
    }

    @Test fun `a tied day vote or more skips removes nobody`() {
        val ctx = TestCtx(9)
        val m = start(5, ctx)
        readyAll(m)
        ctx.clock += WerewolfGame.NIGHT_MS
        m.tick() // nobody chose, so nobody is caught
        assertEquals(5, m.alive.size)
        m.apply(mv("p0", "continue"))
        val (a, b) = m.players.take(2)
        m.apply(mv(m.players[2], "vote", "target" to a))
        m.apply(mv(m.players[3], "vote", "target" to b))
        m.apply(mv(m.players[4], "vote", "target" to WerewolfGame.SKIP))
        m.apply(mv(a, "vote", "target" to WerewolfGame.SKIP))
        m.apply(mv(b, "vote", "target" to WerewolfGame.SKIP))
        assertEquals("verdict", m.stage())
        assertEquals(5, m.alive.size)
    }

    @Test fun `the leader cannot skip the night`() {
        val m = start(5, TestCtx(2))
        readyAll(m)
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv("p0", "continue")) }
    }

    @Test fun `werewolves win once they match the villagers`() {
        val ctx = TestCtx(21)
        val m = start(5, ctx)
        readyAll(m)
        val wolf = m.withRole(WerewolfGame.WOLF).single()
        val others = m.players.filter { it != wolf }
        // Night 1: one caught (nobody protects). Day: an innocent voted out. Night 2: one against one.
        m.apply(mv(wolf, "night", "target" to others[0]))
        ctx.clock += WerewolfGame.NIGHT_MS; assertTrue(m.tick())
        assertEquals("morning", m.stage())
        ctx.clock += WerewolfGame.PAUSE_MS; assertTrue(m.tick())
        assertEquals("day", m.stage())
        val alive = m.alive.toList()
        assertEquals(4, alive.size)
        val scapegoat = alive.first { it != wolf }
        alive.forEach { if (m.stage() == "day") m.apply(mv(it, "vote", "target" to if (it == scapegoat) wolf else scapegoat)) }
        assertFalse(scapegoat in m.alive)
        assertEquals("verdict", m.stage())
        ctx.clock += WerewolfGame.PAUSE_MS; assertTrue(m.tick())
        assertEquals("night", m.stage())
        m.apply(mv(wolf, "night", "target" to m.alive.first { it != wolf }))
        ctx.clock += WerewolfGame.NIGHT_MS; assertTrue(m.tick())
        assertEquals("done", m.phase)
        assertEquals(setOf(wolf), m.result()!!.winners)
        assertEquals(WerewolfGame.WOLF, m.view(null).getValue("roles").jsonObject.getValue(wolf).jsonPrimitive.content)
    }

    @Test fun `villager win is detected and saved as a team`() {
        val ctx = TestCtx(5)
        val m = start(5, ctx)
        readyAll(m)
        ctx.clock += WerewolfGame.NIGHT_MS; m.tick()
        ctx.clock += WerewolfGame.PAUSE_MS; m.tick()
        assertEquals("day", m.stage())
        val wolf = m.withRole(WerewolfGame.WOLF).single()
        m.alive.toList().forEach { if (m.stage() == "day") m.apply(mv(it, "vote", "target" to if (it == wolf) WerewolfGame.SKIP else wolf)) }
        assertEquals("done", m.phase)
        assertEquals(m.players.filter { it != wolf }.toSet(), m.result()!!.winners)
        assertTrue(m.view(null).str("prompt").contains("villagers win"))
    }

    @Test fun `hunches and the waiting list never reveal who has a night role`() {
        val m = start(6)
        readyAll(m)
        m.players.forEach { assertFalse(m.hasAnswered(it)) }
        assertEquals(m.alive.toSet(), m.waitingOn().toSet())
        val villager = m.withRole(WerewolfGame.VILLAGER).first()
        m.apply(mv(villager, "night", "target" to m.players.first { it != villager }))
        assertEquals("hunch", m.view(villager).str("myPick"))
        assertFalse(m.hasAnswered(villager))
    }

    @Test fun `a player who drops out stays in, is not waited for, and can come back`() {
        val ctx = TestCtx(6)
        val m = start(6, ctx)
        val gone = m.players.last()
        assertTrue(m.playerLeft(gone))
        m.players.filter { it != gone }.forEach { m.apply(mv(it, "ready")) }
        assertEquals("night", m.stage())
        assertTrue(gone in m.alive)
        m.playerReturned(gone)
        assertEquals(m.roles[gone], m.view(gone).str("myRole"))
        // Down to two phones: the game is called off with no result.
        m.players.take(4).forEach { m.playerLeft(it) }
        assertEquals(Outcome.VOID, m.result()!!.outcome)
    }

    @Test fun `narration moves on with every stage and carries kind wording`() {
        val ctx = TestCtx(8)
        val m = start(5, ctx)
        val first = m.view(null).getValue("narration").jsonObject.str("id")
        readyAll(m)
        val night = m.view(null).getValue("narration").jsonObject
        assertNotEquals(first, night.str("id"))
        listOf("kill", "dead", "blood", "die").forEach { assertFalse(night.str("text").lowercase().contains(it)) }
    }

    @Test fun `bots finish a whole game with only legal moves`() {
        repeat(5) { seed ->
            val ctx = TestCtx(seed)
            val m = start(8, ctx, "day=1")
            val random = Random(seed)
            var guard = 0
            while (m.phase != "done" && guard++ < 400) {
                m.players.forEach { id -> WerewolfGame.botMove(m, id, random)?.let { m.apply(it) } }
                ctx.clock += 20_000
                m.tick()
            }
            assertEquals("done", m.phase)
            assertTrue(m.result()!!.winners.isNotEmpty())
        }
    }
}
