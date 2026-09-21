package com.beeboentertainment.movie.campsite.solo

import com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog
import com.beeboentertainment.movie.campsite.games.GameCategory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class SolitaireTest {

    private val C = 0; private val D = 1; private val H = 2; private val S = 3
    private fun card(suit: Int, rank: Int) = Card.of(suit, rank)

    /** A hand-built position; unused cards go in the stock so the deck is still 52. */
    private fun position(tableau: List<List<Int>>, faceDown: List<Int> = List(7) { 0 }, waste: List<Int> = emptyList(),
                         foundations: List<List<Int>> = List(4) { emptyList() }): Klondike {
        val used = (tableau.flatten() + waste + foundations.flatten()).toSet()
        return Klondike(stock = (0 until 52).filter { it !in used }, waste = waste, foundations = foundations,
            tableau = tableau, faceDown = faceDown)
    }

    @Test fun `a deal has 52 unique cards in the classic layout`() {
        repeat(50) { seed ->
            val g = Klondike.deal(Random(seed), drawCount = if (seed % 2 == 0) 1 else 3)
            assertEquals((0 until 52).toList(), g.allCards().sorted())
            assertEquals((1..7).toList(), g.tableau.map { it.size })
            assertEquals((0..6).toList(), g.faceDown)
            assertEquals(24, g.stock.size)
            assertTrue(g.waste.isEmpty() && g.foundations.all { it.isEmpty() })
        }
    }

    @Test fun `tableau accepts alternating colours one lower and only kings on empty columns`() {
        val g = position(listOf(listOf(card(S, 8)), listOf(card(H, 7)), listOf(card(D, 7)), emptyList(), listOf(card(C, 13)), listOf(card(C, 7)), emptyList()))
        assertNotNull(g.move(Spot.Tableau(1), 1, Spot.Tableau(0)))   // red 7 on black 8
        assertNull(g.move(Spot.Tableau(5), 1, Spot.Tableau(0)))      // black 7 on black 8
        assertNull(g.move(Spot.Tableau(0), 1, Spot.Tableau(1)))      // 8 on 7
        assertNull(g.move(Spot.Tableau(1), 1, Spot.Tableau(3)))      // 7 to empty column
        assertNotNull(g.move(Spot.Tableau(4), 1, Spot.Tableau(3)))   // king to empty column
        assertNull(g.move(Spot.Tableau(1), 1, Spot.Foundation(0)))   // 7 to empty foundation
    }

    @Test fun `foundations build up by suit from the ace`() {
        val g = position(listOf(listOf(card(H, 1)), listOf(card(H, 2)), listOf(card(S, 2)), emptyList(), emptyList(), emptyList(), emptyList()))
        assertNull(g.move(Spot.Tableau(1), 1, Spot.Foundation(0)))
        val a = g.move(Spot.Tableau(0), 1, Spot.Foundation(0))!!
        assertNull(a.move(Spot.Tableau(2), 1, Spot.Foundation(0)))
        val b = a.move(Spot.Tableau(1), 1, Spot.Foundation(0))!!
        assertEquals(listOf(card(H, 1), card(H, 2)), b.foundations[0])
        assertEquals(52, b.allCards().size)
    }

    @Test fun `runs move together and the card underneath turns face up`() {
        val g = position(
            listOf(listOf(card(C, 5), card(S, 9), card(H, 8), card(C, 7)), listOf(card(D, 10)), emptyList(), emptyList(), emptyList(), emptyList(), emptyList()),
            faceDown = listOf(1, 0, 0, 0, 0, 0, 0),
        )
        assertTrue(g.isMovableRun(0, 3))
        assertFalse(g.isMovableRun(0, 4)) // includes the face-down card
        val moved = g.move(Spot.Tableau(0), 3, Spot.Tableau(1))!!
        assertEquals(listOf(card(D, 10), card(S, 9), card(H, 8), card(C, 7)), moved.tableau[1])
        assertEquals(0, moved.faceDown[0])
        assertEquals(5, moved.score) // turning a card over
    }

    @Test fun `drawing and redealing, with vegas limiting passes`() {
        var g = Klondike.deal(Random(3), drawCount = 3)
        val first = g.stock.takeLast(3).reversed()
        g = g.draw()!!
        assertEquals(first, g.waste)
        repeat(7) { g = g.draw()!! }
        assertTrue(g.stock.isEmpty()); assertEquals(24, g.waste.size)
        val redealt = g.draw()!!
        assertEquals(24, redealt.stock.size); assertEquals(1, redealt.redeals)

        var v = Klondike.deal(Random(3), drawCount = 1, scoring = Scoring.VEGAS)
        assertEquals(-52, v.score)
        repeat(24) { v = v.draw()!! }
        assertFalse(v.canRedeal)
        assertNull(v.draw())
    }

    @Test fun `undo is the previous state`() {
        val start = Klondike.deal(Random(9))
        val history = mutableListOf(start)
        var g = start.draw()!!
        history.add(g)
        g = g.draw()!!
        assertEquals(history.last(), history.removeAt(history.size - 1))
        assertEquals(start, history.single())
        assertEquals(start.allCards().sorted(), g.allCards().sorted())
    }

    @Test fun `tap to move prefers the foundation`() {
        val g = position(listOf(listOf(card(S, 2)), listOf(card(H, 3)), emptyList(), emptyList(), emptyList(), emptyList(), emptyList()),
            foundations = listOf(listOf(card(S, 1)), emptyList(), emptyList(), emptyList()))
        val moved = g.autoMove(Spot.Tableau(0), 1)!!
        assertEquals(2, moved.foundations[0].size)
        // A lone king is not shuffled between empty columns.
        val k = position(listOf(listOf(card(S, 13)), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList()))
        assertNull(k.autoMove(Spot.Tableau(0), 1))
    }

    @Test fun `auto finish is offered only when everything is face up and it wins`() {
        // All 52 cards face up in four columns, one suit per column, king at the bottom.
        val cols = (0 until 4).map { s -> (13 downTo 1).map { card(s, it) } } + List(3) { emptyList<Int>() }
        var g = Klondike(stock = emptyList(), tableau = cols, faceDown = List(7) { 0 })
        assertTrue(g.canAutoFinish)
        var steps = 0
        while (!g.won) { g = g.autoFinishStep()!!; steps++ }
        assertEquals(52, steps)
        assertFalse(g.canAutoFinish)

        val notYet = Klondike.deal(Random(1))
        assertFalse(notYet.canAutoFinish)
        val hidden = Klondike(stock = emptyList(), tableau = cols, faceDown = listOf(1, 0, 0, 0, 0, 0, 0))
        assertFalse(hidden.canAutoFinish)
    }

    @Test fun `solitaire is a solo card game`() {
        val g = CampsiteGameCatalog.solo("solitaire")!!
        assertFalse(g.needsGuests)
        assertEquals(GameCategory.CARD, g.category)
        assertTrue(g.needsTouch)
        assertFalse(g.showOnTv)
    }
}
