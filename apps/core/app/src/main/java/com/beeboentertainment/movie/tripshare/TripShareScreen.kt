package com.beeboentertainment.movie.tripshare

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.trip.NameMask
import com.beeboentertainment.movie.trip.Trip
import com.beeboentertainment.movie.trip.TripData
import com.beeboentertainment.movie.trip.TripLogic
import com.beeboentertainment.movie.trip.TripQueries
import com.beeboentertainment.movie.trip.TripSlides
import com.beeboentertainment.movie.trip.TripStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/** The note under the song switch, in the sender's words. Shown exactly, never shortened. */
internal const val SONG_RIGHTS_TEXT =
    "I have the right to share this recording with the people I send this link to. It plays from my own file, " +
        "only through this link, and Beebo supplies no music."

private sealed class ServerState {
    object Loading : ServerState()
    data class Ready(val status: ServerStatus) : ServerState()
    data class Unavailable(val message: String) : ServerState()
}

/**
 * "Share this trip": pick what goes on a private page, then make a link that is served by the
 * person's own computer. The photos go from this phone to that computer and nowhere else.
 */
@Composable
internal fun TripShareScreen(tripId: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val session = remember { BeeboApp.instance.session }
    var rev by remember { mutableIntStateOf(0) }
    val trip = remember(tripId, rev) { TripStore.forApp(session.plain).trip(tripId) }

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Share this trip", style = MaterialTheme.typography.titleLarge)
        if (trip == null) {
            Text("That trip is no longer saved.", style = MaterialTheme.typography.bodyMedium)
            return@Column
        }
        Text(trip.name, style = MaterialTheme.typography.titleMedium)
        if (trip.running) {
            Text(
                "This trip is still running. Tap \"We're home\" first, so the page tells the whole story.",
                style = MaterialTheme.typography.bodyMedium,
            )
            return@Column
        }
        Hosting()
        ShareBody(trip, onChanged = { rev++ })
    }
}

