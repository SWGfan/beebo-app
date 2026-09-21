package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.campsite.CampsiteGames
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class TwoTruthsTest {

    private val entry = TwoTruthsRules.Entry(listOf("I have climbed a volcano", "I own three kites", "I have met a penguin"), lie = 1)

    @Test fun `correct voters score one and the spotlight scores for each fooled voter`() {
        val players = listOf("a", "b", "c", "d", "e")
        val votes = mapOf("b" to 1, "c" to 0, "d" to 2, "a" to 1) // "a" is the spotlight: ignored
        val r = TwoTruthsRules.resolve(players, "a", entry, votes, foolPoints = 2)
        assertEquals(listOf("b"), r.correct)
        assertEquals(listOf("c", "d"), r.fooled)
        assertEquals(4, r.points["a"]) // two fooled x 2 points
        assertEquals(1, r.points["b"])
        assertEquals(0, r.points["c"])
        assertEquals(0, r.points["e"]) // did not vote: no points, fooled nobody's count
        assertEquals(listOf(1, 1, 1), r.counts)
    }

    @Test fun `out of range votes are not counted`() {
        val r = TwoTruthsRules.resolve(listOf("a", "b", "c"), "a", entry, mapOf("b" to 7, "c" to 1))
        assertEquals(listOf("c"), r.correct)
        assertTrue(r.fooled.isEmpty())
        assertEquals(0, r.points["a"])
    }

    @Test fun `turn order is seat order skipping players with no entry`() {
        val entries = mapOf("c" to entry, "a" to entry, "d" to entry)
        assertEquals(listOf("a", "c", "d"), TwoTruthsRules.turnOrder(listOf("a", "b", "c", "d"), entries))
        assertEquals(listOf("a", "c", "d"), TwoTruthsRules.voters(listOf("a", "b", "c", "d"), "b"))
    }

    @Test fun `validation enforces three distinct statements a lie and the length limit`() {
        val ok = TwoTruthsRules.validate(listOf(" one ", "two", "three"), 2, mask = true)
        assertEquals(listOf("one", "two", "three"), ok.statements)
        assertThrows(IllegalArgumentException::class.java) { TwoTruthsRules.validate(listOf("a", "", "c"), 0, true) }
        assertThrows(IllegalArgumentException::class.java) { TwoTruthsRules.validate(listOf("a", "A", "c"), 0, true) }
        assertThrows(IllegalArgumentException::class.java) { TwoTruthsRules.validate(listOf("a", "b", "c"), 3, true) }
        val long = "x".repeat(TwoTruthsContent.MAX_STATEMENT + 1)
        assertThrows(IllegalArgumentException::class.java) { TwoTruthsRules.validate(listOf("a", "b", long), 0, true) }
    }

    @Test fun `masking is host side whole word and can be turned off`() {
        val masked = TwoTruthsRules.validate(listOf("That was shit", "I like grass", "Scunthorpe is a town"), 0, mask = true)
        assertEquals("That was s***", masked.statements[0])
        assertEquals("I like grass", masked.statements[1])
        assertEquals("Scunthorpe is a town", masked.statements[2])
        val raw = TwoTruthsRules.validate(listOf("That was shit", "b", "c"), 0, mask = false)
        assertEquals("That was shit", raw.statements[0])
        assertEquals(TwoTruthsRules.Settings(2, false), TwoTruthsRules.settings("fool=2;mask=off"))
        assertEquals(TwoTruthsRules.Settings(1, true), TwoTruthsRules.settings(""))
    }

    @Test fun `idea prompts are unique non-empty and short`() {
        val ideas = TwoTruthsContent.IDEAS
        assertTrue(ideas.size >= 60)
        assertEquals(ideas.size, ideas.map { it.lowercase() }.toSet().size)
        assertTrue(ideas.all { it.isNotBlank() && it.length <= 80 })
    }

    @Test fun `metadata needs guests and three phones`() {
        assertTrue(TwoTruthsGame.needsGuests)
        assertEquals(3, TwoTruthsGame.seats.min)
        assertTrue(TwoTruthsGame.showOnTv)
        assertEquals(GameCategory.PARTY, TwoTruthsGame.category)
        assertSame(TwoTruthsGame, CampsiteGameCatalog["twotruths"])
    }

    // ---- played end to end through the real service -----------------------------------

    private var seq = 0
    private fun act(g: CampsiteGames, token: String, action: String, fields: JsonObjectBuilder.() -> Unit = {}, status: Int = 200): JsonObject {
        val room = g.handle(token).body["room"] as? JsonObject
        val r = g.handle(token, buildJsonObject {
            put("action", action); put("actionId", "t${seq++}"); put("round", room?.get("round") ?: JsonPrimitive(0)); fields()
        })
        assertEquals(r.body.toString(), status, r.status)
        return r.body
    }
    private fun room(g: CampsiteGames, token: String) = g.handle(token).body.getValue("room").jsonObject

    @Test fun `a full round keeps lies private until reveal and scores through the service`() {
        val g = CampsiteGames(random = Random(1))
        val (a, b, c) = listOf("Ann", "Ben", "Cat").map { g.join(it)!! }
        listOf(a, b, c).forEach { act(g, it, "enter", { put("game", "twotruths") }) }
        act(g, a, "start", { put("text", "fool=2") })
        fun write(t: String, lie: Int) = act(g, t, "entry", { put("s0", "$t one"); put("s1", "$t two"); put("s2", "$t three"); put("lie", lie) })
        write(a, 0)
        assertEquals(0, room(g, a).getValue("myLie").jsonPrimitive.int)
        assertFalse(room(g, b).containsKey("myLie"))
        write(b, 2)
        write(c, 1) // everybody has written: voting starts on its own, seat 0 first

        val ids = room(g, a).getValue("seats").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(ids[0], room(g, b).getValue("spotlight").jsonPrimitive.content)
        assertFalse(room(g, b).containsKey("correct"))
        act(g, a, "vote", { put("choice", 1) }, status = 409) // the spotlight cannot vote
        act(g, b, "vote", { put("choice", 0) }) // spotted
        act(g, c, "vote", { put("choice", 2) }) // fooled -> reveal
        val revealed = room(g, c)
        assertEquals("revealed", revealed.getValue("phase").jsonPrimitive.content)
        assertEquals(0, revealed.getValue("correct").jsonPrimitive.int)

        act(g, b, "next", status = 409) // only the leader moves on
        act(g, a, "next")
        assertEquals(ids[1], room(g, a).getValue("spotlight").jsonPrimitive.content)
        act(g, a, "vote", { put("choice", 2) }); act(g, c, "vote", { put("choice", 2) })
        act(g, a, "next")
        act(g, a, "vote", { put("choice", 0) }); act(g, b, "vote", { put("choice", 0) })
        act(g, a, "next")
        val done = room(g, a)
        assertEquals("done", done.getValue("phase").jsonPrimitive.content)
        val scores = done.getValue("players").jsonArray.associate {
            it.jsonObject.getValue("name").jsonPrimitive.content to it.jsonObject.getValue("score").jsonPrimitive.int
        }
        // Ann: fooled Cat (2) + spotted Ben (1) = 3. Ben: spotted Ann (1). Cat: spotted Ben (1) + fooled both (4) = 5.
        assertEquals(mapOf("Ann" to 3, "Ben" to 1, "Cat" to 5), scores)
    }
}
