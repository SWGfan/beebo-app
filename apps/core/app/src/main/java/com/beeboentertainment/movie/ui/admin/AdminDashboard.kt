package com.beeboentertainment.movie.ui.admin

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.DashboardText
import com.beeboentertainment.movie.data.AdminDashboardResponse
import com.beeboentertainment.movie.data.DashboardDay
import com.beeboentertainment.movie.data.DashboardNowPlaying
import com.beeboentertainment.movie.ui.LoadingBox
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The PC's server dashboard on the phone: Now playing (with the owner's stop button), bandwidth,
 * activity, library and server health. Same data as the desktop app's Dashboard tab.
 *
 * The live half (now, bandwidth, health) is polled every 3 s and the heavy half (activity,
 * library) every 60 s, both only while the app is on screen.
 */
@Composable
internal fun AdminDashboardTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    var live by remember { mutableStateOf<AdminDashboardResponse?>(null) }
    var slow by remember { mutableStateOf<AdminDashboardResponse?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var days by remember { mutableStateOf(7) }
    var reloadKey by remember { mutableStateOf(0) }
    var confirmStop by remember { mutableStateOf<DashboardNowPlaying?>(null) }

    LaunchedEffect(reloadKey) {
        var signedOut = false
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if (signedOut) return@repeatOnLifecycle
            while (true) {
                try {
                    live = app.api.adminDashboard(listOf("now", "bandwidth", "health"))
                    error = null
                } catch (t: Throwable) {
                    if (isSessionFailure(t)) { signedOut = true; onUnauthorized(); return@repeatOnLifecycle }
                    error = adminErrorMessage(t)
                }
                delay(3_000)
            }
        }
    }
    LaunchedEffect(reloadKey, days) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                runCatching { app.api.adminDashboard(listOf("activity", "library"), days) }
                    .onSuccess { slow = it }
                delay(60_000)
            }
        }
    }

    confirmStop?.let { row ->
        AdminConfirmDialog(
            title = "Stop this stream?",
            message = "${row.user}'s player stops showing \"${row.title}\" and can't restart it for a few minutes.",
            confirmLabel = "Stop stream",
            onConfirm = {
                scope.launch {
                    notice = try {
                        val r = app.api.adminStopStream(row.streamId ?: "")
                        if (r.ok) "Stream stopped." else "That stream had already ended."
                    } catch (t: Throwable) {
                        adminErrorMessage(t)
                    }
                }
            },
            onDismiss = { confirmStop = null }
        )
    }

    val data = live
    if (data == null) {
        if (error != null) AdminErrorPanel(error!!) { reloadKey++ } else LoadingBox()
        return
    }

    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Spacer(Modifier.height(4.dp)) }
        notice?.let { item { Text(it, color = MaterialTheme.colorScheme.primary, fontSize = 13.sp) } }
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) } }

        item { SectionTitle("Now playing (${data.nowPlaying?.size ?: 0})") }
        val rows = data.nowPlaying.orEmpty()
        if (rows.isEmpty()) item { Muted("Nobody is watching right now.") }
        items(rows, key = { it.id }) { row ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(row.title.ifBlank { "Unknown title" }, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Muted("${row.user} · ${row.device}")
                    Text(
                        "${DashboardText.whereIcon(row.where)} ${row.whereLabel} · " +
                            (if (row.playback == "transcode") "Converting while playing" else "Direct play") +
                            " · ${DashboardText.bitrate(row.currentBitsPerSec)}" + if (row.paused) " · paused" else "",
                        fontSize = 12.sp
                    )
                    if (row.durationSeconds > 0) {
                        Spacer(Modifier.height(6.dp))
                        LinearProgressIndicator(progress = { (row.progress ?: 0.0).toFloat() }, modifier = Modifier.fillMaxWidth())
                        Muted("${DashboardText.clock(row.positionSeconds)} of ${DashboardText.clock(row.durationSeconds)}")
                    }
                    if (data.canStopStreams && row.stoppable && row.streamId != null) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            TextButton(onClick = { confirmStop = row }) { Text("Stop this stream", color = MaterialTheme.colorScheme.error) }
                        }
                    }
                }
            }
        }

        data.bandwidth?.let { bw ->
            item { SectionTitle("Bandwidth") }
            item {
                TileRow(
                    Triple("Sending now", DashboardText.bitrate(bw.currentBitsPerSec), "${bw.streams.size} streams"),
                    Triple("Peak today", DashboardText.bitrate(bw.peakTodayBytesPerSec * 8), ""),
                    Triple("Sent today", adminFormatBytes(bw.sentTodayBytes), "video")
                )
            }
        }

        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SectionTitle("Activity")
                Spacer(Modifier.weight(1f))
                listOf(7, 30).forEach { d ->
                    FilterChip(selected = days == d, onClick = { days = d }, label = { Text("$d days") }, modifier = Modifier.padding(start = 6.dp))
                }
            }
        }
        val act = slow?.activity
        if (act == null) item { Muted("Loading…") } else {
            item {
                TileRow(
                    Triple("Plays", act.totals.plays.toString(), "last ${act.days} days"),
                    Triple("Watch time", DashboardText.duration(act.totals.seconds), "everyone")
                )
            }
            item { DayBars(act.daily) }
            item { Text("Top titles", fontWeight = FontWeight.SemiBold) }
            if (act.topTitles.isEmpty()) item { Muted("Nothing watched in this period yet.") }
            val maxPlays = act.topTitles.maxOfOrNull { it.plays }?.coerceAtLeast(1) ?: 1
            items(act.topTitles) { t ->
                RankRow(t.title, "${t.plays} plays · ${DashboardText.duration(t.seconds)}", t.plays.toFloat() / maxPlays)
            }
            item { Text("Watch time per member", fontWeight = FontWeight.SemiBold) }
            val maxSecs = act.watchTimeByMember.maxOfOrNull { it.seconds }?.coerceAtLeast(1) ?: 1
            items(act.watchTimeByMember) { m ->
                RankRow(m.name, "${DashboardText.duration(m.seconds)} · ${m.plays} plays", m.seconds.toFloat() / maxSecs)
            }
        }

        val lib = slow?.library
        item { SectionTitle("Library") }
        if (lib == null) item { Muted("Loading…") } else {
            item {
                TileRow(
                    Triple("Movies", lib.counts.movies.toString(), ""),
                    Triple("Shows", lib.counts.shows.toString(), "${lib.counts.episodes} episodes"),
                    Triple("Missing posters", ((lib.missingPosters?.movies ?: 0) + (lib.missingPosters?.shows ?: 0)).toString(), "")
                )
            }
            if (lib.counts.extra.isNotEmpty()) {
                item { TileRow(*lib.counts.extra.take(3).map { Triple(it.label, it.count.toString(), "") }.toTypedArray()) }
            }
            item {
                val c = lib.converter
                TileRow(
                    Triple("Converter", if (c.converting > 0) "Converting" else if (c.queued > 0) "${c.queued} waiting" else "Idle", c.current?.title ?: "${c.done} done · ${c.failed} failed"),
                    Triple("Beebo Inbox", "${lib.inbox?.sortedToday ?: 0} today", lib.inbox?.problem?.ifBlank { null } ?: "${lib.inbox?.needsLook ?: 0} need a look")
                )
            }
            items(lib.storage.disks) { d ->
                Column {
                    Text("Disk ${d.disk}: ${adminFormatBytes(d.freeBytes)} free of ${adminFormatBytes(d.totalBytes)}", fontSize = 13.sp)
                    LinearProgressIndicator(progress = { if (d.totalBytes > 0) d.usedBytes.toFloat() / d.totalBytes else 0f }, modifier = Modifier.fillMaxWidth())
                }
            }
            items(lib.storage.folders) { f -> Muted("${f.dir}: ${adminFormatBytes(f.usedBytes)} in ${f.files} files") }
            if (lib.recentlyAdded.isNotEmpty()) {
                item { Text("Recently added", fontWeight = FontWeight.SemiBold) }
                items(lib.recentlyAdded) { r -> Muted("${r.title} · ${DashboardText.ago(r.addedAt)}") }
            }
        }

        data.health?.let { h ->
            item { SectionTitle("Server health") }
            item {
                TileRow(
                    Triple("Beebo CPU", h.cpuPercent?.let { "${it}%" } ?: "…", ""),
                    Triple("Memory", adminFormatBytes(h.memoryBytes), ""),
                    Triple("Running for", DashboardText.duration(h.uptimeSeconds), "")
                )
            }
            item {
                TileRow(
                    Triple("Version", h.versions.app.ifBlank { "—" }, h.update?.let { if (it.available) "Update: ${it.latest}" else "Up to date" } ?: ""),
                    Triple("Away from home", if (!h.away.registered) "Not set up" else if (h.away.online == true) "Online" else "Offline", h.away.address),
                    Triple("Relay this month", adminFormatBytes(h.relay.totalBytes), "")
                )
            }
            item {
                TileRow(
                    Triple("Last backup", DashboardText.ago(h.lastBackupAt), ""),
                    Triple("Problems (24 h)", h.errors24h.count.toString(), h.errors24h.recent.firstOrNull()?.message ?: "")
                )
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun Muted(text: String) {
    Text(text, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
}

@Composable
private fun TileRow(vararg tiles: Triple<String, String, String>) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        tiles.forEach { (label, value, detail) ->
            AdminStatCard(label = label, value = value, detail = detail.ifBlank { null }, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun RankRow(label: String, detail: String, fraction: Float) {
    Column(Modifier.fillMaxWidth()) {
        Row {
            Text(label, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LinearProgressIndicator(progress = { fraction.coerceIn(0.02f, 1f) }, modifier = Modifier.fillMaxWidth())
    }
}

/** Plays per day as simple bars (one series, one colour). */
@Composable
private fun DayBars(daily: List<DashboardDay>) {
    val max = (daily.maxOfOrNull { it.plays } ?: 0).coerceAtLeast(1)
    Row(
        Modifier.fillMaxWidth().height(90.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.Bottom
    ) {
        daily.forEach { d ->
            Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.BottomCenter) {
                if (d.plays > 0) {
                    Box(
                        Modifier
                            .width(10.dp)
                            .fillMaxHeight(d.plays.toFloat() / max)
                            .clip(RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp))
                            .background(MaterialTheme.colorScheme.primary)
                    )
                }
            }
        }
    }
    Muted("Plays per day, ${daily.firstOrNull()?.day ?: ""} to ${daily.lastOrNull()?.day ?: ""}")
}
