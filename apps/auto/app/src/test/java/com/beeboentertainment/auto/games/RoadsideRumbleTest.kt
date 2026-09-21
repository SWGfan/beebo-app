package com.beeboentertainment.auto.games

import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * Pure-JVM tests for the Roadside Rumble engine and its bot, Cruisin' Carl.
 *
 * Everything under test is Android-free — [RoadsideRumbleRules] is a set of pure
 * functions, [CruisinCarl] a pure brain, and [GameEngine]/[PlayerSlot] use only
 * kotlinx-coroutines — so the whole suite runs with plain JUnit and `runBlocking`,
 * no Robolectric and no instrumentation.
 */
class RoadsideRumbleTest {

    private val rules = RoadsideRumbleRules
    private fun start() = rules.initialState(listOf("a", "b"))

    // ------------------------------------------------------------- basic rules

    @Test
    fun startsEmptyWithFirstSeatToMove() {
        val st = start()
        assertEquals(0, st.turnsPlayed)
        assertEquals(0, st.owners.size)
        assertEquals(25, st.tileCount)
        assertEquals(0, rules.currentSeatIndex(st))
        assertFalse(rules.isOver(st))
    }

    @Test
    fun claimingScoresAndSetsOwner() {
        var st = start()
        st = rules.applyMove(st, 0, RoadsideMove(0, 0))
        assertEquals("a", st.owners[st.indexOf(0, 0)])
        assertEquals(1, rules.scores(st)["a"])
        assertEquals(0, rules.scores(st)["b"])
        assertEquals(1, st.turnsPlayed)
    }

    @Test
    fun turnsAlternateRoundRobin() {
        var st = start()
        assertEquals(0, rules.currentSeatIndex(st))
        st = rules.applyMove(st, 0, RoadsideMove(0, 0))
        assertEquals(1, rules.currentSeatIndex(st))
        st = rules.applyMove(st, 1, RoadsideMove(4, 4))
        assertEquals(0, rules.currentSeatIndex(st))
    }

    // --------------------------------------------------- adjacency lock, 1 turn

    @Test
    fun claimLocksOrthogonalNeighboursForExactlyOneTurn() {
        var st = start()
        // a claims the centre on turn 0.
        st = rules.applyMove(st, 0, RoadsideMove(2, 2))
        val up = st.indexOf(1, 2)
        val down = st.indexOf(3, 2)
        val left = st.indexOf(2, 1)
        val right = st.indexOf(2, 3)

        // On the very next turn (turn 1) all four orthogonal neighbours are locked...
        assertTrue(st.isLocked(up))
        assertTrue(st.isLocked(down))
        assertTrue(st.isLocked(left))
        assertTrue(st.isLocked(right))
        // ...and are absent from the legal moves.
        val legalTurn1 = rules.legalMoves(st).map { st.indexOf(it.row, it.col) }.toSet()
        assertFalse(up in legalTurn1)
        assertFalse(right in legalTurn1)

        // Diagonals are NOT locked — the lock is orthogonal only.
        assertFalse(st.isLocked(st.indexOf(1, 1)))

        // b plays somewhere far on turn 1; the game moves to turn 2.
        st = rules.applyMove(st, 1, RoadsideMove(0, 0))

        // The centre's neighbours are free again — the lock lasted a single turn.
        assertFalse(st.isLocked(up))
        assertFalse(st.isLocked(down))
        assertFalse(st.isLocked(left))
        assertFalse(st.isLocked(right))
        val legalTurn2 = rules.legalMoves(st).map { st.indexOf(it.row, it.col) }.toSet()
        assertTrue(up in legalTurn2)
    }

    @Test
    fun legalMovesNeverEmptyBeforeGameEnds() {
        // Walk a whole game always taking the first legal tile; every turn must
        // offer at least one move (the "no pass" guarantee the design relies on).
        var st = start()
        while (!rules.isOver(st)) {
            val legal = rules.legalMoves(st)
            assertTrue("turn ${st.turnsPlayed} had no legal move", legal.isNotEmpty())
            st = rules.applyMove(st, rules.currentSeatIndex(st), legal.first())
        }
        assertEquals(15, st.turnsPlayed)
    }

    // --------------------------------------------------- end conditions & result

    @Test
    fun gameEndsAtFifteenTurns() {
        var st = start()
        var guard = 0
        while (!rules.isOver(st) && guard++ < 100) {
            st = rules.applyMove(st, rules.currentSeatIndex(st), rules.legalMoves(st).first())
        }
        assertTrue(rules.isOver(st))
        assertEquals(15, st.turnsPlayed)
        assertEquals(15, st.owners.size) // 15 distinct tiles claimed, no wasted turns
    }

    @Test
    fun winnerIsWhoeverClaimedMost() {
        val owners = (0 until 8).associateWith { "a" } + (8 until 15).associateWith { "b" }
        val st = RoadsideState(seatIds = listOf("a", "b"), owners = owners, turnsPlayed = 15)
        assertEquals(RoadsideResult.Win("a"), rules.result(st))
    }

    @Test
    fun equalClaimsAreATie() {
        val owners = (0 until 7).associateWith { "a" } + (7 until 14).associateWith { "b" }
        val st = RoadsideState(seatIds = listOf("a", "b"), owners = owners, turnsPlayed = 15)
        val r = rules.result(st)
        assertTrue(r is RoadsideResult.Tie)
        assertEquals(setOf("a", "b"), (r as RoadsideResult.Tie).seatIds.toSet())
    }

    @Test
    fun resultIsInProgressUntilOver() {
        val st = rules.applyMove(start(), 0, RoadsideMove(1, 1))
        assertEquals(RoadsideResult.InProgress, rules.result(st))
    }

