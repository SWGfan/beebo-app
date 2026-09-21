package com.beeboentertainment.movie.campsite.campfire

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.campsite.games.HotPotatoEngine
import com.beeboentertainment.movie.campsite.games.HotPotatoGame
import kotlinx.coroutines.delay
import java.security.SecureRandom
import kotlin.random.asKotlinRandom

/**
 * Hot Potato on one phone, passed round the circle. Works with no campsite server, no
 * hotspot and no internet. The fuse is hidden: nobody, including the host, sees how
 * long is left.
 */
@Composable
fun HotPotatoScreen() {
    var night by rememberSaveable { mutableStateOf(false) }
    var textStep by rememberSaveable { mutableIntStateOf(1) }
    CampfireFrame(night, textStep) {
        HotPotatoContentPane(night, { night = it }, textStep, { textStep = it })
    }
}

@Composable
private fun HotPotatoContentPane(night: Boolean, onNight: (Boolean) -> Unit, textStep: Int, onTextStep: (Int) -> Unit) {
    val context = LocalContext.current
    var count by rememberSaveable { mutableIntStateOf(4) }
    val names = remember { mutableStateListOf<String>().apply { repeat(12) { add("") } } }
    var preset by rememberSaveable { mutableIntStateOf(1) }
    var sound by rememberSaveable { mutableStateOf(true) }

    var engine by remember { mutableStateOf<HotPotatoEngine?>(null) }
    // Bumped on every change to the engine so Compose redraws: the engine itself is plain Kotlin.
    var tick by remember { mutableIntStateOf(0) }
    var bang by remember { mutableStateOf(false) }
    var startedAt by remember { mutableStateOf(0L) }
    var saved by remember { mutableStateOf(false) }

    fun label(i: Int) = names[i].trim().ifBlank { "Player ${i + 1}" }

    val game = engine
    // The hidden fuse. Restarts whenever a new round begins; a pass does not reset it.
    LaunchedEffect(game, game?.round, bang) {
        val e = game ?: return@LaunchedEffect
        if (bang || e.over) return@LaunchedEffect
        delay(e.fuseMs)
        e.burn()
        bang = true
        tick++
        CampfireAlarm.ring(context, sound)
        if (e.over && !saved) {
            saved = true
            val scores = e.players.associateWith { e.scores()[it] ?: 0 }
            val best = scores.values.maxOrNull()
            val leaders = scores.filterValues { it == best }.keys
            CampfireHistory.record(
                HotPotatoGame.id, HotPotatoGame.title, scores,
                winner = leaders.singleOrNull(), startedAt = startedAt,
                outcome = if (leaders.size == 1) "scores" else "draw",
            )
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Hot Potato", style = MaterialTheme.typography.headlineMedium)
        CampfireDisplayBar(night, onNight, textStep, onTextStep)
        // Reading the counter subscribes this pane to engine changes.
        check(tick >= 0)

        if (game == null) {
            HowToPlayCard(
                steps = listOf(
                    "Sit in a circle with one phone.",
                    "A category appears. The person holding the phone says one answer out loud, then taps Pass and hands it on.",
                    "No repeats and no long pauses - the circle decides if an answer counts.",
                    "A hidden timer is ticking. When it goes off, whoever is holding the phone loses the round and gets a letter.",
                    "Letters spell P-O-T-A-T-O. The first person to spell the whole word is out, and the game ends.",
                ),
                note = "The timer is random every round, so nobody knows when it will go off. Hold the phone firmly - no throwing!",
            )
            Text("Players", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { count = (count - 1).coerceAtLeast(2) }, enabled = count > 2) { Text("−") }
                Text("$count players", style = MaterialTheme.typography.titleMedium)
                OutlinedButton(onClick = { count = (count + 1).coerceAtMost(12) }, enabled = count < 12) { Text("+") }
            }
            Text("Names are optional.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            repeat(count) { i ->
                OutlinedTextField(
                    value = names[i],
                    onValueChange = { names[i] = it.take(24) },
                    label = { Text("Player ${i + 1}") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Text("Host settings", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HotPotatoEngine.PRESETS.forEachIndexed { i, (name, min, max) ->
                    FilterChip(selected = preset == i, onClick = { preset = i }, label = { Text("$name ${min}–${max}s") })
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Switch(checked = sound, onCheckedChange = { sound = it })
                Text("Sound when it goes off (silent mode is always respected)")
            }
            Button(
                onClick = {
                    val (_, min, max) = HotPotatoEngine.PRESETS[preset]
                    // Two players typing the same name would share one set of letters, so repeats get a number.
                    val seen = mutableSetOf<String>()
                    val roster = (0 until count).map { i ->
                        var n = label(i); var k = 2
                        while (!seen.add(n.lowercase())) n = "${label(i)} (${k++})"
                        n
                    }
                    engine = HotPotatoEngine(roster, SecureRandom().asKotlinRandom(), min, max)
                    bang = false; saved = false; startedAt = System.currentTimeMillis(); tick++
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) { Text("Start") }
            return@Column
        }

        Text("Round ${game.round}", style = MaterialTheme.typography.titleMedium)
        Card(
            Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = if (bang) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer),
        ) {
            Column(Modifier.padding(24.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                if (!bang) {
                    Text("Say one of these out loud:", style = MaterialTheme.typography.bodyLarge)
                    Text(game.category, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                } else {
                    Text("💥 It went off!", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
                    val burned = game.lastBurned.orEmpty()
                    Text("$burned was holding it and now has ${game.spelled(burned)}.",
                        style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
                }
            }
        }

        if (!bang) {
            Text("Holding it: ${game.holder}", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Button(
                onClick = { game.pass(); tick++ },
                modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp),
            ) { Text("Said it — pass to ${game.players[(game.holderIndex + 1) % game.players.size]}", style = MaterialTheme.typography.titleLarge) }
        } else if (!game.over) {
            Button(onClick = { game.startRound(); bang = false; tick++ }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text("Next round (${game.holder} starts)")
            }
        } else {
            Text("${game.loser} spelled ${game.word}. Game over!", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text("Saved to match history.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Text("Letters", style = MaterialTheme.typography.titleMedium)
        game.players.forEach { p ->
            val spelled = game.spelled(p)
            Text("$p: ${if (spelled.isEmpty()) "–" else spelled.toList().joinToString("-")}", style = MaterialTheme.typography.bodyLarge)
        }

        OutlinedButton(onClick = { engine = null; bang = false; tick++ }, modifier = Modifier.fillMaxWidth()) {
            Text(if (game.over) "Play again" else "End game")
        }
    }
}
