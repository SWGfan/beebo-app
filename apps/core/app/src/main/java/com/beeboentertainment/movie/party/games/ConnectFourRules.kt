package com.beeboentertainment.movie.party.games

/** Row zero is the top. The same rules drive phone play and the campsite guest room. */
internal object ConnectFourRules {
    const val ROWS = 6
    const val COLS = 7
    fun drop(board: List<Int>, column: Int, player: Int): List<Int>? {
        if (board.size != ROWS * COLS || column !in 0 until COLS || player !in 1..2 || winner(board) != 0) return null
        val row = (ROWS - 1 downTo 0).firstOrNull { board[it * COLS + column] == 0 } ?: return null
        return board.toMutableList().also { it[row * COLS + column] = player }
    }

    fun winningCells(board: List<Int>): List<Int> {
        if (board.size != ROWS * COLS) return emptyList()
        for (row in 0 until ROWS) for (col in 0 until COLS) {
            val value = board[row * COLS + col]
            if (value == 0) continue
            for ((dr, dc) in listOf(0 to 1, 1 to 0, 1 to 1, 1 to -1)) {
                val cells = (0..3).map { n -> (row + dr * n) to (col + dc * n) }
                if (cells.all { (r, c) -> r in 0 until ROWS && c in 0 until COLS && board[r * COLS + c] == value })
                    return cells.map { (r, c) -> r * COLS + c }
            }
        }
        return emptyList()
    }

    fun winner(board: List<Int>): Int = winningCells(board).firstOrNull()?.let { board[it] } ?: 0

    /** Carl takes a win, blocks an immediate loss, then prefers a safe central column. */
    fun botColumn(board: List<Int>, player: Int = 2): Int? {
        val order = listOf(3, 2, 4, 1, 5, 0, 6).filter { drop(board, it, player) != null }
        order.firstOrNull { winner(drop(board, it, player)!!) == player }?.let { return it }
        val opponent = 3 - player
        order.firstOrNull { winner(drop(board, it, opponent)!!) == opponent }?.let { return it }
        return order.firstOrNull { c ->
            val next = drop(board, c, player)!!
            (0 until COLS).none { enemyCol -> drop(next, enemyCol, opponent)?.let { winner(it) == opponent } == true }
        } ?: order.firstOrNull()
    }
}
