package com.beeboentertainment.movie.party.games
import org.junit.Assert.*
import org.junit.Test

class ConnectFourRulesTest {
    @Test fun `counters fall and full columns reject further moves`() {
        var board=List(42){0}
        repeat(6){i->board=ConnectFourRules.drop(board,3,1+i%2)!!}
        assertNull(ConnectFourRules.drop(board,3,1))
        assertEquals(2,board[3]);assertEquals(1,board[38])
        assertNull(ConnectFourRules.drop(board,-1,1));assertNull(ConnectFourRules.drop(board,7,1))
    }
    @Test fun `horizontal vertical and both diagonals win without wrapping rows`() {
        for(cells in listOf(listOf(35,36,37,38),listOf(14,21,28,35),listOf(14,22,30,38),listOf(20,26,32,38))){
            val b=MutableList(42){0};cells.forEach{b[it]=2}
            assertEquals(2,ConnectFourRules.winner(b));assertEquals(cells.toSet(),ConnectFourRules.winningCells(b).toSet())
            assertNull(ConnectFourRules.drop(b,0,1))
        }
        val b=MutableList(42){0};listOf(33,34,35,36).forEach{b[it]=1};assertEquals(0,ConnectFourRules.winner(b))
    }
    @Test fun `Carl wins when possible and blocks the next immediate loss`() {
        for(player in listOf(1,2)){
            val b=MutableList(42){0};listOf(35,36,37).forEach{b[it]=player}
            assertEquals(3,ConnectFourRules.botColumn(b))
        }
        assertEquals(3,ConnectFourRules.botColumn(List(42){0}))
    }
}
