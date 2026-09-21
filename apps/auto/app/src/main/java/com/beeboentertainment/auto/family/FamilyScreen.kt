package com.beeboentertainment.auto.family

import android.os.SystemClock
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import com.beeboentertainment.auto.drive.VideoGate
import com.beeboentertainment.movie.campsite.quiet.QuietHours
import com.beeboentertainment.movie.campsite.quiet.QuietSettings
import com.beeboentertainment.movie.campsite.tripclock.TripClockLogic
import kotlinx.coroutines.delay
import java.util.TimeZone

private val MIN_TOUCH = 56.dp

/**
 * Family Fun on the phone: the settings a parent controls, the Trip Clock, and big buttons to start
 * a story or a voice game on the phone's own speaker (or the car's, if the phone is connected).
 *
 * WHO IT IS FOR. The settings are for a parent. The buttons are for a passenger. Every button that
 * starts something or changes something is disabled unless [FamilyGate] says taps are safe: a phone
 * that is not projecting to Android Auto and whose user said "I'm a passenger", or a parked
 * Android Automotive car. While the phone is running the car screen (or the car is moving, or the
 * car has not said it is parked) the buttons are off and this screen says why. The car's own
 * Next and Pause buttons work either way.
 *
 * NOTHING IS COLLECTED. No microphone, no location, no network, no account. The Trip Clock keeps
 * times only.
 */
@Composable
internal fun FamilyScreen(
    signals: VideoGate.Signals,
    player: Player?,
    onConfirmPassenger: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val prefs = remember { FamilyPrefs.get(context) }

    // The gate for THIS screen. Recomputed whenever the drive signals change.
    val tap = FamilyGate.tapAllowed(FamilyGate.Surface.THIS_APP_SCREEN, signals)
    val tapNote = FamilyGate.tapMessage(signals)

    var enabled by remember { mutableStateOf(prefs.enabled) }
    var handsFree by remember { mutableStateOf(prefs.handsFreeGamesOk) }
    var band by remember { mutableStateOf(prefs.ageBand) }
    var unit by remember { mutableStateOf(prefs.glanceUnit) }
    var quiet by remember { mutableStateOf(prefs.quiet.settings()) }
    var error by remember { mutableStateOf<String?>(null) }
    var nowPlaying by remember { mutableStateOf<String?>(null) }
    var playing by remember { mutableStateOf(false) }

    // The media service judges requests from this screen with the same live signals: MainActivity
    // copies them into FamilyRuntime while the screen is in front (see onStart and onStop there).

    DisposableEffect(player) {
        val l = object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                nowPlaying = mediaItem?.takeIf { FamilyIds.isFamily(it.mediaId) }?.let {
                    it.mediaMetadata.title?.toString().orEmpty() + " " + it.mediaMetadata.artist?.let { a -> "($a)" }.orEmpty()
                }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying }
            override fun onPlayerError(e: PlaybackException) { error = e.message ?: "That did not play." }
        }
        player?.addListener(l)
        onDispose { player?.removeListener(l) }
    }

    fun play(id: String) {
        val p = player ?: run { error = "The player is not ready yet. Try again in a moment."; return }
        error = null
        p.setMediaItem(MediaItem.Builder().setMediaId(id).build())
        p.prepare()
        p.play()
    }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Family Fun", style = MaterialTheme.typography.titleMedium)
        Text(
            "Stories, voice games and a trip clock, read aloud by this phone. Audio only: nothing to look at, " +
                "no microphone, nothing recorded. For passengers. Never for the driver.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // ---- parent settings ------------------------------------------------------------------
        SwitchRow(
            "Show Family Fun in the car's list",
            "Adds one folder to the car's media screen. Off until you turn it on. " +
                "Change it when parked, not while driving.",
            enabled,
            canChange = tap,
        ) { enabled = it; prefs.enabled = it }

        SwitchRow(
            "Allow voice games in the car, hands-free",
            "Rounds play one after another. The car's Next button skips a round. Off by default; " +
                "without it, games only start on a passenger's own phone.",
            handsFree,
            canChange = tap,
        ) { handsFree = it; prefs.handsFreeGamesOk = it }

        Text("Ages", fontWeight = FontWeight.Bold)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AgeBand.entries.forEach { b ->
                FilterChip(selected = band == b, onClick = { band = b; prefs.ageBand = b }, label = { Text(b.label) })
            }
        }

        Text("Trip Clock counts in", fontWeight = FontWeight.Bold)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GlanceUnit.entries.forEach { u ->
                FilterChip(selected = unit == u, onClick = { unit = u; prefs.glanceUnit = u }, label = { Text(u.label) })
            }
        }

        QuietHoursCard(quiet) { s -> quiet = s; prefs.quiet.save(s) }

        // ---- who may tap ----------------------------------------------------------------------
        if (!tap && tapNote != null) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(tapNote, style = MaterialTheme.typography.bodyMedium)
                    if (VideoGate.decide(signals) == VideoGate.Block.NEEDS_PASSENGER_CONFIRMATION) {
                        OutlinedButton(
                            onClick = onConfirmPassenger,
                            modifier = Modifier.heightIn(min = MIN_TOUCH),
                        ) { Text("I'm a passenger") }
                    }
                }
            }
        }

        // ---- trip clock -----------------------------------------------------------------------
        TripClockCard(prefs, unit, tap)

        // ---- now playing + sleep timer --------------------------------------------------------
        if (nowPlaying != null || FamilyRuntime.sleep.collectAsState().value != null) {
            NowPlayingCard(nowPlaying, playing, player, tap)
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }

        // ---- stories --------------------------------------------------------------------------
        Text("Roadside Stories", fontWeight = FontWeight.Bold)
        Text(
            "Calm stories, read aloud by the phone's voice. To listen to, not a sleep aid.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Stories.listFor(band).forEach { s ->
            Button(
                onClick = { play(FamilyIds.story(s.id)) },
                enabled = tap,
                modifier = Modifier.fillMaxWidth().heightIn(min = MIN_TOUCH),
            ) { Text("${s.title}  ·  ${s.band.label}, about ${s.minutes} min") }
        }

        // ---- voice games ----------------------------------------------------------------------
        Text("Voice Games", fontWeight = FontWeight.Bold)
        val quietNow = QuietHours.isQuiet(quiet, System.currentTimeMillis(), TimeZone.getDefault())
        if (quietNow) Text(FamilyGate.QUIET_MESSAGE, style = MaterialTheme.typography.bodyMedium)
        GameKind.entries.forEach { k ->
            Button(
                onClick = { play(FamilyIds.gameStart(k)) },
                enabled = tap && !quietNow,
                modifier = Modifier.fillMaxWidth().heightIn(min = MIN_TOUCH),
            ) { Text("${k.title}  ·  ${k.blurb}") }
        }
        PointsCard(tap)
    }
}

