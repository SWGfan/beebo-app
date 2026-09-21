package com.beeboentertainment.movie.campsite.hunt

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.campsite.family.ChoiceChips
import com.beeboentertainment.movie.campsite.family.FamilyGuestsCard
import kotlinx.coroutines.delay

/**
 * Scavenger Hunt for Everyone, on the host's phone: pick a card, choose solo, together or teams, set
 * an optional timer and approval, open it, and watch the leaderboard while guests play in their own
 * browsers over the Campsite Wi-Fi.
 *
 * Everything here works with no internet. The host screen makes no sound and reads no location,
 * microphone or camera. The guests' photos, if the host allows them, never reach this phone.
 */
@Composable
fun HuntHostScreen() {
    val service = remember { HuntHost.hunt }
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { while (true) { delay(500); tick++ } }
    val host = remember(tick) { service.hostState() }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Scavenger Hunt for Everyone", fontSize = 24.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        Text(
            "Guests join in their phone's browser: no app, no account. Works on the Campsite Wi-Fi with no internet.",
            fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(12.dp))
        SafetyCard()
        Spacer(Modifier.height(12.dp))
        when (host.phase) {
            null -> Setup(service)
            HuntPhase.LOBBY -> Lobby(service, host)
            HuntPhase.RUNNING -> Running(service, host)
            HuntPhase.DONE -> Finished(service, host)
        }
    }
}

