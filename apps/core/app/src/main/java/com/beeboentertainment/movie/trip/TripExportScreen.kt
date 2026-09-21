package com.beeboentertainment.movie.trip

import android.content.ClipData
import android.content.Context
import android.content.Intent
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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.beeboentertainment.movie.BeeboApp
import java.io.File

/** The plain-language note shown on the export screen, as the design asks. */
internal const val EXPORT_NOTE = "Personal home video for sharing with family."

/**
 * "Save as a video": turns the trip's slideshow into an MP4 on this phone and hands it to the
 * Android share sheet. The video is made here and goes only where the person sends it.
 */
@Composable
internal fun TripExportScreen(tripId: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val session = remember { BeeboApp.instance.session }
    val trip = remember(tripId) { TripStore.forApp(session.plain).trip(tripId) }
    val exportState by TripExportState.state.collectAsState()

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Save as a video", style = MaterialTheme.typography.titleLarge)
        if (trip == null) {
            Text("That trip is no longer saved.", style = MaterialTheme.typography.bodyMedium)
            return@Column
        }
        Text(trip.name, style = MaterialTheme.typography.titleMedium)
        Text(EXPORT_NOTE, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)

        val busy = exportState is ExportState.Preparing || exportState is ExportState.Encoding
        when (val state = exportState) {
            is ExportState.Preparing, is ExportState.Encoding -> Progress(state)
            is ExportState.Done -> if (state.tripId == tripId) Finished(context, trip, state)
            is ExportState.Failed -> Text(state.message, color = MaterialTheme.colorScheme.error)
            ExportState.Cancelled -> Text("Cancelled. Nothing was kept.", style = MaterialTheme.typography.bodyMedium)
            ExportState.Idle -> Unit
        }
        Options(trip, busy)
    }
}

@Composable
private fun Progress(state: ExportState) {
    val (label, fraction) = when (state) {
        is ExportState.Preparing -> "Preparing pictures…" to (if (state.total == 0) 0f else state.done / state.total.toFloat())
        is ExportState.Encoding -> "Making the video… ${state.percent}%" to state.percent / 100f
        else -> "" to 0f
    }
    val context = LocalContext.current
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(label, style = MaterialTheme.typography.titleMedium)
            LinearProgressIndicator(progress = { fraction.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
            Text(
                "This runs in the background and takes about as long as the video itself. Keep the phone " +
                    "charging; it may get warm. You can leave this screen.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedButton(onClick = { TripExportService.cancel(context) }) { Text("Cancel") }
        }
    }
}

@Composable
private fun Finished(context: Context, trip: Trip, state: ExportState.Done) {
    val file = File(state.path)
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Your video is ready", style = MaterialTheme.typography.titleMedium)
            Text(
                "${formatLength(state.durationMs)} · ${formatSize(state.sizeBytes)}" +
                    if (state.ambience) " · with campfire crackle" else " · no sound",
                style = MaterialTheme.typography.bodyMedium,
            )
            if (state.skippedMedia > 0) {
                Text(
                    "${TripSlides.plural(state.skippedMedia, "photo or video")} left out (too long a video, unreadable, or too short).",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Button(
                onClick = { share(context, trip, file) },
                enabled = file.isFile,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Share video") }
            if (!file.isFile) {
                Text("This video has been cleared from the phone's temporary storage. Make it again.", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun Options(trip: Trip, busy: Boolean) {
    val context = LocalContext.current
    val session = remember { BeeboApp.instance.session }
    val summary = remember(trip) { TripData.summary(trip, session) }
    var quality by rememberSaveable { mutableStateOf(ExportQuality.P1080.name) }
    var ambience by rememberSaveable { mutableStateOf(false) }
    var includeOutside by rememberSaveable { mutableStateOf(false) }
    var shown by remember { mutableStateOf(emptySet<String>()) }

    val settings = ExportSettings(
        quality = ExportQuality.valueOf(quality), ambience = ambience,
        shownNames = shown, includeOutsideMedia = includeOutside,
    )
    val window = remember(trip) { TripQueries.window(trip, System.currentTimeMillis()) }
    val pick = remember(trip, includeOutside) { TripQueries.pickMedia(trip.media, window, includeOutside) }
    val plan = remember(summary, pick, settings) {
        TripExportPlanner.plan(TripSlides.build(summary, pick.shown, NameMask.only(shown)), settings)
    }

    Text("What goes in", style = MaterialTheme.typography.titleMedium)
    val photos = plan.items.count { it is PlanItem.Photo }
    val clips = plan.items.count { it is PlanItem.Video }
    Text(
        "About ${formatLength(plan.totalMs)}: ${TripSlides.plural(plan.items.count { it is PlanItem.Card }, "card")}, " +
            "${TripSlides.plural(photos, "photo")} and ${TripSlides.plural(clips, "clip")} trimmed to a few seconds each." +
            if (plan.skippedMedia > 0) " ${plan.skippedMedia} more won't fit." else "",
        style = MaterialTheme.typography.bodyMedium,
    )
    if (trip.media.isEmpty()) {
        Text(
            "No photos or videos chosen yet. Choose them on the recap screen first, or make a video of just the cards.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    if (pick.outsideCount > 0 || includeOutside) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = includeOutside, onCheckedChange = { includeOutside = it })
            Spacer(Modifier.width(8.dp))
            Text("Include photos and videos dated outside the trip")
        }
    }

    Text("Picture size", style = MaterialTheme.typography.titleMedium)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ExportQuality.entries.forEach { q ->
            FilterChip(selected = quality == q.name, onClick = { quality = q.name }, label = { Text(q.label) })
        }
    }
    Text(
        "1080p is the largest. Choose 720p for a smaller file or if 1080p fails on this phone.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    Text("Names on the video", style = MaterialTheme.typography.titleMedium)
    if (summary.roster.isEmpty()) {
        Text("No names to show.", style = MaterialTheme.typography.bodyMedium)
    } else {
        Text(
            "A video can be sent to anyone, so guests appear as \"${NameMask.PLACEHOLDER}\" unless you tick their name. " +
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

    Text("Sound", style = MaterialTheme.typography.titleMedium)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Switch(checked = ambience, onCheckedChange = { ambience = it })
        Spacer(Modifier.width(8.dp))
        Text("Add campfire crackle")
    }
    Text(
        "Off by default, so the video is silent. The crackle is made on your phone. Music from your library is " +
            "never used, and the sound in your own clips is left out.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    Text(
        "Made on this phone. Nothing is uploaded. Photos are redrawn from their pixels and the finished file is " +
            "scrubbed of any GPS location, so the video carries no location.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Button(
        onClick = { TripExportService.start(context, ExportRequest(trip.id, settings)) },
        enabled = !busy && plan.items.isNotEmpty(),
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (busy) "Making your video…" else "Make video") }
}

/** Hand the file to the share sheet through the app's one FileProvider (see res/xml/file_paths.xml). */
private fun share(context: Context, trip: Trip, file: File) {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "video/mp4"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, trip.name)
        clipData = ClipData.newRawUri("", uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(send, "Share your trip video"))
}

internal fun formatLength(ms: Long): String {
    val total = (ms / 1000L).coerceAtLeast(0L)
    val m = total / 60
    val s = total % 60
    return if (m == 0L) "${s}s" else "${m}m ${s}s"
}

internal fun formatSize(bytes: Long): String = when {
    bytes >= 1_000_000_000L -> "%.1f GB".format(bytes / 1e9)
    bytes >= 1_000_000L -> "%.0f MB".format(bytes / 1e6)
    else -> "${bytes / 1000L} KB"
}