@Composable
private fun SwitchRow(title: String, subtitle: String, checked: Boolean, canChange: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onChange, enabled = canChange)
    }
}

@Composable
private fun QuietHoursCard(quiet: QuietSettings, onChange: (QuietSettings) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SwitchRow(
                "Quiet hours",
                "During quiet hours voice games rest and stories are read slowly with a sleep timer already on. " +
                    "Check your campground's posted quiet hours.",
                quiet.enabled,
            ) { onChange(quiet.copy(enabled = it)) }
            if (quiet.enabled) {
                Text("From", fontWeight = FontWeight.Bold)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    QuietSettings.START_PRESETS.forEach { m ->
                        FilterChip(selected = quiet.startMinute == m, onClick = { onChange(quiet.copy(startMinute = m)) }, label = { Text(QuietHours.clockText(m)) })
                    }
                }
                Text("Until", fontWeight = FontWeight.Bold)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    QuietSettings.END_PRESETS.forEach { m ->
                        FilterChip(selected = quiet.endMinute == m, onClick = { onChange(quiet.copy(endMinute = m)) }, label = { Text(QuietHours.clockText(m)) })
                    }
                }
            }
        }
    }
}

@Composable
private fun TripClockCard(prefs: FamilyPrefs, unit: GlanceUnit, tap: Boolean) {
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var minutes by remember { mutableIntStateOf(60) }
    var state by remember { mutableStateOf(prefs.clock.state()) }
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        while (true) { nowMs = System.currentTimeMillis(); state = prefs.clock.state(); delay(15_000) }
    }
    val zone = TimeZone.getDefault()
    val glance = TripGlance.glance(state, nowMs, zone)

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Trip Clock", fontWeight = FontWeight.Bold)
            Text(glance.title, style = MaterialTheme.typography.headlineSmall)
            if (glance.running && state.arrivedAtMs == 0L) {
                Text("About ${TripGlance.timeLeftText(state, nowMs, zone)} left", style = MaterialTheme.typography.bodyMedium)
            }
            Text(glance.subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(TripGlance.PASSENGERS, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

            fun edit(block: (com.beeboentertainment.movie.campsite.tripclock.TripClockState) -> com.beeboentertainment.movie.campsite.tripclock.TripClockState) {
                problem = null
                state = try { prefs.clock.update(block) } catch (e: IllegalArgumentException) { problem = e.message; state }
            }

            if (!state.running) {
                Text("Trip length: ${minutes / 60} h ${minutes % 60} min", style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { minutes = (minutes - 15).coerceAtLeast(15) }, enabled = tap, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text("-15 min") }
                    OutlinedButton(onClick = { minutes = (minutes + 15).coerceAtMost(72 * 60) }, enabled = tap, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text("+15 min") }
                }
                Button(
                    onClick = {
                        val now = System.currentTimeMillis()
                        edit {
                            // No nudges in the car: nothing that pops up. The unit is the parent's choice.
                            TripClockLogic.start(now, TripClockLogic.etaFromNow(now, minutes), 0,
                                com.beeboentertainment.movie.campsite.tripclock.KidUnit.NONE, nudgeMinutes = 0)
                                .copy(kidUnit = unit.wire)
                        }
                    },
                    enabled = tap,
                    modifier = Modifier.fillMaxWidth().heightIn(min = MIN_TOUCH),
                ) { Text("Start the clock") }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { edit { TripClockLogic.adjust(it, TripClockLogic.ADJUST_STEP_MIN, System.currentTimeMillis()) } }, enabled = tap, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text("+15 min") }
                    OutlinedButton(onClick = { edit { TripClockLogic.arrive(it, System.currentTimeMillis()) } }, enabled = tap, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text("We've arrived") }
                }
                OutlinedButton(onClick = { prefs.clock.clear(); state = prefs.clock.state() }, enabled = tap, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text("Stop the clock") }
            }
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (!tap) Text("Set it when parked, on a passenger's phone.", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun NowPlayingCard(nowPlaying: String?, playing: Boolean, player: Player?, tap: Boolean) {
    val sleep = FamilyRuntime.sleep.collectAsState().value
    var tick by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(sleep) { while (sleep != null) { tick = SystemClock.elapsedRealtime(); delay(5_000) } }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            nowPlaying?.let { Text(it, fontWeight = FontWeight.Bold) }
            if (nowPlaying != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { if (playing) player?.pause() else player?.play() }, enabled = tap, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text(if (playing) "Pause" else "Play") }
                    OutlinedButton(onClick = { player?.seekToNextMediaItem() }, enabled = tap, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text("Next") }
                }
            }
            Text("Sleep timer: " + SleepTimerLogic.label(sleep, maxOf(tick, SystemClock.elapsedRealtime())), fontWeight = FontWeight.Bold)
            Text("A timer and a fade, then it stops. Not a sleep aid.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SleepTimerLogic.CHOICES_MINUTES.forEach { m ->
                    OutlinedButton(
                        onClick = { FamilyRuntime.sleep.value = SleepTimerLogic.start(SystemClock.elapsedRealtime(), m) },
                        enabled = tap,
                        modifier = Modifier.heightIn(min = MIN_TOUCH),
                    ) { Text("$m min") }
                }
                OutlinedButton(onClick = { FamilyRuntime.sleep.value = null }, enabled = tap && sleep != null, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text("Off") }
            }
        }
    }
}

@Composable
private fun PointsCard(tap: Boolean) {
    // Kept only while this screen is open, never saved and never sent: one big tap per point.
    val board = remember { com.beeboentertainment.auto.family.Scoreboard() }
    var points by remember { mutableIntStateOf(0) }
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Points: $points", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Button(onClick = { points = board.add() }, enabled = tap, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text("+1") }
            OutlinedButton(onClick = { points = board.undo() }, enabled = tap, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text("-1") }
            OutlinedButton(onClick = { board.reset(); points = 0 }, enabled = tap, modifier = Modifier.heightIn(min = MIN_TOUCH)) { Text("Clear") }
        }
    }
}