@Composable
private fun SafetyCard() {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("For the grown-ups", fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            HuntSafety.CORE.forEach { Text("• $it", fontSize = 14.sp) }
            Spacer(Modifier.height(4.dp))
            Text(HuntSafety.CAMPGROUND, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun SwitchRow(label: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, fontWeight = FontWeight.SemiBold)
            Text(detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}

@Composable
private fun Setup(service: HuntService) {
    var cardIndex by rememberSaveable { mutableIntStateOf(0) }
    var bandIndex by rememberSaveable { mutableIntStateOf(1) }
    var count by rememberSaveable { mutableIntStateOf(16) }
    var teams by rememberSaveable { mutableIntStateOf(0) }
    var timer by rememberSaveable { mutableIntStateOf(0) }
    var approval by rememberSaveable { mutableStateOf(false) }
    var photos by rememberSaveable { mutableStateOf(false) }
    var potd by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val cards = HuntCatalog.cards
    val card = cards[cardIndex.coerceIn(0, cards.lastIndex)]
    val bands = HuntBand.entries
    val band = bands[bandIndex.coerceIn(0, bands.lastIndex)]
    val ready = HuntSelector.available(card, band)

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("Pick a hunt", fontWeight = FontWeight.SemiBold)
            cards.chunked(2).forEachIndexed { row, pair ->
                ChoiceChips(pair, cards.indexOf(card) - row * 2, { it.emoji + " " + it.title }) { cardIndex = row * 2 + it }
            }
            Text(card.blurb, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(card.where, fontSize = 13.sp)
            Spacer(Modifier.height(10.dp))

            Text("Who is playing?", fontWeight = FontWeight.SemiBold)
            ChoiceChips(bands, bandIndex, { it.label.replace("Ages ", "") }) { bandIndex = it }
            Text(
                if (ready == 0) "Not enough items for that age. Pick an older age."
                else if (card.layout == HuntLayout.BINGO) "A $ready-square bingo card." else "$ready things to find available.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (card.layout == HuntLayout.LIST) {
                Spacer(Modifier.height(10.dp))
                Text("How many things?", fontWeight = FontWeight.SemiBold)
                ChoiceChips(HuntSettings.COUNTS, HuntSettings.COUNTS.indexOf(count).coerceAtLeast(0), { "$it" }) { count = HuntSettings.COUNTS[it] }
            }
            Spacer(Modifier.height(10.dp))

            Text("How do you play?", fontWeight = FontWeight.SemiBold)
            val modes = listOf(0, 1, 2, 3, 4)
            ChoiceChips(modes.take(3), if (teams <= 2) teams else -1, { modeLabel(it) }) { teams = it }
            ChoiceChips(modes.drop(3), teams - 3, { modeLabel(it) }) { teams = 3 + it }
            Spacer(Modifier.height(10.dp))

            Text("Timer", fontWeight = FontWeight.SemiBold)
            val timers = HuntSettings.TIMERS
            ChoiceChips(timers.take(3), timers.indexOf(timer), { if (it == 0) "Off" else "$it min" }) { timer = timers[it] }
            ChoiceChips(timers.drop(3), timers.indexOf(timer) - 3, { "$it min" }) { timer = timers[3 + it] }
            Spacer(Modifier.height(6.dp))

            SwitchRow("I check each find", "A find only counts after you tap Approve on this phone.", approval, { approval = it })
            SwitchRow("Photos on their own phones", "Guests may snap a picture to show you. It stays on their phone; nothing is sent.", photos, { photos = it; if (!it) potd = false })
            SwitchRow("Photo of the day", "One shared prompt, things only, no people. Only a yes reaches this phone.", potd, { potd = it }, enabled = photos)
            Spacer(Modifier.height(10.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            Button(
                onClick = {
                    error = service.open(
                        HuntSettings(
                            cardId = card.id, band = band, itemCount = count, teams = teams, timerMinutes = timer,
                            approval = approval, photos = photos, photoOfDay = potd,
                        ),
                    )
                },
                enabled = ready > 0,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Open the hunt for guests") }
        }
    }
}

private fun modeLabel(teams: Int): String = when (teams) {
    0 -> "Everyone alone"
    1 -> "All together"
    else -> "$teams teams"
}

@Composable
private fun Lobby(service: HuntService, host: HuntHostState) {
    var error by remember { mutableStateOf<String?>(null) }
    val settings = host.settings
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("${host.cardEmoji} ${host.cardTitle}", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text(
                "${host.itemCount} things to find. " + (settings?.let { modeLabel(it.teams) } ?: "") +
                    (if (settings != null && settings.timerMinutes > 0) ", ${settings.timerMinutes} minute timer" else ", no timer") + ".",
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            if (host.players.isEmpty()) Text("Nobody has joined yet.", fontSize = 14.sp)
            host.players.forEach { (name, team, _) ->
                Text(name + if (team >= 0) "  " + HuntTeams.GLYPHS[team] + " " + HuntTeams.NAMES[team] else "", fontSize = 15.sp)
            }
            Spacer(Modifier.height(10.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { error = service.start() }, enabled = host.players.isNotEmpty()) { Text("Start the hunt") }
                OutlinedButton(onClick = { service.close() }) { Text("Cancel") }
            }
        }
    }
    Spacer(Modifier.height(12.dp))
    FamilyGuestsCard("/hunt", "the scavenger hunt")
}

@Composable
private fun Running(service: HuntService, host: HuntHostState) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("${host.cardEmoji} ${host.cardTitle}", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text(
                if (host.remainingMs >= 0) "${clockText(host.remainingMs)} left" else "Running for ${clockText(host.elapsedMs)}",
                fontSize = 22.sp, fontWeight = FontWeight.Bold,
            )
            Text("${host.players.size} playing, ${host.itemCount} things to find.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            Button(onClick = { service.end() }) {
                Text(if (host.pending.isEmpty()) "End the hunt" else "End the hunt (${host.pending.size} not checked yet)")
            }
            if (host.pending.isNotEmpty()) {
                Text(
                    "Finds you have not approved when the hunt ends do not count.",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                )
            }
        }
    }
    if (host.settings?.approval == true) {
        Spacer(Modifier.height(12.dp))
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp)) {
                Text("Waiting for you", fontWeight = FontWeight.SemiBold)
                if (host.pending.isEmpty()) Text("Nothing to check right now.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                host.pending.forEach { line ->
                    Spacer(Modifier.height(6.dp))
                    Text(line.itemText, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                    Text(
                        "Found by ${line.who}" + if (line.team.isNotEmpty()) " (${line.team})" else "",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { service.approve(line.entityKey, line.itemId) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Yes, it counts") }
                        OutlinedButton(onClick = { service.remove(line.entityKey, line.itemId) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Not yet") }
                    }
                }
                if (host.pending.size > 1) {
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(onClick = { service.approveAll() }) { Text("Approve all ${host.pending.size}") }
                }
            }
        }
    }
    Spacer(Modifier.height(12.dp))
    Leaderboard(host)
    if (host.settings?.photoOfDay == true) {
        Spacer(Modifier.height(12.dp))
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp)) {
                Text("Photo of the day", fontWeight = FontWeight.SemiBold)
                Text(host.photoPrompt, fontSize = 15.sp)
                Text(
                    "${host.photoCount} of ${host.players.size} took theirs. The pictures stay on their own phones.",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
    Spacer(Modifier.height(12.dp))
    FamilyGuestsCard("/hunt", "the scavenger hunt")
}

@Composable
private fun Finished(service: HuntService, host: HuntHostState) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Hunt finished!", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            val win = host.winners.map { it.name }
            Text(
                when {
                    win.isEmpty() -> "Great looking, everybody!"
                    win.size == 1 -> win[0] + if (host.settings?.teams == 1) " did it!" else " wins!"
                    else -> "A tie: " + win.joinToString(" and ") + "!"
                },
                fontSize = 20.sp, textAlign = TextAlign.Center,
            )
            Text(
                when {
                    host.allFinished -> "Everybody found everything."
                    host.timedOut -> "The time was up."
                    else -> "You ended the hunt."
                } + " It took ${clockText(host.elapsedMs)}.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "If a trip is running, a one-line count was added to its journal. Nothing else was saved.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(10.dp))
            Button(onClick = { service.close() }) { Text("Play again") }
        }
    }
    Spacer(Modifier.height(12.dp))
    Leaderboard(host)
    if (host.settings?.teams != null && host.settings.teams >= 2 && host.contributions.any { it.second > 0 }) {
        Spacer(Modifier.height(12.dp))
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp)) {
                Text("Who found what", fontWeight = FontWeight.SemiBold)
                host.contributions.forEach { (name, points) ->
                    Row(Modifier.fillMaxWidth()) { Text(name, Modifier.weight(1f)); Text("$points", fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}

@Composable
private fun Leaderboard(host: HuntHostState) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text(if (host.settings?.teams == 0) "Leaderboard" else "Score", fontWeight = FontWeight.SemiBold)
            if (host.rows.isEmpty()) Text("Nobody has joined yet.", fontSize = 13.sp)
            host.rows.forEach { r ->
                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${r.rank}", Modifier.padding(end = 10.dp), fontWeight = FontWeight.Bold)
                    Column(Modifier.weight(1f)) {
                        Text((if (r.team >= 0) HuntTeams.GLYPHS[r.team] + " " else "") + r.name, fontSize = 16.sp)
                        Text(
                            "${r.found} of ${host.itemCount} found" + (if (r.lines > 0) ", ${r.lines} bingo line" + (if (r.lines == 1) "" else "s") else "") +
                                (if (r.pending > 0) ", ${r.pending} waiting" else "") + (if (r.done) ", all found!" else ""),
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text("${r.points}", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                }
            }
        }
    }
}

private fun clockText(ms: Long): String {
    val total = (ms.coerceAtLeast(0L) + 999) / 1000
    return "${total / 60}:${(total % 60).toString().padStart(2, '0')}"
}
