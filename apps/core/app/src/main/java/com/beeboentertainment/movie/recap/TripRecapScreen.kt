package com.beeboentertainment.movie.recap

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.checklist.ChecklistStore
import com.beeboentertainment.movie.data.ContinueCache
import com.beeboentertainment.movie.party.games.ThisOrThatStats
import com.beeboentertainment.movie.trip.Trip
import com.beeboentertainment.movie.trip.TripControlCard
import com.beeboentertainment.movie.trip.TripData
import com.beeboentertainment.movie.trip.TripMediaReader
import com.beeboentertainment.movie.trip.TripPresentDialog
import com.beeboentertainment.movie.trip.TripQueries
import com.beeboentertainment.movie.trip.TripSlides
import com.beeboentertainment.movie.trip.TripStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream

/*
 * "Trip Memory Recap" — an auto-assembled, shareable card built entirely from local activity the
 * app already kept (see TripRecapBuilder for the data sources). No new persistence beyond the tiny
 * This-or-That counter; the watch list comes from ContinueCache and packing from ChecklistStore.
 */

/*
 * With a Trip (see the trip package) the recap covers just that trip: the games, stories, badges and
 * packing list from its start to its end, instead of everything the app has ever seen. With no trip,
 * or when the person picks "All activity", it is the all-time recap it always was.
 */
@Composable
fun TripRecapScreen(modifier: Modifier = Modifier, onOpenExport: (String) -> Unit = {}, onOpenShare: (String) -> Unit = {}) {
    val session = remember { BeeboApp.instance.session }
    val store = remember { TripStore.forApp(session.plain) }
    var rev by remember { mutableIntStateOf(0) }
    val trips = remember(rev) { store.all() }
    var choice by rememberSaveable { mutableStateOf<String?>(null) }
    val selected = TripQueries.selectTrip(trips, choice)

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        TripControlCard(onChanged = { rev++ })
        if (trips.isNotEmpty()) {
            TripPicker(trips, selected?.id, onPick = { choice = it })
        }
        if (selected != null) {
            TripRecapBody(selected, rev, onChanged = { rev++ }, onOpenExport = onOpenExport, onOpenShare = onOpenShare)
        } else {
            AllActivityRecap()
        }
    }
}

@Composable
private fun TripPicker(trips: List<Trip>, selectedId: String?, onPick: (String?) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        trips.forEach { trip ->
            FilterChip(
                selected = trip.id == selectedId,
                onClick = { onPick(trip.id) },
                label = { Text(trip.name) },
            )
        }
        FilterChip(
            selected = selectedId == null,
            onClick = { onPick(TripQueries.ALL_ACTIVITY) },
            label = { Text("All activity") },
        )
    }
}