    // ------------------------------------------------------------- Cruisin' Carl

    /** A mid-game state with varied tile weights (some tiles locked, some claimed). */
    private fun midGameState(): RoadsideState {
        var st = start()
        st = rules.applyMove(st, 0, RoadsideMove(2, 2)) // a: centre
        st = rules.applyMove(st, 1, RoadsideMove(0, 0)) // b: corner
        return st
    }

    @Test
    fun carlOnlyEverPicksLegalTiles() {
        for (difficulty in BotDifficulty.entries) {
            val carl = CruisinCarl(difficulty, Random(7))
            var st = start()
            while (!rules.isOver(st)) {
                val legal = rules.legalMoves(st)
                val move = carl.chooseMove(st)
                val i = st.indexOf(move.row, move.col)
                assertTrue("$difficulty picked an illegal move", move in legal)
                assertFalse("$difficulty picked a claimed tile", st.isClaimed(i))
                assertFalse("$difficulty picked a locked tile", st.isLocked(i))
                st = rules.applyMove(st, rules.currentSeatIndex(st), move)
            }
        }
    }

    @Test
    fun hardAlwaysTakesTheHighestWeightTile() {
        val st = midGameState()
        val carl = CruisinCarl(BotDifficulty.HARD)
        val chosen = carl.chooseMove(st)
        val chosenWeight = carl.weight(st, st.indexOf(chosen.row, chosen.col))
        val maxWeight = rules.legalMoves(st)
            .maxOf { carl.weight(st, st.indexOf(it.row, it.col)) }
        assertEquals(maxWeight, chosenWeight, 1e-9)
    }

    @Test
    fun easyPrefersStrongerTilesStayingInTheTopHalf() {
        val st = midGameState()
        val ref = CruisinCarl(BotDifficulty.EASY)
        val legal = rules.legalMoves(st)
        // Reconstruct the EASY pool: tiles ranked by weight, top half.
        val rankedWeights = legal
            .map { ref.weight(st, st.indexOf(it.row, it.col)) }
            .sortedDescending()
        val poolSize = (rankedWeights.size + 1) / 2
        val threshold = rankedWeights[poolSize - 1] // weakest tile EASY may pick

        // Across many seeds EASY never dips below that top-half threshold, and its
        // average clears the board median — i.e. it prefers higher-weight tiles.
        val median = rankedWeights[rankedWeights.size / 2]
        var sum = 0.0
        val trials = 60
        repeat(trials) { seed ->
            val move = CruisinCarl(BotDifficulty.EASY, Random(seed.toLong())).chooseMove(st)
            val w = ref.weight(st, st.indexOf(move.row, move.col))
            assertTrue("EASY dipped below the top half", w >= threshold - 1e-9)
            sum += w
        }
        assertTrue("EASY average should beat the median", sum / trials >= median - 1e-9)
    }

    // ----------------------------------------------- engine drives seats blindly

    @Test
    fun engineRunsBotVsBotToACleanFinish() = runBlocking {
        val a = BotPlayer("a", "Alpha", CruisinCarl(BotDifficulty.HARD, Random(1)))
        val b = BotPlayer("b", "Beta", CruisinCarl(BotDifficulty.MEDIUM, Random(2)))
        val engine = GameEngine(RoadsideRumbleRules, listOf(a, b))

        engine.run()

        val st = engine.state.value
        assertTrue(rules.isOver(st))
        assertEquals(15, st.turnsPlayed)
        assertEquals(15, st.owners.size)
        assertNotNull(rules.result(st))
        assertFalse(rules.result(st) is RoadsideResult.InProgress)
    }

    @Test
    fun engineAsksHumanAndBotSeatsIdentically() = runBlocking {
        // The same engine, one human seat and one bot seat: it must run to the
        // same clean finish, proving the loop never branches on seat type.
        val human = HumanPlayer<RoadsideState, RoadsideMove>("you", "You")
        val bot = BotPlayer("carl", "Cruisin' Carl", CruisinCarl(BotDifficulty.HARD, Random(3)))
        val engine = GameEngine(RoadsideRumbleRules, listOf(human, bot))

        val runner = launch { engine.run() }
        // Stand in for the UI: feed the human its move whenever it is their turn.
        val driver = launch {
            engine.state.collect { st ->
                if (!rules.isOver(st) && rules.currentSeatIndex(st) == 0) {
                    human.submit(rules.legalMoves(st).first())
                }
            }
        }
        runner.join()
        driver.cancel()

        val st = engine.state.value
        assertEquals(15, st.turnsPlayed)
        assertEquals(15, st.owners.size)
    }

    @Test
    fun humanSeatSuspendsUntilAMoveIsSubmitted() = runBlocking {
        val human = HumanPlayer<RoadsideState, RoadsideMove>("you", "You")
        val move = RoadsideMove(1, 2)

        val pending = async { human.decideMove(start()) }
        yield() // let the async reach its suspension point on receive()
        assertFalse("decideMove should wait for input", pending.isCompleted)

        human.submit(move)
        assertEquals(move, pending.await())
    }

    @Test
    fun engineExposesStartingStateImmediately() = runBlocking {
        val engine = GameEngine(
            RoadsideRumbleRules,
            listOf(
                BotPlayer("a", "A", CruisinCarl(BotDifficulty.HARD)),
                BotPlayer("b", "B", CruisinCarl(BotDifficulty.HARD)),
            ),
        )
        val initial = engine.state.first()
        assertEquals(0, initial.turnsPlayed)
        assertEquals(listOf("a", "b"), initial.seatIds)
    }
}
