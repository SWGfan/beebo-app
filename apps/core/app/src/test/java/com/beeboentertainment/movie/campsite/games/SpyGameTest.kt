package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.campsite.CampsiteGames
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class SpyGameTest {

    private fun start(n: Int = 5, ctx: TestCtx = TestCtx(), setup: String = "") =
        SpyGame.create(seats(n), setup, ctx) as SpyGame.Match

    @Test fun `exactly one spy and everyone else shares one place with a role`() {
        repeat(20) { seed ->
            val m = start(6, TestCtx(seed))
            val views = m.players.associateWith { m.view(it) }
            assertEquals(1, views.values.count { it.bool("mySpy") })
            val spyView = views.getValue(m.spy)
            assertEquals("", spyView.str("myLocation"))
            assertEquals("", spyView.str("myRole"))
            val places = views.filterKeys { it != m.spy }.values.map { it.str("myLocation") }.toSet()
            assertEquals(setOf(m.location.name), places)
            views.filterKeys { it != m.spy }.values.forEach { assertTrue(it.str("myRole") in m.location.roles) }
            // The real place is always in the public list, and the list is the right size.
            assertTrue(m.location.name in m.pool)
            assertEquals(SpyGame.POOL, m.pool.size)
        }
    }

    @Test fun `a spectator and the snapshot before the end never carry the secret`() {
        val m = start()
        val watcher = m.view(null)
        assertFalse(watcher.bool("mySpy"))
        assertEquals("", watcher.str("myLocation"))
        assertFalse(watcher.containsKey("spy"))
        assertFalse(watcher.containsKey("location"))
        m.players.forEach { assertFalse(m.view(it).containsKey("spy")) }
    }

    @Test fun `a majority vote on the spy wins for everyone else`() {
        val m = start(5)
        val accuser = m.players.first { it != m.spy }
        m.apply(mv(accuser, "accuse", "target" to m.spy))
        assertEquals("voting", m.view(null).str("stage"))
        // Five players, the suspect cannot vote: four voters, three needed.
        assertEquals(3, m.needed)
        val others = m.players.filter { it != m.spy && it != accuser }
        m.apply(mv(others[0], "vote", "choice" to 1))
        assertEquals("playing", m.phase)
        m.apply(mv(others[1], "vote", "choice" to 1))
        assertEquals("done", m.phase)
        val result = m.result()!!
        assertEquals(m.players.filter { it != m.spy }.toSet(), result.winners)
        assertEquals(m.location.name, m.view(null).str("location"))
        // The accuser earned a bonus for the catch.
        assertTrue(m.scoreOf(accuser) > m.scoreOf(others[0]))
        assertEquals(0, m.scoreOf(m.spy))
    }

    @Test fun `accusing an innocent player hands the win to the spy`() {
        val m = start(4)
        val innocent = m.players.filter { it != m.spy }
        m.apply(mv(innocent[0], "accuse", "target" to innocent[1]))
        // Four players, three voters, two needed: the accuser's own yes plus one more.
        m.apply(mv(innocent[2], "vote", "choice" to 1))
        assertEquals("done", m.phase)
        assertEquals(setOf(m.spy), m.result()!!.winners)
    }

    @Test fun `a failed vote resumes the clock where it stopped and uses up that call`() {
        val ctx = TestCtx()
        val m = start(5, ctx, "minutes=5")
        ctx.clock += 60_000
        val a = m.players.first { it != m.spy }
        val target = m.players.first { it != a }
        m.apply(mv(a, "accuse", "target" to target))
        val voters = m.players.filter { it != a && it != target }
        // Two "no" votes out of four already make three "yes" impossible.
        voters.take(2).forEach { m.apply(mv(it, "vote", "choice" to 0)) }
        assertEquals("asking", m.view(null).str("stage"))
        assertEquals(240_000L, m.view(null).getValue("remainingMs").jsonPrimitive.long)
        assertThrows(IllegalArgumentException::class.java) { m.apply(mv(a, "accuse", "target" to target)) }
    }

    @Test fun `an unanswered vote closes on its own and counts silence as no`() {
        val ctx = TestCtx()
        val m = start(5, ctx)
        val a = m.players.first { it != m.spy }
        m.apply(mv(a, "accuse", "target" to m.spy))
        ctx.clock += SpyGame.VOTE_MS
        assertTrue(m.tick())
        assertEquals("asking", m.view(null).str("stage"))
        assertEquals("playing", m.phase)
    }

    @Test fun `the spy guessing right wins and guessing wrong loses`() {
        val right = start(3, TestCtx(3))
        right.apply(mv(right.spy, "guess", "choice" to right.pool.indexOf(right.location.name)))
        assertEquals(setOf(right.spy), right.result()!!.winners)

        val wrong = start(3, TestCtx(3))
        val miss = wrong.pool.indexOfFirst { it != wrong.location.name }
        assertThrows(IllegalArgumentException::class.java) {
            wrong.apply(mv(wrong.players.first { it != wrong.spy }, "guess", "choice" to miss))
        }
        wrong.apply(mv(wrong.spy, "guess", "choice" to miss))
        assertFalse(wrong.spy in wrong.result()!!.winners)
    }

    @Test fun `running out of time is a win for the spy`() {
        val ctx = TestCtx()
        val m = start(4, ctx, "minutes=3")
        ctx.clock += 179_000
        assertFalse(m.tick())
        ctx.clock += 1_000
        assertTrue(m.tick())
        assertEquals(setOf(m.spy), m.result()!!.winners)
    }

    @Test fun `settings outside the range fall back to the default`() {
        assertEquals(SpyGame.DEFAULT_MINUTES, start(3, setup = "minutes=900").minutes)
        assertEquals(4, start(3, setup = "minutes=4").minutes)
    }

    @Test fun `a player who leaves and comes back keeps their card, and the spy leaving voids the round`() {
        val m = start(5)
        val villager = m.players.first { it != m.spy }
        val card = m.view(villager).str("myRole")
        assertTrue(m.playerLeft(villager))
        assertEquals("playing", m.phase)
        m.playerReturned(villager)
        assertEquals(card, m.view(villager).str("myRole"))
        assertTrue(m.playerLeft(m.spy))
        assertEquals("done", m.phase)
        assertEquals(Outcome.VOID, m.result()!!.outcome)
    }

    @Test fun `too few players left ends the round with no result`() {
        val m = start(3)
        m.playerLeft(m.players.first { it != m.spy })
        assertEquals(Outcome.VOID, m.result()!!.outcome)
    }

    @Test fun `bots only ever send moves the round accepts`() {
        val ctx = TestCtx(11)
        val m = start(6, ctx, "minutes=3")
        val random = Random(5)
        val human = m.players.first { it != m.spy }
        m.apply(mv(human, "accuse", "target" to m.players.first { it != human }))
        repeat(40) {
            m.players.forEach { id -> SpyGame.botMove(m, id, random)?.let { m.apply(it) } }
        }
        assertNotEquals("voting", m.view(null).str("stage"))
    }

    @Test fun `locations are sixty, unique and each has enough roles`() {
        val all = SpyLocations.ALL
        assertEquals(60, all.size)
        assertEquals(all.size, all.map { it.name.lowercase() }.toSet().size)
        all.forEach { place ->
            assertTrue(place.name, place.roles.size >= 6)
            assertEquals(place.name, place.roles.size, place.roles.map { it.lowercase() }.toSet().size)
            assertTrue(place.name, place.name.length in 3..30)
            place.roles.forEach { assertTrue(it, it.isNotBlank() && it.length <= 40) }
        }
    }

    // ---- through the real service -------------------------------------------

    private var seq = 0
    private fun act(g: CampsiteGames, token: String, action: String, vararg fields: Pair<String, JsonElement>): Int {
        val round = (g.handle(token).body["room"] as? JsonObject)?.get("round") ?: JsonPrimitive(0)
        return g.handle(token, buildJsonObject {
            put("action", action); put("actionId", "s${seq++}"); put("round", round)
            fields.forEach { (k, v) -> put(k, v) }
        }).status
    }
    private fun room(g: CampsiteGames, token: String) = g.handle(token).body.getValue("room").jsonObject

    @Test fun `the service needs three phones, keeps the round when one leaves, and saves the team win`() {
        val history = RecordingHistory()
        val g = CampsiteGames(history = history, random = Random(2), botClockEnabled = false)
        val tokens = (1..4).map { g.join("Guest $it")!! }
        tokens.take(2).forEach { act(g, it, "enter", "game" to JsonPrimitive("spy")) }
        assertEquals(409, act(g, tokens[0], "start"))
        tokens.drop(2).forEach { act(g, it, "enter", "game" to JsonPrimitive("spy")) }
        assertEquals(200, act(g, tokens[0], "start", "text" to JsonPrimitive("minutes=5")))
        assertEquals("playing", room(g, tokens[0]).str("phase"))

        val spyToken = tokens.first { room(g, it).bool("mySpy") }
        val leaver = tokens.first { it != spyToken }
        // The menu card says it needs guests.
        act(g, leaver, "leave")
        val card = g.handle(leaver).body.getValue("games").jsonArray.map { it.jsonObject }.first { it.str("id") == "spy" }
        assertTrue(card.bool("needsGuests"))
        assertEquals("playing", room(g, spyToken).str("phase"))
        // Back again, same seat.
        act(g, leaver, "enter", "game" to JsonPrimitive("spy"))
        assertTrue(room(g, leaver).bool("seated"))

        val pool = room(g, spyToken).getValue("pool").jsonArray.map { it.jsonPrimitive.content }
        val place = room(g, tokens.first { it != spyToken }).str("myLocation")
        assertEquals(200, act(g, spyToken, "guess", "choice" to JsonPrimitive(pool.indexOf(place))))
        assertEquals("done", room(g, spyToken).str("phase"))
        val saved = history.records.single()
        assertEquals("spy", saved.game)
        assertEquals(1, saved.players.count { it.won })
        assertEquals(g.name(spyToken), saved.winner)
    }
}
