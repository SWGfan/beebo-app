package com.beeboentertainment.movie.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import com.beeboentertainment.movie.campsite.CampsiteHost
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape
import kotlin.random.Random

/**
 * Passenger games — self-contained, offline, no account needed. A simple menu that opens
 * one game at a time. Everything here runs locally on the device; nothing touches the
 * network, so a kid can play with no signal in the car.
 *
 * These are single-device games for now (pass-and-play / vs the built-in bot). The shared
 * "car party" versions — where each passenger plays on their own tablet in sync — are
 * designed in CAR-PARTY-DESIGN.md and build on the existing party/RoomClient plumbing.
 */
@Composable
fun GamesScreen(onOpenPartyGame: (String) -> Unit = {}) {
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    BackHandler(enabled = open != null) { open = null }

    when (open) {
        "connect4" -> GameFrame("4-in-a-row", onBack = { open = null }) { com.beeboentertainment.movie.party.games.ConnectFourGame() }
        "ttt" -> GameFrame("Tic-Tac-Toe", onBack = { open = null }) { TicTacToeGame() }
        "ispy" -> GameFrame("I Spy", onBack = { open = null }) { ISpyGame() }
        else -> GamesMenu(onOpen = { open = it }, onOpenPartyGame = onOpenPartyGame)
    }
}

/** One row of the "Play together" menu. [route] is what the app navigates to. */
private data class PartyGame(
    val route: String,
    val emoji: String,
    val title: String,
    val subtitle: String,
)

/** The room-synced games, in the order they are shown. */
private val PARTY_GAMES = listOf(
    PartyGame("picknext", "\ud83c\udfa1", "Pick the Next One", "Everyone suggests; the wheel decides."),
    PartyGame("thisorthat", "\u2694\ufe0f", "This or That", "Everyone votes; the room sees the tally."),
    PartyGame("trivia", "\ud83c\udfac", "Movie Trivia", "Questions built from your own library."),
    PartyGame("wouldyourather", "\ud83e\udd14", "Would You Rather", "Pick a side and argue about it."),
    PartyGame("twentyquestions", "\u2753", "20 Questions", "One person thinks of it, everyone else digs."),
    PartyGame("bingo", "\ud83d\ude97", "Car Bingo", "Spot things out the window, race to a line."),
    PartyGame("storybuilder", "\ud83d\udcd6", "Story Builder", "One line each, and it gets ridiculous."),
    PartyGame("categorychains", "\ud83d\udd17", "Category Chains", "Keep the chain going without repeating."),
    PartyGame("quiet", "\ud83e\udd2b", "The Quiet Game", "Last one to make a sound wins."),
)

@Composable
private fun GamesMenu(onOpen: (String) -> Unit, onOpenPartyGame: (String) -> Unit = {}) {
    val campsite by CampsiteHost.state.collectAsState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        // Opens straight away with nothing running: no hotspot, no guest server. Inviting
        // other phones is a separate, explicit step inside. On a TV the list leaves out what a
        // remote can't play (TvFeatures.gameListed).
        GameCard("🎮", "Campsite games", if (campsite.running)
            "Open the same games as your guests. Everyone plays on their own phone."
            else "Cards, board games and more against the computer. Invite other phones when you want to.") { onOpenPartyGame("guest-games") }
        Text(
            "On this phone",
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(bottom = 4.dp)
        )
        Text(
            "Pass the phone around. These games work without internet or an account.",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 8.dp)
        )
        GameCard("🟣🟡", "4-in-a-row", "Play Carl or pass the phone. Get four in a line to win.") { onOpen("connect4") }
        GameCard("⭕❌", "Tic-Tac-Toe", "Two players, or beat Carl.") { onOpen("ttt") }
        GameCard("👀", "I Spy", "Race to spot what the app calls out.") { onOpen("ispy") }

        if (!campsite.running) {
        Text(
            "Play together online",
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = 20.dp, bottom = 4.dp)
        )
        Text(
            "For separate phones, each player needs the Beebo app, internet and hub sign-in in Settings. Joining the campsite video QR does not join a game.",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 8.dp)
        )
        PARTY_GAMES.forEach { g ->
            GameCard(g.emoji, g.title, g.subtitle) { onOpenPartyGame(g.route) }
        }
        }
    }
}

