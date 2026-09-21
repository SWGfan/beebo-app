package com.beeboentertainment.movie.campsite.campfire

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.campsite.games.BingoGrid
import com.beeboentertainment.movie.campsite.games.BingoPattern
import com.beeboentertainment.movie.campsite.games.ClassicBingoEngine
import com.beeboentertainment.movie.campsite.games.ClassicBingoGame
import com.beeboentertainment.movie.campsite.games.ClassicBingoRules
import kotlinx.coroutines.delay
import java.security.SecureRandom
import kotlin.random.asKotlinRandom

private const val ME = "You"
private val SPEEDS = listOf(Triple("Manual", 0L, "manual"), Triple("Slow", 8_000L, "slow"), Triple("Normal", 5_000L, "normal"), Triple("Fast", 3_000L, "fast"))

/**
 * Classic Bingo on this phone with computer players: the phone is the caller, reads
 * each ball aloud with the built-in voice, and checks every Bingo against the balls
 * actually called. No server, hotspot or internet.
 */
@Composable
fun ClassicBingoScreen() {
    var night by rememberSaveable { mutableStateOf(false) }
    var textStep by rememberSaveable { mutableIntStateOf(1) }
    CampfireFrame(night, textStep) { ClassicBingoPane(night, { night = it }, textStep, { textStep = it }) }
}