@Composable
private fun Hosting() {
    Text("Where the link lives", style = MaterialTheme.typography.titleMedium)
    ShareHosting.entries.forEach { h ->
        Row(verticalAlignment = Alignment.Top) {
            // The Beebo-hosted choice is a disabled stub: shown so people know it is off, never selectable.
            RadioButton(selected = h == ShareHosting.OWN_PC, onClick = null, enabled = h.available)
            Spacer(Modifier.width(8.dp))
            Column {
                Text(h.label, fontWeight = FontWeight.SemiBold, color = if (h.available) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
                Text(h.note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ShareBody(trip: Trip, onChanged: () -> Unit) {
    val context = LocalContext.current
    val app = remember { BeeboApp.instance }
    val session = app.session
    val scope = rememberCoroutineScope()
    val client = remember { TripShareClient(session, app.api.okHttp) }
    val links = remember { TripShareStore.forApp(session) }
    var refresh by remember { mutableIntStateOf(0) }
    var server by remember { mutableStateOf<ServerState>(ServerState.Loading) }
    var remote by remember { mutableStateOf<List<RemoteShare>>(emptyList()) }
    val progress by TripShareState.state.collectAsState()
    // A finished or failed attempt from an earlier visit is not news any more.
    LaunchedEffect(Unit) { if (TripShareState.state.value !is ShareProgress.Working) TripShareState.reset() }
    val workingOn = remember(progress) { TripShareJobStore(session.plain).current()?.tripId }
    val otherTripBusy = progress is ShareProgress.Working && workingOn != null && workingOn != trip.id

    LaunchedEffect(refresh) {
        server = ServerState.Loading
        withContext(Dispatchers.IO) {
            val s = runCatching { client.status() }.getOrNull()
            server = when {
                s == null -> ServerState.Unavailable("Your computer didn't answer. Check it is on and Beebo is running, then try again.")
                s.ok -> ServerState.Ready(s.body!!)
                else -> ServerState.Unavailable(TripShareLogic.describeCreateError(s.code, s.error))
            }
            if (s != null && s.ok) remote = runCatching { client.list() }.getOrNull()?.body?.shares.orEmpty().filter { it.tripId == trip.id }
        }
    }

    val summary = remember(trip) { TripData.summary(trip, session) }
    val window = remember(trip) { TripQueries.window(trip, System.currentTimeMillis()) }
    var includeOutside by rememberSaveable { mutableStateOf(false) }
    val pick = remember(trip, includeOutside) { TripQueries.pickMedia(trip.media, window, includeOutside) }
    var includeLocation by rememberSaveable { mutableStateOf(false) }
    var includeSong by rememberSaveable { mutableStateOf(false) }
    var rightsAck by rememberSaveable { mutableStateOf(false) }
    var expiryName by rememberSaveable { mutableStateOf(ShareExpiry.DEFAULT.name) }
    var wifiOnly by rememberSaveable { mutableStateOf(true) }
    var songUri by rememberSaveable { mutableStateOf<String?>(null) }
    var songName by rememberSaveable { mutableStateOf("") }
    var shown by remember { mutableStateOf(emptySet<String>()) }
    var confirmDeleteTrip by remember { mutableStateOf(false) }

    val songPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) {
            runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            songUri = uri.toString()
            songName = TripShareMediaPrep.info(context, uri).name
        }
    }

    val options = ShareOptions(
        includeLocation = includeLocation, includeSong = includeSong,
        expiry = ShareExpiry.valueOf(expiryName), rightsAck = rightsAck, shownNames = shown, includeOutsideMedia = includeOutside,
    )
    val hasPlaces = trip.moments.any { it.lat != null && it.lng != null }

    // ---------------- the computer ----------------
    when (val s = server) {
        ServerState.Loading -> Text("Checking your computer…", style = MaterialTheme.typography.bodyMedium)
        is ServerState.Unavailable -> Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(s.message, color = MaterialTheme.colorScheme.error)
                OutlinedButton(onClick = { refresh++ }) { Text("Try again") }
            }
        }
        is ServerState.Ready -> {
            val st = s.status
            Text(
                "Space on your computer for trips: ${TripShareLogic.formatBytes(st.usage.used)} used of ${TripShareLogic.formatBytes(st.usage.cap)}. " +
                    TripShareLogic.reachNote(st.reachableAnywhere),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    // ---------------- what goes in ----------------
    Text("What goes on the page", style = MaterialTheme.typography.titleMedium)
    val photos = pick.shown.count { !it.video }
    val clips = pick.shown.count { it.video }
    Text(
        "The dates, ${TripSlides.plural(summary.gameCount, "game")}, stories, badges and packing, plus " +
            "${TripSlides.plural(photos, "photo")} and ${TripSlides.plural(clips, "clip")} you chose on the recap screen. " +
            "Photos are redrawn smaller before they leave the phone.",
        style = MaterialTheme.typography.bodyMedium,
    )
    if (pick.outsideCount > 0 || includeOutside) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = includeOutside, onCheckedChange = { includeOutside = it })
            Spacer(Modifier.width(8.dp))
            Text("Include photos and videos dated outside the trip")
        }
    }

    // ---------------- names ----------------
    if (summary.roster.isNotEmpty()) {
        Text("Names on the page", style = MaterialTheme.typography.titleMedium)
        Text(
            "Anyone with the link can read it, so guests show as \"${NameMask.PLACEHOLDER}\" unless you tick their name. " +
                "Names are whatever people typed; nothing checks who they are.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { shown = summary.roster.map { TripLogic.key(it) }.toSet() }) { Text("Show everyone") }
            TextButton(onClick = { shown = emptySet() }) { Text("Show no one") }
        }
        summary.roster.forEach { name ->
            val key = TripLogic.key(name)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = key in shown, onCheckedChange = { on -> shown = if (on) shown + key else shown - key })
                Text(name)
            }
        }
    }

    // ---------------- privacy switches ----------------
    Text("Privacy", style = MaterialTheme.typography.titleMedium)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Include places", style = MaterialTheme.typography.bodyLarge)
            Text(
                if (hasPlaces) "Off: the page shows no places. On: it lists the scavenger-hunt places you chose to save on this trip. Photos never carry a location either way."
                else "This trip saved no places, so there is nothing to add. Photos never carry a location.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = includeLocation && hasPlaces, enabled = hasPlaces, onCheckedChange = { includeLocation = it })
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Add a song", style = MaterialTheme.typography.bodyLarge)
            Text(
                "Off by default. A song you choose plays on the page, from your own file, for the people you send this link to.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(
            checked = includeSong,
            onCheckedChange = { on ->
                val next = options.withSong(on)
                includeSong = next.includeSong; rightsAck = next.rightsAck; expiryName = next.expiry.name
                if (!on) { songUri = null; songName = "" }
            },
        )
    }
    if (includeSong) {
        OutlinedButton(onClick = { songPicker.launch(arrayOf("audio/*")) }, modifier = Modifier.fillMaxWidth()) {
            Text(if (songUri == null) "Choose the song file" else "Song: $songName (change)")
        }
        Row(verticalAlignment = Alignment.Top) {
            Checkbox(checked = rightsAck, onCheckedChange = { rightsAck = it })
            Text(SONG_RIGHTS_TEXT, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 12.dp))
        }
        Text(
            "Songs are usually someone else's work. Link lengths start shorter when a song is on.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    // ---------------- expiry ----------------
    Text("How long the link works", style = MaterialTheme.typography.titleMedium)
    val allowed = (server as? ServerState.Ready)?.status?.settings?.maxExpiryHours ?: ShareExpiry.QUARTER.hours
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        ShareExpiry.entries.filter { it.hours <= allowed || it == ShareExpiry.DAY }.forEach { e ->
            FilterChip(selected = expiryName == e.name, onClick = { expiryName = e.name }, label = { Text(e.label) })
        }
    }
    Text(
        "The link is view-only: nobody can change anything or see your other photos. It stops on its own at the end, and you can turn it off yourself at any time.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
        Switch(checked = wifiOnly, onCheckedChange = { wifiOnly = it })
        Spacer(Modifier.width(8.dp))
        Text("Send only on Wi-Fi")
    }

    // ---------------- make it ----------------
    val problem = options.problem(hasSong = songUri != null)
    val ready = server is ServerState.Ready
    val busy = progress is ShareProgress.Working
    if (otherTripBusy) Text("Another trip is being shared right now. Wait for it to finish.", style = MaterialTheme.typography.bodySmall)
    problem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    Button(
        onClick = {
            val maxHours = (server as? ServerState.Ready)?.status?.settings?.maxExpiryHours ?: options.expiry.hours
            TripShareWorker.start(
                context,
                ShareJob(
                    id = UUID.randomUUID().toString().take(12), tripId = trip.id, tripName = trip.name,
                    media = pick.shown.map { JobMedia(it.uri, it.video, it.takenAt) },
                    includeLocation = includeLocation && hasPlaces, includeSong = includeSong, rightsAck = rightsAck,
                    expiryHours = minOf(options.expiry.hours, maxHours),
                    shownNames = shown.toList(), songUri = songUri, songTitle = songName.substringBeforeLast('.'),
                    wifiOnly = wifiOnly, createdAt = System.currentTimeMillis(),
                ),
            )
        },
        enabled = ready && !busy && !otherTripBusy && problem == null,
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (busy) "Making your link…" else "Create private link") }

    when (val p = progress) {
        is ShareProgress.Working -> if (!otherTripBusy) Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(p.label, style = MaterialTheme.typography.titleMedium)
                LinearProgressIndicator(progress = { p.fraction.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                Text(
                    "This carries on in the background. If the connection drops it resumes where it stopped.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedButton(onClick = { TripShareWorker.cancel(context, trip.id) }) { Text("Cancel") }
            }
        }
        is ShareProgress.Failed -> Text(p.message, color = MaterialTheme.colorScheme.error)
        is ShareProgress.Done -> if (p.link.tripId == trip.id) {
            DoneCard(context, p)
            LaunchedEffect(p) { refresh++ }
        }
        ShareProgress.Idle -> Unit
    }

    // ---------------- links for this trip ----------------
    if (remote.isNotEmpty()) {
        Text("Links for this trip", style = MaterialTheme.typography.titleMedium)
        remote.forEach { share ->
            val saved = links.forTrip(trip.id).firstOrNull { it.shareId == share.id }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(TripShareLogic.statusLine(share), fontWeight = FontWeight.SemiBold)
                    Text(
                        TripShareLogic.includesLine(share.options) + " · ${TripSlides.plural(share.views, "view")}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (share.live && saved != null) {
                            TextButton(onClick = { copy(context, saved.url) }) { Text("Copy") }
                            TextButton(onClick = { sendLink(context, trip.name, saved.url) }) { Text("Send") }
                        }
                        if (share.live) TextButton(onClick = {
                            scope.launch(Dispatchers.IO) { runCatching { client.extend(share.id, 7 * 24) }; refresh++ }
                        }) { Text("+7 days") }
                        if (share.live) TextButton(onClick = {
                            scope.launch(Dispatchers.IO) { runCatching { client.revoke(share.id) }; refresh++ }
                        }) { Text("Turn off") }
                        TextButton(onClick = {
                            scope.launch(Dispatchers.IO) { runCatching { client.delete(share.id) }; links.remove(share.id); refresh++ }
                        }) { Text("Delete") }
                    }
                }
            }
        }
    }
    OutlinedButton(onClick = { confirmDeleteTrip = true }, modifier = Modifier.fillMaxWidth()) { Text("Delete this trip from my computer") }
    Text(
        "Removes every link to this trip and every photo and clip of it that was sent to your computer. Nothing on this phone is touched.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (confirmDeleteTrip) {
        AlertDialog(
            onDismissRequest = { confirmDeleteTrip = false },
            title = { Text("Delete from my computer?") },
            text = { Text("All links to \"${trip.name}\" stop working and the copies on your computer are deleted.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDeleteTrip = false
                    scope.launch(Dispatchers.IO) { runCatching { client.deleteTrip(trip.id) }; links.removeTrip(trip.id); refresh++ }
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { confirmDeleteTrip = false }) { Text("Keep") } },
        )
    }
}

@Composable
private fun DoneCard(context: Context, done: ShareProgress.Done) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Your link is ready", style = MaterialTheme.typography.titleMedium)
            Text(done.link.url, style = MaterialTheme.typography.bodyMedium)
            Text(TripShareLogic.reachNote(done.link.reachableAnywhere), style = MaterialTheme.typography.bodySmall)
            done.notes.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
            if (done.skipped.isNotEmpty()) {
                Text(
                    "${TripSlides.plural(done.skipped.size, "file")} left out: " + done.skipped.take(3).joinToString("; ") { "${it.name} (${it.reason})" },
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { sendLink(context, done.link.title, done.link.url) }) { Text("Send link") }
                OutlinedButton(onClick = { copy(context, done.link.url) }) { Text("Copy") }
            }
        }
    }
}

private fun copy(context: Context, url: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    cm.setPrimaryClip(ClipData.newPlainText("Trip link", url))
}

private fun sendLink(context: Context, title: String, url: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, title)
        putExtra(Intent.EXTRA_TEXT, "Here's our trip, $title: $url")
    }
    context.startActivity(Intent.createChooser(send, "Send the trip link"))
}
