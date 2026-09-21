package com.beeboentertainment.movie.campsite.games

import com.beeboentertainment.movie.campsite.CampsiteGames
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class NatureBingoAndStoriesTest {

    // ---- Nature Bingo ------------------------------------------------------------------

    @Test fun `a card has 25 unique cells with the free square in the centre`() {
        repeat(50) { seed ->
            val card = NatureBingoCards.generate(NaturePack.entries.toSet(), Random(seed))
            assertEquals(25, card.size)
            assertEquals(25, card.toSet().size)
            assertEquals(NatureBingoCards.FREE_LABEL, card[BingoGrid.FREE])
            assertEquals(1, card.count { it == NatureBingoCards.FREE_LABEL })
        }
    }

    @Test fun `cards only use the chosen packs`() {
        NaturePack.entries.forEach { pack ->
            val allowed = NatureBingoContent.itemsFor(setOf(pack)).map { it.label }.toSet()
            val card = NatureBingoCards.generate(setOf(pack), Random(pack.ordinal))
            assertTrue(pack.name, card.filter { it != NatureBingoCards.FREE_LABEL }.all { it in allowed })
        }
        val mixed = NatureBingoCards.generate(setOf(NaturePack.WATER, NaturePack.NIGHT), Random(1))
        val allowed = NatureBingoContent.itemsFor(setOf(NaturePack.WATER, NaturePack.NIGHT)).map { it.label }.toSet()
        assertTrue(mixed.drop(0).filter { it != NatureBingoCards.FREE_LABEL }.all { it in allowed })
        assertThrows(IllegalArgumentException::class.java) { NatureBingoCards.generate(emptySet(), Random(1)) }
    }

    @Test fun `bingo detection covers rows columns and both diagonals`() {
        assertEquals(12, BingoGrid.LINES.size)
        for (line in BingoGrid.LINES) assertTrue(line.toString(), BingoGrid.hasLine(line.toSet()))
        assertTrue(BingoGrid.hasLine(setOf(0, 6, 12, 18, 24)))
        assertTrue(BingoGrid.hasLine(setOf(4, 8, 12, 16, 20)))
        assertTrue(BingoGrid.hasLine(setOf(10, 11, 12, 13, 14)))
        assertFalse(BingoGrid.hasLine(setOf(0, 1, 2, 3, 12)))
        assertFalse(BingoGrid.hasLine(setOf(0, 6, 18, 24))) // a diagonal missing the centre
        assertFalse(BingoGrid.hasLine((0 until 25).filter { it % 5 != 2 && it / 5 != 2 }.toSet()))
    }

    @Test fun `nature list is 120 unique items in four packs of thirty`() {
        val items = NatureBingoContent.ITEMS
        assertEquals(120, items.size)
        assertEquals(120, items.map { it.label.lowercase() }.toSet().size)
        NaturePack.entries.forEach { p -> assertEquals(p.name, 30, items.count { it.pack == p }) }
        assertTrue(items.all { it.label.isNotBlank() && it.label.length <= 40 })
    }

    @Test fun `nature bingo settings and metadata`() {
        val s = NatureBingoCards.settings("packs=night+water;verify=off")
        assertEquals(setOf(NaturePack.NIGHT, NaturePack.WATER), s.packs)
        assertFalse(s.verify)
        assertEquals(setOf(NaturePack.EASY, NaturePack.FOREST), NatureBingoCards.settings("").packs)
        assertFalse(NatureBingoGame.needsGuests)
        assertEquals(GameCategory.OUTDOORS, NatureBingoGame.category)
        assertTrue(NatureBingoGame.usesCamera)
        assertFalse(NatureBingoGame.showOnTv)
    }

    @Test fun `the host verifies a called bingo through the service`() {
        val g = CampsiteGames(random = Random(3))
        val a = g.join("Ann")!!; val b = g.join("Ben")!!
        var seq = 0
        fun act(t: String, action: String, status: Int = 200, extra: JsonObjectBuilder.() -> Unit = {}) {
            val round = g.handle(t).body["room"]?.jsonObject?.get("round") ?: JsonPrimitive(0)
            val r = g.handle(t, buildJsonObject { put("action", action); put("actionId", "n${seq++}"); put("round", round); extra() })
            assertEquals(r.body.toString(), status, r.status)
        }
        fun room(t: String) = g.handle(t).body.getValue("room").jsonObject
        act(a, "enter") { put("game", "naturebingo") }; act(b, "enter") { put("game", "naturebingo") }
        act(a, "start") { put("text", "packs=easy") }
        act(b, "bingo", status = 409) // no line yet
        listOf(10, 11, 13, 14).forEach { cell -> act(b, "claim") { put("cell", cell) } }
        val bId = g.handle(b).body["you"]!!.jsonPrimitive.content
        act(b, "bingo")
        assertEquals(1, room(a)["claims"]!!.jsonArray.size)
        act(b, "verify", status = 409) { put("target", bId) } // only the host checks
        act(a, "reject") { put("target", bId) }
        assertEquals("playing", room(a)["phase"]!!.jsonPrimitive.content)
        act(b, "bingo")
        act(a, "verify") { put("target", bId) }
        assertEquals("done", room(a)["phase"]!!.jsonPrimitive.content)
        assertFalse(room(a).getValue("bingo").jsonArray.isEmpty())
    }

    // ---- Campfire Stories --------------------------------------------------------------

    @Test fun `story spinner is deterministic for a seed`() {
        val one = CampfireStoriesContent.spin(1234L)
        assertEquals(one, CampfireStoriesContent.spin(1234L))
        assertEquals(5, one.lines.size)
        assertTrue(one.lines.all { it.isNotBlank() })
        assertTrue(one.lines[0].contains(one.character) && one.lines[0].contains(one.place))
        val distinct = (0L until 30L).map { CampfireStoriesContent.spin(it).lines }.toSet()
        assertTrue(distinct.size > 20)
    }

    @Test fun `story content has 150 unique starters and tidy spinner pieces`() {
        val all = CampfireStoriesContent.STARTERS.values.flatten()
        assertEquals(150, all.size)
        StoryMood.entries.forEach { assertEquals(it.name, 50, CampfireStoriesContent.STARTERS.getValue(it).size) }
        assertEquals(all.size, all.map { it.lowercase() }.toSet().size)
        assertTrue(all.all { it.isNotBlank() && it.length in 20..160 })
        listOf(
            CampfireStoriesContent.CHARACTERS, CampfireStoriesContent.PLACES, CampfireStoriesContent.PROBLEMS,
            CampfireStoriesContent.TWISTS, CampfireStoriesContent.OPENINGS, CampfireStoriesContent.ENDINGS,
        ).forEach { list ->
            assertTrue(list.size >= 5)
            assertEquals(list.size, list.toSet().size)
            assertTrue(list.all { it.isNotBlank() && it == it.trim() })
        }
    }

    @Test fun `stories metadata and mood parsing`() {
        assertEquals(StoryMood.SPOOKY, CampfireStoriesGame.mood("mood=spooky"))
        assertEquals(StoryMood.COZY, CampfireStoriesGame.mood(""))
        assertFalse(CampfireStoriesGame.needsGuests)
        assertFalse(CampfireStoriesGame.ranked)
        assertEquals(GameCategory.WORD_AND_TALK, CampfireStoriesGame.category)
    }

    @Test fun `word filter masks whole words only`() {
        assertEquals("oh s***", CampfireWordFilter.mask("oh shit"))
        assertEquals("classic grass", CampfireWordFilter.mask("classic grass"))
        assertFalse(CampfireWordFilter.flags("Scunthorpe"))
    }
}