@Composable
private fun TripRecapBody(trip: Trip, rev: Int, onChanged: () -> Unit, onOpenExport: (String) -> Unit, onOpenShare: (String) -> Unit) {
    val context = LocalContext.current
    val session = remember { BeeboApp.instance.session }
    val store = remember { TripStore.forApp(session.plain) }
    val scope = rememberCoroutineScope()
    val summary = remember(trip, rev) { TripData.summary(trip, session) }
    val recap = remember(summary) { TripRecapBuilder.buildForTrip(summary) }
    var includeOutside by rememberSaveable(trip.id) { mutableStateOf(false) }
    var presenting by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val pick = remember(trip, includeOutside) {
        TripQueries.pickMedia(trip.media, TripQueries.window(trip, System.currentTimeMillis()), includeOutside)
    }

    // The system photo picker: it needs no storage permission and can only ever hand back the
    // photos and videos the person ticks. Beebo never sees the rest of the gallery.
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val added = withContext(Dispatchers.IO) { uris.map { TripMediaReader.read(context, it) } }
            store.setMedia(trip.id, trip.media + added)
            onChanged()
        }
    }

    Text(
        "Made from what happened between \"We're heading out\" and \"We're home\": games, stories, badges and " +
            "the packing list. Watch history isn't included because it isn't dated.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    RecapCard(recap)

    Button(onClick = { shareRecap(context, recap) }, modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Filled.Share, contentDescription = null)
        Spacer(Modifier.width(8.dp))
        Text("Share recap")
    }

    Text("Show it off", style = MaterialTheme.typography.titleMedium)
    Text(
        "Choose the photos and videos from the trip with your phone's own picker. Beebo only sees the ones " +
            "you tick, and nothing is uploaded.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    // A TV has no photo picker and no camera roll, and a long encode does not belong on one, so
    // it can present a trip (cards, and any photos chosen on the phone) but not choose or export.
    val isTv = com.beeboentertainment.movie.ui.tv.LocalIsTv.current
    if (!isTv) OutlinedButton(
        onClick = {
            picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
        },
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (trip.media.isEmpty()) "Choose photos and videos" else "Add more photos and videos") }
    if (trip.media.isNotEmpty()) {
        Text(
            "${TripSlides.plural(pick.shown.size, "photo or video")} in the show" +
                if (pick.outsideCount > 0 && !includeOutside) ", ${pick.outsideCount} left out (dated outside the trip)" else "",
            style = MaterialTheme.typography.bodyMedium,
        )
        if (pick.outsideCount > 0 || includeOutside) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = includeOutside, onCheckedChange = { includeOutside = it })
                Spacer(Modifier.width(8.dp))
                Text("Include ones dated outside the trip")
            }
        }
        TextButton(onClick = { store.setMedia(trip.id, emptyList()); onChanged() }) { Text("Clear chosen photos and videos") }
    }
    Button(onClick = { presenting = true }, modifier = Modifier.fillMaxWidth()) { Text("Present") }
    if (!isTv) OutlinedButton(onClick = { onOpenExport(trip.id) }, modifier = Modifier.fillMaxWidth()) { Text("Save as a video") }
    if (!isTv && !trip.running) OutlinedButton(onClick = { onOpenShare(trip.id) }, modifier = Modifier.fillMaxWidth()) { Text("Share a private link") }

    TextButton(onClick = { confirmDelete = true }) { Text("Delete this trip") }

    if (presenting) {
        val slides = remember(summary, pick) { TripSlides.build(summary, pick.shown) }
        TripPresentDialog(slides, onClose = { presenting = false })
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete \"${trip.name}\"?") },
            text = { Text("This removes the trip's recap from this phone. Your photos, videos and game history are not touched.") },
            confirmButton = {
                TextButton(onClick = { store.delete(trip.id); confirmDelete = false; onChanged() }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Keep") } },
        )
    }
}

