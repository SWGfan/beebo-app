package com.beeboentertainment.movie.campsite.solo

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog

/** One solo puzzle, full screen, with a way back to the Games list. Runs entirely on this phone. */
@Composable
internal fun SoloGameScreen(gameId: String, onBack: () -> Unit) {
    val game = CampsiteGameCatalog.solo(gameId)
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("← Games") }
            Spacer(Modifier.width(12.dp))
            Text(game?.title.orEmpty(), fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }
        com.beeboentertainment.movie.campsite.SoloArtworkBanner(gameId)
        Box(Modifier.fillMaxSize()) {
            when (gameId) {
                FIVE_LETTERS_GAME.id -> FiveLettersScreen()
                SUDOKU_GAME.id -> SudokuScreen()
                MINESWEEPER_GAME.id -> MinesweeperScreen()
                SOLITAIRE_GAME.id -> SolitaireScreen()
                else -> Text("That game isn't available.", Modifier.padding(16.dp))
            }
        }
    }
}