@Composable
private fun ClassicBingoPane(night: Boolean, onNight: (Boolean) -> Unit, textStep: Int, onTextStep: (Int) -> Unit) {
    val voice = rememberCampfireVoice()
    var bots by rememberSaveable { mutableIntStateOf(2) }
    var cardsEach by rememberSaveable { mutableIntStateOf(1) }
    var pattern by rememberSaveable { mutableStateOf(BingoPattern.LINE.wire) }
    var penalty by rememberSaveable { mutableIntStateOf(3) }
    var speed by rememberSaveable { mutableIntStateOf(2) }
    var autoDaub by rememberSaveable { mutableStateOf(false) }
    var speak by rememberSaveable { mutableStateOf(true) }

    var engine by remember { mutableStateOf<ClassicBingoEngine?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    var paused by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var startedAt by remember { mutableStateOf(0L) }
    var saved by remember { mutableStateOf(false) }

    val game = engine
    val botIds = game?.players?.filter { it != ME }.orEmpty()

    fun save(e: ClassicBingoEngine) {
        if (saved) return
        saved = true
        val scores = e.players.associateWith { if (it in e.winners) 1 else 0 }
        CampfireHistory.record(
            ClassicBingoGame.id, ClassicBingoGame.title, scores,
            winner = e.winners.singleOrNull(), startedAt = startedAt,
            // Everyone else at this table is a computer, so it never reaches the standings.
            rated = false,
            outcome = when (e.winners.size) { 0 -> "draw"; 1 -> "winner"; else -> "scores" },
        )
    }

    fun draw() {
        val e = engine ?: return
        if (e.over) return
        val ball = e.callNext()
        tick++
        if (ball != null) {
            message = ""
            if (speak) voice.speak(ClassicBingoRules.label(ball).replace(" ", ", "), 0.9f)
        }
        if (e.over) save(e)
    }

    // Auto-caller. Restarts on each ball, pause or speed change.
    LaunchedEffect(game, tick, paused, speed) {
        val e = game ?: return@LaunchedEffect
        val wait = SPEEDS[speed].second
        if (wait == 0L || paused || e.over || e.winners.isNotEmpty()) return@LaunchedEffect
        delay(wait)
        draw()
    }
    // Computer players take a moment to spot their Bingo, so a quick human can tie or beat them.
    LaunchedEffect(game, game?.called?.size) {
        val e = game ?: return@LaunchedEffect
        if (e.over || e.called.isEmpty()) return@LaunchedEffect
        delay(1_800)
        val claimed = e.botTurn(botIds)
        if (claimed.isNotEmpty()) {
            message = claimed.joinToString(" and ") + " called Bingo!"
            if (speak) voice.speak("Bingo! " + claimed.joinToString(" and "), 1f)
            tick++
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Classic Bingo", style = MaterialTheme.typography.headlineMedium)
        CampfireDisplayBar(night, onNight, textStep, onTextStep)
        check(tick >= 0)

        if (game == null) {
            HowToPlayCard(
                steps = listOf(
                    "Each card has 25 squares: B 1–15, I 16–30, N 31–45, G 46–60 and O 61–75, with a free square in the middle.",
                    "The caller draws balls one at a time and reads them out. Every number comes up once.",
                    "When a called number is on your card, tap it to daub it (or turn on auto-daub).",
                    "Complete the pattern for this game, then tap BINGO! quickly.",
                    "Bingo is checked against the numbers actually called - a daub on a number that hasn't been called doesn't count.",
                    "Call Bingo too soon and you sit out the next few calls.",
                    "The first valid Bingo wins. Two Bingos on the same ball are both winners.",
                ),
            )
            Text("Computer players: $bots", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                (1..5).forEach { n -> FilterChip(selected = bots == n, onClick = { bots = n }, label = { Text("$n") }) }
            }
            Text("Cards each: $cardsEach", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                (1..4).forEach { n -> FilterChip(selected = cardsEach == n, onClick = { cardsEach = n }, label = { Text("$n") }) }
            }
            Text("Win pattern", style = MaterialTheme.typography.titleMedium)
            BingoPattern.entries.chunked(3).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    row.forEach { p -> FilterChip(selected = pattern == p.wire, onClick = { pattern = p.wire }, label = { Text(p.label) }) }
                }
            }
            Text("False Bingo penalty", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf(0 to "Off", 3 to "Skip 3 calls", 5 to "Skip 5 calls").forEach { (n, t) ->
                    FilterChip(selected = penalty == n, onClick = { penalty = n }, label = { Text(t) })
                }
            }
            SettingsRow(speed, { speed = it }, autoDaub, { autoDaub = it }, speak, { speak = it })
            Button(onClick = {
                engine = ClassicBingoEngine(
                    listOf(ME) + (1..bots).map { "Computer $it" }, SecureRandom().asKotlinRandom(),
                    cardsEach, BingoPattern.of(pattern), penalty,
                )
                paused = false; message = ""; saved = false; startedAt = System.currentTimeMillis(); tick++
            }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text("Start game") }
            return@Column
        }

        Text("Playing for: ${game.pattern.label} - ${game.pattern.describe}", style = MaterialTheme.typography.bodyLarge)
        val current = game.current
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Box(
                Modifier.size(112.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary)
                    .semantics { liveRegion = LiveRegionMode.Polite; contentDescription = current?.let { "Ball ${ClassicBingoRules.label(it)}" } ?: "No ball yet" },
                contentAlignment = Alignment.Center,
            ) {
                Text(current?.let { ClassicBingoRules.label(it) } ?: "–", style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
            }
            Column {
                Text("${game.called.size} of 75 called", style = MaterialTheme.typography.titleMedium)
                if (message.isNotEmpty()) Text(message, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            }
        }

        if (!game.over) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { draw() }) { Text(if (game.winners.isNotEmpty()) "End game" else "Next ball") }
                if (SPEEDS[speed].second > 0) OutlinedButton(onClick = { paused = !paused }) { Text(if (paused) "Resume" else "Pause") }
                OutlinedButton(onClick = { current?.let { voice.speak(ClassicBingoRules.label(it).replace(" ", ", "), 0.9f) } }) { Text("Repeat") }
            }
            val wait = game.penaltyLeft(ME)
            Button(
                onClick = {
                    message = when (val c = game.claim(ME)) {
                        ClassicBingoEngine.Claim.Win -> "BINGO! You win on ${current?.let { ClassicBingoRules.label(it) }}."
                        is ClassicBingoEngine.Claim.Penalty -> "Not yet - that's not a ${game.pattern.label}." + if (c.calls > 0) " You sit out ${c.calls} calls." else ""
                        is ClassicBingoEngine.Claim.Blocked -> "Wait ${c.callsLeft} more calls."
                        ClassicBingoEngine.Claim.Closed -> "Too late for this one."
                    }
                    tick++
                },
                enabled = wait == 0 && ME !in game.winners && game.called.isNotEmpty(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp),
            ) { Text(if (wait > 0) "BINGO! (wait $wait calls)" else "BINGO!", style = MaterialTheme.typography.headlineSmall) }
        } else {
            val w = game.winners
            Text(
                when {
                    w.isEmpty() -> "No Bingo this game."
                    w.size == 1 -> "${w.first()} won!"
                    else -> "A tie: ${w.joinToString(" and ")} won on the same ball!"
                },
                style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold,
            )
            Text("Saved to match history.", style = MaterialTheme.typography.bodyMedium)
        }

        val called = game.calledSet
        game.cards[ME].orEmpty().forEachIndexed { index, card ->
            Text("Your card ${index + 1}", style = MaterialTheme.typography.titleMedium)
            BingoCard(card, called, game.marksOf(ME, index), autoDaub) {
                if (!game.over) { game.mark(ME, index, it); tick++ }
            }
        }

        Text("Called numbers", style = MaterialTheme.typography.titleMedium)
        CalledBoard(called, current)

        Text("Computer players", style = MaterialTheme.typography.titleMedium)
        botIds.forEach { b -> Text("$b${if (b in game.winners) " - Bingo!" else ""}", style = MaterialTheme.typography.bodyLarge) }

        SettingsRow(speed, { speed = it }, autoDaub, { autoDaub = it }, speak, { speak = it })
        OutlinedButton(onClick = { voice.stop(); engine = null; tick++ }, modifier = Modifier.fillMaxWidth()) {
            Text(if (game.over) "New game" else "Quit game")
        }
    }
}

