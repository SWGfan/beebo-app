package com.beeboentertainment.auto.games

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.beeboentertainment.auto.data.Prefs
import com.beeboentertainment.auto.party.RoomClient

/**
 * The passenger "games" suite — a single self-contained composable.
 *
 * Drop it into the phone UI with one call:
 *
 * ```
 * com.beeboentertainment.auto.games.GamesScreen(prefs = prefs)
 * ```
 *
 * It builds and owns its own [GamesController] (via [rememberGamesController]),
 * connects to the hub room when there is a session, and works fully offline
 * against Cruisin' Carl when there is not. It does not touch the nav graph, the
 * PlaybackService, or MainActivity — like [com.beeboentertainment.auto.party.PartyScreen]
 * it slots wherever the host drops it.
 */
@Composable
fun GamesScreen(
    prefs: Prefs,
    modifier: Modifier = Modifier,
    controller: GamesController = rememberGamesController(prefs),
) {
    LaunchedEffect(controller) { controller.connect() }
    val state by controller.ui.collectAsState()

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        when (state.phase) {
            GamePhase.MENU -> GamesMenu(onPick = controller::openGame)
            GamePhase.LOBBY -> RoadsideLobby(state, controller)
            GamePhase.PLAYING -> RoadsidePlay(state, controller)
        }
    }
}

/**
 * Builds and remembers a [GamesController]. When there is a hub session the
 * controller is wired to a [RoomGameTransport] over a fresh [RoomClient] (the
 * same transport the watch party uses); without one it is solo-only and never
 * touches the network. Torn down when it leaves composition.
 */
@Composable
fun rememberGamesController(prefs: Prefs): GamesController {
    val hubToken = prefs.hubToken
    val controller = remember(hubToken) {
        val transport = if (hubToken.isNullOrBlank()) null
        else RoomGameTransport(RoomClient(hubToken))
        GamesController(prefs, transport)
    }
    DisposableEffect(controller) { onDispose { controller.dispose() } }
    return controller
}

// --------------------------------------------------------------------- menu