@Composable
private fun GameCard(emoji: String, title: String, subtitle: String, onClick: () -> Unit) {
    Card(
        Modifier
            .fillMaxWidth()
            .clickable { onClick() }
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(18.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(emoji, fontSize = 30.sp)
            Spacer(Modifier.width(16.dp))
            Column {
                Text(title, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Text(subtitle, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun GameFrame(title: String, onBack: () -> Unit, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedButton(onClick = onBack) { Text("← Games") }
            Spacer(Modifier.width(12.dp))
            Text(title, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }
        Box(Modifier.fillMaxSize()) { content() }
    }
}

/* ------------------------------------------------------------------ Tic-Tac-Toe */

@Composable
private fun TicTacToeGame() {
    // null = empty, "X" = human/player 1, "O" = bot/player 2
    var board by remember { mutableStateOf(List<String?>(9) { null }) }
    var xTurn by remember { mutableStateOf(true) }
    var vsBot by remember { mutableStateOf(true) }
    var scoreX by remember { mutableStateOf(0) }
    var scoreO by remember { mutableStateOf(0) }

    val winner = winnerOf(board)
    val full = board.none { it == null }
    val over = winner != null || full

    fun reset() {
        board = List(9) { null }
        xTurn = true
    }

    fun applyMove(i: Int, mark: String) {
        board = board.toMutableList().also { it[i] = mark }
    }

    fun place(i: Int) {
        if (board[i] != null || over) return
        val mark = if (xTurn) "X" else "O"
        applyMove(i, mark)
        val w = winnerOf(board)
        if (w == "X") scoreX++
        if (w == "O") scoreO++
        if (w == null && board.any { it == null }) {
            xTurn = !xTurn
            // Bot plays O right after the human's X.
            if (vsBot && !xTurn) {
                val move = botMove(board, me = "O", you = "X")
                if (move >= 0) {
                    applyMove(move, "O")
                    val w2 = winnerOf(board)
                    if (w2 == "O") scoreO++
                    xTurn = true
                }
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = vsBot, onClick = { vsBot = true; reset() }, label = { Text("vs Carl") })
            FilterChip(selected = !vsBot, onClick = { vsBot = false; reset() }, label = { Text("2 Players") })
        }
        Spacer(Modifier.height(10.dp))
        val status = when {
            winner != null -> "$winner wins! 🎉"
            full -> "It's a draw."
            vsBot && xTurn -> "Your turn (X)"
            vsBot -> "Carl thinking…"
            else -> "${if (xTurn) "X" else "O"}'s turn"
        }
        Text(status, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Text(
            if (vsBot) "You $scoreX  ·  Carl $scoreO" else "X $scoreX  ·  O $scoreO",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(16.dp))

        // 3x3 grid
        Column(
            Modifier
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            for (r in 0 until 3) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    for (c in 0 until 3) {
                        val i = r * 3 + c
                        Box(
                            Modifier
                                .weight(1f)
                                .aspectRatio(1f)
                                .clip(RoundedCornerShape(12.dp))
                                .border(2.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(12.dp))
                                .clickable(enabled = board[i] == null && !over) { place(i) },
                            contentAlignment = Alignment.Center
                        ) {
                            val v = board[i]
                            if (v != null) {
                                Text(
                                    v,
                                    fontSize = 44.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = if (v == "X") MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.tertiary
                                )
                            }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(20.dp))
        Button(onClick = { reset() }) { Text(if (over) "Play again" else "Restart") }
    }
}

/** The three-in-a-row lines. */
private val LINES = listOf(
    listOf(0, 1, 2), listOf(3, 4, 5), listOf(6, 7, 8),
    listOf(0, 3, 6), listOf(1, 4, 7), listOf(2, 5, 8),
    listOf(0, 4, 8), listOf(2, 4, 6)
)

private fun winnerOf(b: List<String?>): String? {
    for (line in LINES) {
        val (a, c, d) = Triple(b[line[0]], b[line[1]], b[line[2]])
        if (a != null && a == c && a == d) return a
    }
    return null
}

/**
 * Kid-friendly bot: take a winning move, else block the human's win, else centre, else a
 * random corner, else any free cell. Beatable enough to stay fun, sharp enough to feel real.
 */
private fun botMove(b: List<String?>, me: String, you: String): Int {
    fun tryWin(mark: String): Int {
        for (line in LINES) {
            val cells = line.map { b[it] }
            if (cells.count { it == mark } == 2 && cells.count { it == null } == 1) {
                return line[cells.indexOfFirst { it == null }]
            }
        }
        return -1
    }
    tryWin(me).let { if (it >= 0) return it }        // win now
    tryWin(you).let { if (it >= 0) return it }        // block
    if (b[4] == null) return 4                        // centre
    val corners = listOf(0, 2, 6, 8).filter { b[it] == null }
    if (corners.isNotEmpty()) return corners[Random.nextInt(corners.size)]
    val free = (0 until 9).filter { b[it] == null }
    return if (free.isEmpty()) -1 else free[Random.nextInt(free.size)]
}

/* ------------------------------------------------------------------ I Spy */

private val ISPY_PROMPTS = listOf(
    "something RED", "something BLUE", "something GREEN", "something YELLOW",
    "something WHITE", "something BLACK", "something ORANGE",
    "another car", "a big truck", "a road sign", "a tree",
    "something round", "something with wheels", "a building",
    "a bird", "a cloud", "something shiny", "the colour of the sky",
    "something taller than a house", "a bridge", "something moving fast",
    "a number on a sign", "something you could eat", "a flag"
)

@Composable
private fun ISpyGame() {
    var prompt by remember { mutableStateOf(ISPY_PROMPTS[Random.nextInt(ISPY_PROMPTS.size)]) }
    var found by remember { mutableStateOf(0) }

    fun next() {
        var p = ISPY_PROMPTS[Random.nextInt(ISPY_PROMPTS.size)]
        // avoid repeating the same prompt twice in a row
        if (p == prompt && ISPY_PROMPTS.size > 1) p = ISPY_PROMPTS[Random.nextInt(ISPY_PROMPTS.size)]
        prompt = p
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text("👀 I spy with my little eye…", fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(18.dp))
        Card(Modifier.fillMaxWidth()) {
            Text(
                prompt,
                fontSize = 34.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 34.dp, horizontal = 16.dp)
            )
        }
        Spacer(Modifier.height(10.dp))
        Text("Found: $found", fontSize = 15.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(24.dp))
        Button(
            onClick = { found++; next() },
            modifier = Modifier.fillMaxWidth().height(56.dp)
        ) { Text("Found it! ✓", fontSize = 18.sp) }
        Spacer(Modifier.height(10.dp))
        OutlinedButton(
            onClick = { next() },
            modifier = Modifier.fillMaxWidth()
        ) { Text("Skip — spy something else") }
    }
}
