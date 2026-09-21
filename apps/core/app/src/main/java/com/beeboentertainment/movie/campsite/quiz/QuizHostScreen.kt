package com.beeboentertainment.movie.campsite.quiz

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.campsite.CampsiteNarrator
import com.beeboentertainment.movie.campsite.family.ChoiceChips
import com.beeboentertainment.movie.campsite.family.FamilyGuestsCard
import com.beeboentertainment.movie.campsite.family.FamilyPackBHost
import com.beeboentertainment.movie.campsite.quiet.QuietGate
import kotlinx.coroutines.delay

private val TeamGlyph = listOf("▲", "●", "■", "★")
private val Letters = listOf("A", "B", "C", "D")
private val RightGreen = Color(0xFF123A29)

/**
 * Roadside Quiz, on the host's phone: set it up, run it, and show it on the big screen.
 *
 * Two ways to play. "Guests' phones" puts the question on every guest's browser and the host phone
 * shows it too; "This phone" needs no guests at all: teams take turns and the host taps the answer
 * they call out. Nothing needs a network, and the questions never leave the phone.
 */
@Composable
fun QuizHostScreen() {
    val service = remember { FamilyPackBHost.quiz }
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { while (true) { delay(250); tick++ } }
    val host = remember(tick) { service.hostState() }
    val context = LocalContext.current
    val narrator = remember { CampsiteNarrator(context) {} }
    DisposableEffect(narrator) { onDispose { narrator.release() } }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Roadside Quiz", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text(
            "Questions written for Beebo. Works with no signal. No timer unless you turn one on.",
            fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(12.dp))
        val snap = host.snapshot
        when {
            snap == null -> Setup(service)
            snap.phase == QuizPhase.LOBBY -> Lobby(service, snap)
            snap.phase == QuizPhase.DONE -> Finished(service, snap, host)
            else -> Playing(service, snap, narrator)
        }
        Spacer(Modifier.height(18.dp))
        Text(
            "Passengers only: this is for the back seat, never for the driver.",
            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun Setup(service: QuizService) {
    var bandIndex by rememberSaveable { mutableIntStateOf(1) }
    var packs by remember { mutableStateOf(setOf<String>()) }
    var rounds by rememberSaveable { mutableIntStateOf(10) }
    var turns by rememberSaveable { mutableStateOf(false) }
    var teams by rememberSaveable { mutableIntStateOf(0) }
    var timer by rememberSaveable { mutableIntStateOf(0) }
    var names by rememberSaveable { mutableStateOf("Team Red, Team Blue") }
    var error by remember { mutableStateOf<String?>(null) }

    val bands = listOf<AgeBand?>(AgeBand.KIDS, AgeBand.MIDDLE, AgeBand.OLDER, null)
    val band = bands[bandIndex.coerceIn(0, bands.lastIndex)]
    val ready = service.available(packs, band)

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("Who is playing?", fontWeight = FontWeight.SemiBold)
            ChoiceChips(bands, bandIndex, { it?.label?.replace("Ages ", "") ?: "All ages" }) { bandIndex = it }
            Spacer(Modifier.height(10.dp))
            Text("Packs (none picked means all)", fontWeight = FontWeight.SemiBold)
            QuizPacks.ALL.chunked(2).forEach { pair ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    pair.forEach { p ->
                        FilterChip(
                            selected = p.id in packs,
                            onClick = { packs = if (p.id in packs) packs - p.id else packs + p.id },
                            label = { Text(p.emoji + " " + p.title, fontSize = 13.sp) },
                        )
                    }
                }
            }
            Text("$ready questions ready for this choice.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(10.dp))
            Text("How many questions?", fontWeight = FontWeight.SemiBold)
            val counts = listOf(5, 10, 15)
            ChoiceChips(counts, counts.indexOf(rounds).coerceAtLeast(0), { "$it" }) { rounds = counts[it] }
            Spacer(Modifier.height(10.dp))
            Text("Play on", fontWeight = FontWeight.SemiBold)
            ChoiceChips(listOf("Guests' phones", "This phone, teams take turns"), if (turns) 1 else 0, { it }) { turns = it == 1 }
            Spacer(Modifier.height(10.dp))
            if (turns) {
                OutlinedTextField(
                    value = names, onValueChange = { names = it.take(80) }, singleLine = true,
                    label = { Text("Team names, separated by commas") }, modifier = Modifier.fillMaxWidth(),
                )
            } else {
                Text("Teams", fontWeight = FontWeight.SemiBold)
                val options = listOf(0, 2, 3, 4)
                ChoiceChips(options, options.indexOf(teams).coerceAtLeast(0), { if (it == 0) "Everyone alone" else "$it teams" }) { teams = options[it] }
            }
            Spacer(Modifier.height(10.dp))
            Text("Timer", fontWeight = FontWeight.SemiBold)
            val timers = listOf(0, 15, 30, 60)
            ChoiceChips(timers, timers.indexOf(timer).coerceAtLeast(0), { if (it == 0) "Off" else "$it s" }) { timer = timers[it] }
            Spacer(Modifier.height(14.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            Button(
                onClick = {
                    val settings = QuizSettings(
                        packs = packs, band = band, rounds = rounds, teams = teams, timerSeconds = timer,
                        mode = if (turns) QuizMode.TURNS else QuizMode.PHONES,
                        turnNames = names.split(',').map { it.trim() }.filter { it.isNotEmpty() },
                    )
                    error = service.open(settings)
                    // Playing on this phone needs nobody else, so go straight to the first question.
                    if (error == null && turns) error = service.start()
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (turns) "Start the quiz" else "Open the quiz for guests") }
        }
    }
}

@Composable
private fun Lobby(service: QuizService, snap: QuizSession.Snapshot) {
    var error by remember { mutableStateOf<String?>(null) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Waiting for players", fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
            Text("${snap.total} questions. Guests open the quiz page and join by themselves.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            if (snap.rows.isEmpty()) Text("Nobody has joined yet.", fontSize = 14.sp)
            snap.rows.forEach { r ->
                Text(r.name + if (r.team >= 0) "  " + TeamGlyph[r.team] + " " + QuizTeams.NAMES[r.team] else "", fontSize = 15.sp)
            }
            Spacer(Modifier.height(10.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { error = service.start() }, enabled = snap.rows.isNotEmpty()) { Text("Start") }
                OutlinedButton(onClick = { service.close() }) { Text("Cancel") }
            }
        }
    }
    Spacer(Modifier.height(12.dp))
    FamilyGuestsCard("/quiz", "the quiz")
}

@Composable
private fun Playing(service: QuizService, snap: QuizSession.Snapshot, narrator: CampsiteNarrator) {
    val revealed = snap.phase == QuizPhase.REVEALED
    val turns = snap.mode == QuizMode.TURNS
    var error by remember { mutableStateOf<String?>(null) }
    // Quiet hours (Family Pack A): the narrator is silent while they are on, so say so instead of a dead button.
    val quiet = QuietGate.isQuietNow()
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Question ${snap.number} of ${snap.total}  ·  ${snap.packTitle}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (snap.remainingMs >= 0) Text("${(snap.remainingMs + 999) / 1000} s left", fontWeight = FontWeight.Bold, fontSize = 16.sp)
            if (turns && snap.turnName != null) {
                Text("${snap.turnName}'s turn", fontWeight = FontWeight.SemiBold, fontSize = 16.sp, color = MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.height(8.dp))
            Text(snap.prompt, fontSize = 24.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
            Spacer(Modifier.height(12.dp))
            snap.options.forEachIndexed { i, text ->
                val isRight = revealed && i == snap.correct
                val shape = RoundedCornerShape(14.dp)
                val rowModifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).heightIn(min = 56.dp)
                    .background(if (isRight) RightGreen else Color.Transparent, shape)
                if (turns && !revealed) {
                    OutlinedButton(
                        onClick = { error = service.hostAnswer(i) },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).heightIn(min = 56.dp),
                    ) { Text("${Letters[i]}   $text", fontSize = 20.sp, modifier = Modifier.weight(1f)) }
                } else {
                    Row(rowModifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(Letters[i], fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
                        Spacer(Modifier.padding(6.dp))
                        Text(text, fontSize = 20.sp, modifier = Modifier.weight(1f))
                        if (isRight) Text("CORRECT", fontWeight = FontWeight.ExtraBold, fontSize = 12.sp)
                        if (revealed && snap.counts.getOrNull(i)?.let { it > 0 } == true) Text("  ${snap.counts[i]}", fontSize = 14.sp)
                    }
                }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            if (revealed && snap.fact.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text("Did you know? ${snap.fact}", fontSize = 16.sp, textAlign = TextAlign.Center)
            }
            if (!revealed) {
                Text(
                    if (turns) "Tap the answer the team calls out." else "${snap.answered} of ${snap.expected} answered",
                    fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!revealed) {
                    if (!turns) Button(onClick = { service.reveal() }) { Text("Show answer") }
                    OutlinedButton(enabled = !quiet, onClick = {
                        narrator.speak(snap.prompt + ". " + snap.options.mapIndexed { i, o -> "${Letters[i]}: $o" }.joinToString(". "))
                    }) { Text(if (quiet) "Quiet hours: no reading aloud" else "Read aloud") }
                } else {
                    Button(onClick = { service.next() }) { Text(if (snap.number >= snap.total) "Finish" else "Next question") }
                    OutlinedButton(enabled = !quiet, onClick = { narrator.speak(snap.fact) }) { Text(if (quiet) "Quiet hours: no reading aloud" else "Read fact aloud") }
                }
                OutlinedButton(onClick = { narrator.stopSpeaking(); service.end() }) { Text("Stop quiz") }
            }
        }
    }
    Spacer(Modifier.height(12.dp))
    Scoreboard(snap)
    if (!turns) {
        Spacer(Modifier.height(12.dp))
        FamilyGuestsCard("/quiz", "the quiz")
    }
}

@Composable
private fun Finished(service: QuizService, snap: QuizSession.Snapshot, host: QuizHostState) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("All done!", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            val win = host.winners
            Text(
                when {
                    win.isEmpty() -> "Great playing, everybody!"
                    win.size == 1 -> win[0] + " wins!"
                    else -> "A tie: " + win.joinToString(" and ") + "!"
                },
                fontSize = 20.sp, textAlign = TextAlign.Center,
            )
            if (host.aborted) Text("The quiz was stopped early. The points so far stand.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(10.dp))
            Button(onClick = { service.close() }) { Text("Play again") }
        }
    }
    Spacer(Modifier.height(12.dp))
    Scoreboard(snap)
}

@Composable
private fun Scoreboard(snap: QuizSession.Snapshot) {
    if (snap.rows.isEmpty()) return
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            if (snap.teams.isNotEmpty()) {
                Text("Teams", fontWeight = FontWeight.SemiBold)
                snap.teams.sortedByDescending { it.score }.forEach { t ->
                    Row(Modifier.fillMaxWidth()) {
                        Text(TeamGlyph[t.index] + " " + t.name + "  (" + t.members + ")", Modifier.weight(1f))
                        Text("${t.score}", fontWeight = FontWeight.Bold)
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
            Text(if (snap.teams.isNotEmpty()) "Players" else "Scores", fontWeight = FontWeight.SemiBold)
            snap.rows.sortedByDescending { it.score }.forEach { r ->
                Row(Modifier.fillMaxWidth()) {
                    Text(
                        r.name + (if (snap.phase == QuizPhase.REVEALED && r.right != null) if (r.right) "  ✓" else "  –" else ""),
                        Modifier.weight(1f),
                    )
                    Text("${r.score}", fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}
