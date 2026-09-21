package com.beeboentertainment.movie.campsite.quiet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.party.campfire.AMBIENCES
import kotlinx.coroutines.delay

/** Play > Quiet Hours & Wind-Down: the same card the Campsite screen shows, on its own page. */
@Composable
fun QuietHoursScreen() {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("🌙 Quiet hours & wind-down", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        QuietHoursCard()
        WindDownCard()
    }
}

/**
 * The host's quiet-hours switch and window. Default OFF. It quietens this phone's narrator and game
 * sounds and holds back music for the whole camp during the window. It never claims to satisfy a
 * campground's rules: "Check your campground's posted quiet hours."
 */
@Composable
fun QuietHoursCard() {
    val runtime = QuietGate.runtime
    var rev by remember { mutableIntStateOf(0) }
    val settings = remember(rev) { runtime.store.settings() }
    val now by produceState(System.currentTimeMillis()) { while (true) { delay(15_000); value = System.currentTimeMillis() } }
    val view = remember(rev, now) { runtime.view() }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Quiet hours", fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                    Text(
                        "Keeps this phone's voice and game sounds down and holds back music for everyone, so the neighbours can sleep.",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(checked = settings.enabled, onCheckedChange = { on ->
                    runtime.store.save(settings.copy(enabled = on))
                    runtime.store.markAsked()
                    rev++
                })
            }
            if (settings.enabled) {
                Text("Starts", fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    QuietSettings.START_PRESETS.forEach { m ->
                        FilterChip(
                            selected = settings.startMinute == m,
                            onClick = { runtime.store.save(settings.copy(startMinute = m)); rev++ },
                            label = { Text(QuietHours.clockText(m)) },
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                    }
                }
                Text("Ends", fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    QuietSettings.END_PRESETS.forEach { m ->
                        FilterChip(
                            selected = settings.endMinute == m,
                            onClick = { runtime.store.save(settings.copy(endMinute = m)); rev++ },
                            label = { Text(QuietHours.clockText(m)) },
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                    }
                }
                Text(
                    when {
                        view.active -> "Quiet now, until ${view.endText}." + if (view.headphones) " Music: headphones only." else ""
                        view.startsInMs >= 0L -> "Quiet hours start in ${QuietHours.durationText(view.startsInMs)} (${view.windowText})."
                        else -> ""
                    },
                    fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                )
            }
            Text(
                "Check your campground's posted quiet hours. Beebo does not know your campground's rules.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** One tap: a gentle story, then quiet ambience, then a fade and stop. A visible Cancel throughout. */
@Composable
fun WindDownCard() {
    val context = LocalContext.current
    val ui by WindDownController.ui.collectAsState()
    var minutes by remember { mutableIntStateOf(20) }
    var story by remember { mutableStateOf(true) }
    var storyIndex by remember { mutableIntStateOf(0) }
    var ambience by remember { mutableStateOf("rain") }
    val running = ui.phase == WindDownPhase.STORY || ui.phase == WindDownPhase.AMBIENCE || ui.phase == WindDownPhase.FADE

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Bedtime wind-down", fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            Text(
                "A short story read by this phone, then quiet ambience, then a slow fade. It stops by itself when the time is up.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (running) {
                Text(
                    when (ui.phase) {
                        WindDownPhase.STORY -> "Reading: ${ui.storyTitle}"
                        WindDownPhase.AMBIENCE -> "Quiet ambience"
                        else -> "Fading out"
                    } + "  ·  " + com.beeboentertainment.movie.campsite.family.WallClock.durationText(ui.remainingMs) + " left",
                    fontWeight = FontWeight.SemiBold,
                )
                OutlinedButton(onClick = { WindDownController.cancel() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Cancel wind-down") }
            } else {
                if (ui.phase == WindDownPhase.DONE) Text("All done. Nothing is playing.", fontSize = 13.sp)
                Text("How long", fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    WindDownConfig.MINUTES.forEach { m ->
                        FilterChip(selected = minutes == m, onClick = { minutes = m }, label = { Text("$m min") }, modifier = Modifier.heightIn(min = 48.dp))
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Start with a story", modifier = Modifier.weight(1f))
                    Switch(checked = story, onCheckedChange = { story = it })
                }
                if (story) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        WindDownStories.ALL.forEachIndexed { i, s ->
                            FilterChip(selected = storyIndex == i, onClick = { storyIndex = i }, label = { Text(s.title, fontSize = 12.sp) }, modifier = Modifier.heightIn(min = 48.dp))
                        }
                    }
                }
                Text("Then", fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AMBIENCES.forEach { a ->
                        FilterChip(selected = ambience == a.id, onClick = { ambience = a.id }, label = { Text(a.emoji + " " + a.label, fontSize = 12.sp) }, modifier = Modifier.heightIn(min = 48.dp))
                    }
                }
                Button(
                    onClick = { WindDownController.start(context, WindDownConfig(minutes, story, storyIndex, ambience)) },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text("Start wind-down") }
            }
            Text(
                "A story and some quiet sound. Not a sleep aid and not a treatment for anything. Stories are written for Beebo and read by your phone's own voice; nothing needs the internet.",
                fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * Asks once, in the evening, whether to turn quiet hours on. Shown by the Campsite screen when a session
 * is running. "Not now" and closing it both mean it is not asked again on its own: quiet hours stay off.
 */
@Composable
fun QuietHoursPrompt(sessionRunning: Boolean) {
    val runtime = QuietGate.runtime
    var show by remember { mutableStateOf(false) }
    var answered by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(sessionRunning) {
        if (sessionRunning && !answered && runCatching { runtime.shouldPrompt() }.getOrDefault(false)) show = true
    }
    if (show) {
        val settings = remember { runtime.store.settings() }
        AlertDialog(
            onDismissRequest = { show = false; answered = true; runtime.store.markAsked() },
            title = { Text("It's getting late") },
            text = {
                Text(
                    "Turn on quiet hours (${QuietHours.windowText(settings.copy(startMinute = 22 * 60, endMinute = 6 * 60))})? " +
                        "The voice and game sounds on this phone stay down, and music for the whole camp waits for headphones. " +
                        "Check your campground's posted quiet hours.",
                )
            },
            confirmButton = {
                TextButton(onClick = { runtime.turnOn(22 * 60, 6 * 60); show = false; answered = true }) { Text("Turn on") }
            },
            dismissButton = {
                TextButton(onClick = { show = false; answered = true; runtime.store.markAsked() }) { Text("Not now") }
            },
        )
    }
}