@Composable
private fun SettingsRow(speed: Int, onSpeed: (Int) -> Unit, autoDaub: Boolean, onAuto: (Boolean) -> Unit, speak: Boolean, onSpeak: (Boolean) -> Unit) {
    Text("Calling speed", style = MaterialTheme.typography.titleMedium)
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        SPEEDS.forEachIndexed { i, s -> FilterChip(selected = speed == i, onClick = { onSpeed(i) }, label = { Text(s.first) }) }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Switch(checked = autoDaub, onCheckedChange = onAuto); Text("Auto-daub my cards")
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Switch(checked = speak, onCheckedChange = onSpeak); Text("Read balls aloud")
    }
}

@Composable
private fun BingoCard(card: List<Int>, called: Set<Int>, marks: Set<Int>, autoDaub: Boolean, onTap: (Int) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            ClassicBingoRules.LETTERS.forEach {
                Text(it, Modifier.weight(1f), textAlign = TextAlign.Center, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            }
        }
        for (r in 0 until BingoGrid.SIZE) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                for (c in 0 until BingoGrid.SIZE) {
                    val i = r * BingoGrid.SIZE + c
                    val n = card[i]
                    val free = i == BingoGrid.FREE
                    val daubed = free || i in marks || (autoDaub && n in called)
                    val shape = RoundedCornerShape(6.dp)
                    Box(
                        Modifier.weight(1f).aspectRatio(1f).clip(shape)
                            .background(if (daubed) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant)
                            .border(1.dp, MaterialTheme.colorScheme.outline, shape)
                            .clickable(enabled = !free) { onTap(i) }
                            .semantics { contentDescription = if (free) "Free square" else "${ClassicBingoRules.label(n)}${if (daubed) ", daubed" else ""}" },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(if (free) "★" else "$n", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
                            color = if (daubed) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/** The 75-ball board: one row per letter, lit numbers have been called. */
@Composable
private fun CalledBoard(called: Set<Int>, current: Int?) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors()) {
        Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            ClassicBingoRules.LETTERS.forEachIndexed { col, letter ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(letter, Modifier.weight(1f), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium)
                    (col * 15 + 1..col * 15 + 15).forEach { n ->
                        val on = n in called
                        Box(
                            Modifier.weight(1f).aspectRatio(1f).clip(CircleShape)
                                .background(if (n == current) MaterialTheme.colorScheme.tertiary else if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("$n", style = MaterialTheme.typography.labelSmall,
                                color = if (on) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}
