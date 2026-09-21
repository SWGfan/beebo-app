package com.beeboentertainment.movie.party.games

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * Four in a Row - drop a counter, get four across, down or diagonally.
 *
 * The name a player sees is "Four in a Row": "Connect Four" is a Hasbro trademark and
 * the underlying game is not. The function and file keep the old name so every call
 * site, saved state key and the shared ConnectFourRules stay put - renaming those buys
 * nothing a player can see.
 */
@Composable
fun ConnectFourGame() {
    var board by rememberSaveable { mutableStateOf(List(42) { 0 }) }
    var turn by rememberSaveable { mutableStateOf(1) }
    var bot by rememberSaveable { mutableStateOf(true) }
    val winner = ConnectFourRules.winner(board)
    val over = winner != 0 || board.none { it == 0 }
    fun reset() { board = List(42) { 0 }; turn = 1 }
    fun play(column: Int) {
        if (over) return
        val next = ConnectFourRules.drop(board, column, turn) ?: return
        board = next; turn = 3 - turn
    }
    LaunchedEffect(board, turn, bot) {
        if (bot && turn == 2 && !over) {
            delay(350)
            ConnectFourRules.botColumn(board)?.let { play(it) }
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Four in a Row", style = MaterialTheme.typography.headlineMedium)
        Text("Drop a counter. Get four in a row across, down or diagonally.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = bot, onClick = { bot = true; reset() }, label = { Text("Play Carl") })
            FilterChip(selected = !bot, onClick = { bot = false; reset() }, label = { Text("Pass the phone") })
        }
        Text(when {
            winner != 0 -> if (bot && winner == 2) "Carl wins!" else "Player $winner wins!"
            over -> "It's a draw!"
            bot && turn == 2 -> "Carl is thinking…"
            bot -> "Your turn · Purple"
            else -> "Player $turn · ${if (turn == 1) "Purple" else "Gold"}"
        }, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        val winning = ConnectFourRules.winningCells(board)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            repeat(7) { col ->
                Column(Modifier.weight(1f).clip(MaterialTheme.shapes.small)
                    .background(Color(0xFF10365D))
                    .semantics { contentDescription = "Drop counter in column ${col + 1}" }
                    .clickable(enabled = !over && !(bot && turn == 2) && board[col] == 0) { play(col) }
                    .padding(3.dp), verticalArrangement = Arrangement.spacedBy(4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("↓", color = Color.White)
                    repeat(6) { row ->
                        val i = row * 7 + col
                        Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(CircleShape)
                            .background(when(board[i]) { 1 -> Color(0xFFB99AFA); 2 -> Color(0xFFF0CA54); else -> Color(0xFF080E1A) }),
                            contentAlignment = Alignment.Center) {
                            if (board[i] != 0) Text(if (i in winning) "★" else board[i].toString(), color = Color(0xFF111421))
                        }
                    }
                }
            }
        }
        Button(onClick = { reset() }) { Text(if (over) "Play again" else "Restart") }
        Text("To play on separate phones, open Guest games while Campsite Mode is running.", style = MaterialTheme.typography.bodyMedium)
    }
}