@Composable
private fun AllActivityRecap(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val session = remember { BeeboApp.instance.session }

    // Snapshot the local sources once when the screen opens.
    val recap = remember {
        val continueResp = ContinueCache.get(session.plain)
        val checklist = ChecklistStore(session.plain).visible
        val game = ThisOrThatStats.snapshot(session.plain)
        TripRecapBuilder.build(
            continueResponse = continueResp,
            checklist = checklist,
            gameRounds = game.rounds,
            gameFirstMs = game.firstMs,
            gameLastMs = game.lastMs,
        )
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(
            "A little recap of your activity, made from what you watched, played, and packed. Tap " +
                "\"We're heading out\" above to keep a recap of just one trip. Share it with the family.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        RecapCard(recap)

        Button(
            onClick = { shareRecap(context, recap) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Filled.Share, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("Share recap")
        }

        TextButton(onClick = {
            ThisOrThatStats.reset(session.plain)
        }) { Text("Start a fresh trip (reset game count)") }
    }
}

/** The on-screen card. Its look mirrors [renderRecapBitmap] so the share image feels the same. */
@Composable
private fun RecapCard(recap: TripRecap) {
    val brush = Brush.verticalGradient(
        listOf(Color(0xFF6A1B9A), Color(0xFF283593)),
    )
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(brush)
            .padding(24.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(
                recap.title,
                color = Color.White,
                fontSize = 30.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                recap.dateRange,
                color = Color.White.copy(alpha = 0.8f),
                fontSize = 15.sp,
            )
            HorizontalDivider(color = Color.White.copy(alpha = 0.25f))

            if (recap.stats.isEmpty()) {
                Text(
                    "Your trip is just getting started — watch something, play a round of This or " +
                        "That, and tick off your packing list. Come back for your recap!",
                    color = Color.White,
                    fontSize = 16.sp,
                )
            } else {
                recap.stats.forEach { stat ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(stat.emoji, fontSize = 22.sp)
                        Spacer(Modifier.width(12.dp))
                        Text(
                            stat.text,
                            color = Color.White,
                            fontSize = 17.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                }
            }

            Spacer(Modifier.height(4.dp))
            Text(
                "— ${recap.footer}",
                color = Color.White.copy(alpha = 0.7f),
                fontSize = 14.sp,
            )
        }
    }
}

// ------------------------------------------------------------------- sharing

/**
 * Fire the standard Android share sheet with the recap: a rendered PNG when we can write one (via
 * the app's existing FileProvider), always with the plain-text version attached as EXTRA_TEXT so
 * it also lands nicely in text-only targets. Falls back to a text-only send if the image fails.
 */
private fun shareRecap(context: Context, recap: TripRecap) {
    val text = TripRecapBuilder.toShareText(recap)
    val uri = runCatching { writeRecapImage(context, recap) }.getOrNull()

    val send = Intent(Intent.ACTION_SEND).apply {
        putExtra(Intent.EXTRA_SUBJECT, recap.title)
        putExtra(Intent.EXTRA_TEXT, text)
        if (uri != null) {
            type = "image/png"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } else {
            type = "text/plain"
        }
    }
    context.startActivity(Intent.createChooser(send, "Share your trip recap"))
}

private fun writeRecapImage(context: Context, recap: TripRecap): Uri {
    val bmp = renderRecapBitmap(recap)
    val dir = File(context.cacheDir, "recap").apply { mkdirs() }
    val file = File(dir, "trip-recap.png")
    FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
}

/** Draw the recap onto a Bitmap with a matching purple-to-indigo gradient, for sharing. */
private fun renderRecapBitmap(recap: TripRecap): Bitmap {
    val width = 1080
    val padding = 72f
    val lineGap = 96f
    val bodyTop = 340f
    val lines = recap.stats.size.coerceAtLeast(2)
    val height = (bodyTop + lines * lineGap + 200f).toInt().coerceAtLeast(760)

    val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)

    val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        shader = LinearGradient(
            0f, 0f, 0f, height.toFloat(),
            0xFF6A1B9A.toInt(), 0xFF283593.toInt(),
            Shader.TileMode.CLAMP,
        )
    }
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bg)

    val title = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        textSize = 82f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    canvas.drawText(recap.title, padding, 150f, title)

    val date = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.argb(210, 255, 255, 255)
        textSize = 42f
    }
    canvas.drawText(recap.dateRange, padding, 214f, date)

    val rule = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.argb(70, 255, 255, 255)
        strokeWidth = 3f
    }
    canvas.drawLine(padding, 258f, width - padding, 258f, rule)

    val stat = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        textSize = 46f
    }
    var y = bodyTop
    if (recap.stats.isEmpty()) {
        canvas.drawText("Your trip is just getting started!", padding, y, stat)
    } else {
        recap.stats.forEach {
            canvas.drawText("${it.emoji}  ${it.text}", padding, y, stat)
            y += lineGap
        }
    }

    val footer = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.argb(180, 255, 255, 255)
        textSize = 38f
    }
    canvas.drawText("— ${recap.footer}", padding, height - 60f, footer)

    return bmp
}