@Composable
private fun GamesMenu(onPick: () -> Unit) {
    Text("Passenger games", style = MaterialTheme.typography.titleLarge)
    Text(
        "Original games for the car — play against a friend on their own phone " +
            "through the hub, or against the house bot when you're riding solo.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onPick),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Roadside Rumble", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
            Text(
                "Turn-based grid grab. Claim tiles for points; every claim locks " +
                    "the tiles around it for a turn. Most tiles after 15 turns wins.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text("2 players · vs bot or vs passengers", style = MaterialTheme.typography.labelMedium)
        }
    }
    Text(
        "More games coming to the suite.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

// -------------------------------------------------------------------- lobby

@Composable
private fun RoadsideLobby(state: GamesUiState, controller: GamesController) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Roadside Rumble", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
        TextButton(onClick = controller::backToMenu) { Text("Back") }
    }

    OutlinedTextField(
        value = state.youName,
        onValueChange = controller::setPlayerName,
        label = { Text("Your name") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )

    Text("Bot difficulty", style = MaterialTheme.typography.labelLarge)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        BotDifficulty.entries.forEach { d ->
            FilterChip(
                selected = state.difficulty == d,
                onClick = { controller.setDifficulty(d) },
                label = { Text(d.name.lowercase().replaceFirstChar { it.uppercase() }) },
            )
        }
    }

    // Roster from the hub room, when connected.
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (!state.connected) {
                Text("Riding solo", fontWeight = FontWeight.Bold)
                Text(
                    "No hub session, so it's just you and the bot. Sign in to the " +
                        "hub to play passengers in the same car.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text("In the car (${state.lobby.size})", fontWeight = FontWeight.Bold)
                if (state.lobby.isEmpty()) {
                    Text("Waiting for the room…", style = MaterialTheme.typography.bodySmall)
                }
                state.lobby.forEach { m ->
                    val you = if (m.id == state.youId) " (you)" else ""
                    Text(m.name + you, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }

    Button(
        onClick = controller::startSolo,
        modifier = Modifier.fillMaxWidth(),
    ) { Text("Bouncing in with Beebo!") }

    if (controller.canPlayMultiplayer()) {
        OutlinedButton(
            onClick = controller::startMultiplayer,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Start with passengers (${state.lobby.size})") }
    }
}

// --------------------------------------------------------------------- play

@Composable
private fun RoadsidePlay(state: GamesUiState, controller: GamesController) {
    val board = state.board ?: return

    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Roadside Rumble", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
        Text(
            "Turn ${board.turnsPlayed.coerceAtMost(board.totalTurns)}/${board.totalTurns}",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    // Status line: result, or whose turn.
    val status = when {
        board.result != null && board.result.tie -> "It's a tie!"
        board.result != null && board.result.youWon -> "You win!"
        board.result != null -> "${board.result.winnerName} wins!"
        board.yourTurn -> "Your turn — tap a tile"
        else -> "${board.currentSeatName}'s turn…"
    }
    Text(status, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)

    // Scoreboard.
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        board.scores.forEach { s ->
            Card(
                Modifier.weight(1f),
                colors = CardDefaults.cardColors(containerColor = seatColor(s.colorIndex).copy(alpha = 0.18f)),
            ) {
                Column(Modifier.padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(12.dp).clip(RoundedCornerShape(3.dp)).background(seatColor(s.colorIndex)),
                        )
                        Text(
                            "  " + s.name + if (s.isYou) " (you)" else "",
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = if (s.isYou) FontWeight.Bold else FontWeight.Normal,
                        )
                    }
                    Text("${s.count}", style = MaterialTheme.typography.headlineSmall)
                }
            }
        }
    }

    // The 5x5 board.
    BoardGrid(board = board, onTap = controller::claimTile)

    if (board.result != null) {
        Button(onClick = controller::rematch, modifier = Modifier.fillMaxWidth()) { Text("Rematch") }
    }
    OutlinedButton(onClick = controller::backToMenu, modifier = Modifier.fillMaxWidth()) {
        Text(if (board.result != null) "Back to games" else "Quit game")
    }
}

@Composable
private fun BoardGrid(board: BoardUi, onTap: (Int, Int) -> Unit) {
    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        for (r in 0 until board.size) {
            Row(Modifier.fillMaxWidth()) {
                for (c in 0 until board.size) {
                    val tile = board.tiles[r * board.size + c]
                    Tile(tile = tile, yourTurn = board.yourTurn, modifier = Modifier.weight(1f), onTap = onTap)
                }
            }
        }
    }
}

@Composable
private fun Tile(
    tile: TileUi,
    yourTurn: Boolean,
    modifier: Modifier,
    onTap: (Int, Int) -> Unit,
) {
    val claimedColor = tile.ownerColorIndex?.let { seatColor(it) }
    val tappable = yourTurn && tile.claimable
    val bg = when {
        claimedColor != null -> claimedColor
        tile.locked -> MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.5f)
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    Box(
        modifier = modifier
            .aspectRatio(1f)
            .padding(3.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(bg)
            .then(
                if (tappable) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(8.dp))
                else Modifier
            )
            .clickable(enabled = tappable) { onTap(tile.row, tile.col) },
        contentAlignment = Alignment.Center,
    ) {
        when {
            claimedColor != null -> Text(
                "●",
                color = Color.White,
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
            )
            tile.locked -> Text(
                "✕",
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodySmall,
            )
            else -> Unit
        }
    }
}

/** The four seat colours, indexed by seat order. */
private val SeatColors = listOf(
    Color(0xFF4F86F7), // blue
    Color(0xFFF7674F), // coral
    Color(0xFF49C17B), // green
    Color(0xFFC77DFF), // violet
)

private fun seatColor(index: Int): Color = SeatColors[index % SeatColors.size]
