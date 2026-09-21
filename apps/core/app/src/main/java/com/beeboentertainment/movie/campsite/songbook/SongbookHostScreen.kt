package com.beeboentertainment.movie.campsite.songbook

import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import android.view.WindowManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.beeboentertainment.movie.campsite.family.FamilyGuestsCard
import com.beeboentertainment.movie.campsite.family.FamilyPackBHost
import kotlinx.coroutines.delay

private val Amber = Color(0xFFE9C28E)
private val AmberDim = Color(0xFF7D5D3E)
private val AmberNow = Color(0xFFFFD9A0)
private val FireBackground = Color(0xFF050302)
private val GroupGlyph = listOf("▲", "●", "■", "★")
private val GroupName = listOf("Red", "Blue", "Green", "Gold")

/**
 * Campfire Songbook, on the host's phone.
 *
 * The host phone is both the controller and the big-print lyric sheet, so the songbook works on
 * one phone with no guests, no Wi-Fi and no signal. Guests who join from a browser see the same
 * lines follow the same step. There is no microphone, no recording, no audio and no account.
 */
@Composable
fun SongbookHostScreen() {
    val service = remember { FamilyPackBHost.songbook }
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { while (true) { delay(250); tick++ } }
    val state = remember(tick) { service.hostState() }
    var filter by rememberSaveable { mutableStateOf("") }
    var includeNames by rememberSaveable { mutableStateOf(false) }
    var savedNote by remember { mutableStateOf<String?>(null) }
    var aboutOpen by rememberSaveable { mutableStateOf(false) }

    // Campfire mode dims this phone's screen while the songbook is open and keeps it awake for singing.
    val activity = LocalContext.current as? Activity
    DisposableEffect(activity, state.campfire) {
        val window = activity?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val before = window?.attributes?.screenBrightness
        if (state.campfire && window != null) window.attributes = window.attributes.also { it.screenBrightness = 0.15f }
        onDispose {
            window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (window != null) window.attributes = window.attributes.also {
                it.screenBrightness = before ?: WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            }
        }
    }

    val songs = service.catalog.songs
    Box(Modifier.fillMaxSize().background(if (state.campfire) FireBackground else MaterialTheme.colorScheme.background)) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            val titleColor = if (state.campfire) Amber else MaterialTheme.colorScheme.onBackground
            Text("Campfire Songbook", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = titleColor)
            Text(
                "Traditional songs, words only. Works with no signal, and no microphone is ever used.",
                fontSize = 13.sp, color = if (state.campfire) AmberDim else MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Campfire mode (dark and dim)", color = titleColor, fontSize = 14.sp)
                Spacer(Modifier.padding(6.dp))
                Switch(checked = state.campfire, onCheckedChange = { on -> service.locked { it.setCampfire(on) } })
            }
            Spacer(Modifier.height(10.dp))

            if (songs.isEmpty()) {
                Text("No songs are loaded yet. Add a song pack below.", color = MaterialTheme.colorScheme.error)
            }

            val song = state.song
            if (song != null) NowSinging(service, state)

            // Requests from guests' phones
            if (state.requests.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Text("Requested by guests", fontWeight = FontWeight.SemiBold)
                        state.requests.forEach { (requested, count) ->
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Text(requested.title + "  ♥ " + count, Modifier.weight(1f), fontSize = 15.sp)
                                TextButton(onClick = { service.locked { it.select(requested.id) } }) { Text("Sing it") }
                                TextButton(onClick = { service.locked { it.dismissRequest(requested.id) } }) { Text("Not now") }
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(14.dp))
            Text("Song list", fontWeight = FontWeight.SemiBold, color = titleColor, fontSize = 18.sp)
            OutlinedTextField(
                value = filter, onValueChange = { filter = it.take(40) }, singleLine = true,
                label = { Text("Find a song") }, modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(6.dp))
            songs.filter { filter.isBlank() || it.title.contains(filter.trim(), ignoreCase = true) }.forEach { s ->
                OutlinedButton(
                    onClick = { service.locked { it.select(s.id) } },
                    modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
                ) {
                    Text(s.title, Modifier.weight(1f), textAlign = TextAlign.Start)
                    if (s.round != null) Text("Round", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                }
            }

            Spacer(Modifier.height(14.dp))
            FamilyGuestsCard("/songbook", "the songbook")

            Spacer(Modifier.height(14.dp))
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    Text("Songs we sang", fontWeight = FontWeight.SemiBold)
                    if (state.sung.isEmpty()) {
                        Text("A song counts once you are half way through it.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        state.sung.forEach { Text("• $it", fontSize = 14.sp) }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Switch(checked = includeNames, onCheckedChange = { includeNames = it })
                            Spacer(Modifier.padding(4.dp))
                            Text("Include the names of the people who joined", fontSize = 12.sp)
                        }
                        Row {
                            Button(onClick = {
                                savedNote = if (service.saveToTrip(includeNames)) "Added to your trip journal (titles only)." else "No trip is running. Start one from Campsite Mode first."
                            }) { Text("Add to trip journal") }
                            Spacer(Modifier.padding(4.dp))
                            OutlinedButton(onClick = { service.locked { it.resetSession() }; savedNote = null }) { Text("New session") }
                        }
                        savedNote?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }

            Spacer(Modifier.height(14.dp))
            SongPacksCard(service)

            Spacer(Modifier.height(10.dp))
            TextButton(onClick = { aboutOpen = !aboutOpen }) { Text(if (aboutOpen) "Hide about the songs" else "About the songs") }
            if (aboutOpen) {
                Text(
                    "Only words are shown: no melody, no audio, no recording, no microphone, no accounts and no ads. " +
                        "Every song comes from a pack that names where it comes from and why it may be shown. " +
                        "docs/songs-provenance.md explains how a pack is checked and lists songs that must never be added.",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * Song packs: what is loaded, and "Add song pack" for a pack file the owner has already checked.
 * The file is read with the system file picker (nothing is uploaded), checked by the same rules
 * as the unit tests, and kept in this app's private storage.
 */
@Composable
private fun SongPacksCard(service: SongbookService) {
    val context = LocalContext.current
    var outcome by remember { mutableStateOf<ImportOutcome?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val text = runCatching {
                context.contentResolver.openInputStream(uri)?.use { input ->
                    readLimited(input, SongbookRules.MAX_PACK_BYTES)
                }
            }.getOrNull()
            outcome = if (text == null) ImportOutcome(false, "That file could not be read, or it is over 1 MB.") else service.importPack(text)
            tick++
        }
    }
    val packs = remember(tick, outcome) { service.catalog.packs }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("Song packs", fontWeight = FontWeight.SemiBold)
            packs.forEach { pack ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        pack.title + " (" + pack.songs.size + ")" + if (pack.demo) "  DEMO" else "",
                        Modifier.weight(1f), fontSize = 14.sp,
                    )
                    if (!service.library.isBuiltIn(pack.packId)) {
                        TextButton(onClick = { service.removePack(pack.packId); tick++ }) { Text("Remove") }
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(
                "Only two invented demo chants are built in. Real public-domain song packs must be added after a legal check: " +
                    "follow the checklist in docs/songs-provenance.md, then add the checked file here.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Button(onClick = { picker.launch(arrayOf("application/json", "text/plain", "application/octet-stream")) }) { Text("Add song pack") }
            outcome?.let { o ->
                Spacer(Modifier.height(6.dp))
                Text(o.message, fontSize = 13.sp, color = if (o.ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
                o.problems.forEach { Text("\u2022 $it", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}

@Composable
private fun NowSinging(service: SongbookService, state: SongbookHostState) {
    val song = state.song ?: return
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(song.title, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text(
                "Line ${(state.step + 1).coerceAtMost(state.total)} of ${state.total}" + if (state.roundMode) " (round)" else "",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            LyricSheet(song, state)
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { service.locked { it.back() } }) { Text("Back") }
                Button(onClick = { service.locked { if (state.playing) it.pause() else it.start() } }) {
                    Text(if (state.playing) "Pause" else if (state.finished) "Sing again" else "Start")
                }
                OutlinedButton(onClick = { service.locked { it.next() } }) { Text("Next line") }
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Advance by itself", fontSize = 13.sp)
                Spacer(Modifier.padding(4.dp))
                Switch(checked = state.auto, onCheckedChange = { on -> service.locked { it.setAuto(on) } })
            }
            Text(
                if (state.auto) "%.1f seconds per line".format(state.lineSeconds) else "Tap Next line to move on",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Slider(
                value = state.lineSeconds.toFloat().coerceIn(1.5f, 8f),
                onValueChange = { v -> service.locked { it.setLineSeconds(((v * 2).toInt() / 2.0).coerceAtLeast(1.5)) } },
                valueRange = 1.5f..8f, steps = 12, enabled = state.auto,
            )
            if (song.round != null) {
                HorizontalDivider()
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Round mode (groups enter one after another)", fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Switch(checked = state.roundMode, onCheckedChange = { on -> service.locked { it.setRoundMode(on) } })
                }
                if (state.roundMode) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Groups", fontSize = 13.sp)
                        listOf(2, 3, 4).forEach { n ->
                            if (n == state.groups) Button(onClick = {}) { Text("$n") }
                            else OutlinedButton(onClick = { service.locked { it.setGroups(n) } }) { Text("$n") }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Each group starts ${state.offsetLines} ${if (state.offsetLines == 1) "line" else "lines"} later", fontSize = 13.sp)
                        OutlinedButton(onClick = { service.locked { it.setOffsetLines(state.offsetLines - 1) } }) { Text("-") }
                        OutlinedButton(onClick = { service.locked { it.setOffsetLines(state.offsetLines + 1) } }) { Text("+") }
                    }
                    Text(
                        (0 until state.groups).joinToString("   ") { g ->
                            GroupGlyph[g] + " " + GroupName[g] + ": " + (state.groupSizes.getOrNull(g) ?: 0)
                        } + "  singers on guests' phones",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun HorizontalDivider() {
    Spacer(Modifier.height(6.dp))
    Box(Modifier.fillMaxWidth().height(1.dp).background(MaterialTheme.colorScheme.outlineVariant))
    Spacer(Modifier.height(6.dp))
}

/** The big-print lyric sheet: the line being sung, big, with its neighbours; in a round, one row per group. */
@Composable
private fun LyricSheet(song: Song, state: SongbookHostState) {
    val fire = state.campfire
    val panel = if (fire) Color(0xFF140C07) else MaterialTheme.colorScheme.surfaceVariant
    Column(
        Modifier.fillMaxWidth().background(panel, RoundedCornerShape(14.dp)).padding(14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (state.roundMode) {
            state.groupLines.forEach { g ->
                val text = when (g.state) {
                    SongbookEngine.GroupLine.Phase.SING -> song.lines[g.index]
                    SongbookEngine.GroupLine.Phase.WAIT -> "starts in ${g.index} ${if (g.index == 1) "line" else "lines"}"
                    SongbookEngine.GroupLine.Phase.DONE -> "finished"
                }
                val active = g.state == SongbookEngine.GroupLine.Phase.SING
                Text(
                    GroupGlyph[g.group] + " " + GroupName[g.group],
                    fontSize = 12.sp, color = if (fire) AmberDim else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text, fontSize = if (active) 30.sp else 20.sp,
                    fontWeight = if (active) FontWeight.ExtraBold else FontWeight.Normal,
                    color = if (active) (if (fire) AmberNow else MaterialTheme.colorScheme.onSurface) else if (fire) AmberDim else MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(8.dp))
            }
        } else {
            val idx = state.step.coerceAtMost(song.lines.size)
            if (idx >= song.lines.size) {
                Text("That was lovely. The song is finished.", fontSize = 24.sp, color = if (fire) AmberNow else MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
            } else {
                song.lines.getOrNull(idx - 1)?.let {
                    Text(it, fontSize = 20.sp, color = if (fire) AmberDim else MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                }
                if (song.refrainFlags[idx]) Text("EVERYBODY", fontSize = 12.sp, color = if (fire) Amber else MaterialTheme.colorScheme.primary)
                Text(
                    song.lines[idx], fontSize = 34.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center,
                    color = if (fire) AmberNow else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(vertical = 6.dp),
                )
                song.lines.getOrNull(idx + 1)?.let {
                    Text(it, fontSize = 24.sp, color = if (fire) Amber else MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
                }
                song.lines.getOrNull(idx + 2)?.let {
                    Text(it, fontSize = 20.sp, color = if (fire) AmberDim else MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                }
            }
        }
    }
}
