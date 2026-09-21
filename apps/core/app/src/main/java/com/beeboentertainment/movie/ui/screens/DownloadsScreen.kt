package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.TvFeatures
import com.beeboentertainment.movie.core.formatBytes
import com.beeboentertainment.movie.downloads.DownloadGroup
import com.beeboentertainment.movie.downloads.DownloadGroups
import com.beeboentertainment.movie.downloads.DownloadIndex
import com.beeboentertainment.movie.downloads.DownloadRecord
import com.beeboentertainment.movie.downloads.DownloadStatus
import com.beeboentertainment.movie.downloads.NetDecision
import com.beeboentertainment.movie.downloads.NetworkMonitor
import com.beeboentertainment.movie.downloads.NetworkPolicy
import com.beeboentertainment.movie.downloads.SpeedMeter
import com.beeboentertainment.movie.player.PlayerActivity
import com.beeboentertainment.movie.ui.ConfirmDialog
import com.beeboentertainment.movie.ui.tv.LocalIsTv
import com.beeboentertainment.movie.ui.tv.NotAvailableOnTv

/**
 * Downloads: everything on the phone, with size, live progress, retry and delete. Episodes are
 * grouped by show and season, and a season still downloading can be cancelled in one go.
 * A completed item plays straight off local storage with no network involved.
 */
@Composable
fun DownloadsScreen() {
    // Every entry point is hidden on a TV; this catches a saved Library section or a stray link.
    if (TvFeatures.downloadsAvailable(LocalIsTv.current)) DownloadsList() else NotAvailableOnTv("Downloads")
}

@Composable
private fun DownloadsList() {
    val app = BeeboApp.instance
    val context = LocalContext.current
    val items by app.downloads.items.collectAsState()
    val net by NetworkMonitor.state.collectAsState()
    val wifiOnly by app.downloads.settings.wifiOnly.collectAsState()
    /** The row whose action is awaiting confirmation, with the action it will perform. */
    var pending by remember { mutableStateOf<Pair<DownloadRecord, DownloadIndex.TapAction>?>(null) }
    /** True while the "delete everything" confirmation is showing. */
    var confirmDeleteAll by remember { mutableStateOf(false) }
    /** The season whose "Cancel season" is awaiting confirmation. */
    var cancelGroup by remember { mutableStateOf<DownloadGroup?>(null) }
    val groups = remember(items) { DownloadGroups.group(items) }

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            DownloadWifiOnlyNotice(Modifier.padding(bottom = 4.dp))
            DownloadWifiOnlySetting()
        }
        if (items.isEmpty()) {
            Text(
                "No downloads yet.\nTap the download icon on a movie or episode, or \"Download season\" on a show, to keep it on this phone.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(24.dp)
            )
            return@Column
        }
        val completed = items.count { it.isComplete }
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 6.dp, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "$completed downloaded · ${formatBytes(app.downloads.totalBytesOnDisk())} on this phone" +
                    " · ${formatBytes(app.downloads.freeSpaceOnDisk())} free",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f)
            )
            // Only offer "Delete all" once something is actually finished downloading.
            if (completed > 0) {
                TextButton(onClick = { confirmDeleteAll = true }) {
                    Icon(Icons.Filled.Delete, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.size(3.dp))
                    Text("Delete all", fontSize = 12.sp)
                }
            }
        }
        LazyColumn(Modifier.fillMaxSize()) {
            groups.forEach { group ->
                if (group.isSeason) {
                    item(key = "g-${group.key}") {
                        SeasonHeader(group, onCancel = { cancelGroup = group })
                    }
                }
                items(group.items, key = { it.id }) { record ->
                    DownloadRow(
                        record = record,
                        decision = NetworkPolicy.decide(net, wifiOnly, record),
                        // Inside a season block the show and season are already in the header.
                        compactTitle = group.isSeason,
                        onPlay = {
                            val path = app.downloads.localPath(record.id)
                            if (path != null) app.downloads.markPlayed(record.id)
                            context.startActivity(
                                PlayerActivity.intentFor(
                                    context,
                                    itemId = record.id,
                                    kind = record.kind,
                                    title = record.title,
                                    // no streamUrl for offline playback: keeps the player off the network
                                    streamUrl = if (path == null) record.streamUrl else null,
                                    localPath = path,
                                    posterUrl = record.posterUrl,
                                    showKey = record.showKey
                                )
                            )
                        },
                        onUseMobileData = { app.downloads.allowMobileData(record.id) },
                        // A paused download carries on with no questions asked: the user already chose it.
                        onRetry = {
                            if (record.error == DownloadIndex.PAUSED_NOTE) {
                                app.downloads.enqueue(record.id, record.kind, record.title, record.streamUrl, record.posterUrl)
                            } else {
                                pending = record to DownloadIndex.TapAction.START
                            }
                        },
                        onPause = { app.downloads.pause(record.id) },
                        onStop = { pending = record to DownloadIndex.TapAction.STOP },
                        onDelete = { pending = record to DownloadIndex.TapAction.DELETE }
                    )
                }
            }
        }
    }

    val confirm = pending
    if (confirm != null) {
        val (record, action) = confirm
        ConfirmDialog(
            title = DownloadIndex.confirmTitle(action),
            message = DownloadIndex.confirmMessage(action, record.title),
            confirmLabel = DownloadIndex.confirmButton(action),
            onConfirm = {
                when (action) {
                    // Aborts the transfer, bins the .part, drops the row. Other downloads
                    // in the queue are untouched.
                    DownloadIndex.TapAction.STOP -> app.downloads.stop(record.id)
                    DownloadIndex.TapAction.DELETE -> app.downloads.delete(record.id)
                    DownloadIndex.TapAction.START -> app.downloads.enqueue(
                        record.id, record.kind, record.title, record.streamUrl, record.posterUrl
                    )
                }
            },
            onDismiss = { pending = null }
        )
    }

    val group = cancelGroup
    if (group != null && group.showKey != null) {
        val n = group.stoppableIds.size
        ConfirmDialog(
            title = "Cancel season?",
            message = "Stop the $n ${if (n == 1) "episode" else "episodes"} of ${group.title} still queued or " +
                "downloading? Episodes already downloaded stay on this phone.",
            confirmLabel = "Cancel season",
            onConfirm = { app.downloads.stopGroup(group.showKey, group.season) },
            onDismiss = { cancelGroup = null }
        )
    }

    if (confirmDeleteAll) {
        val count = items.count { it.isComplete }
        ConfirmDialog(
            title = "Delete all downloads?",
            message = "This removes $count download${if (count == 1) "" else "s"} " +
                "(${formatBytes(app.downloads.totalBytesOnDisk())}) from this phone. This can't be undone.",
            confirmLabel = "Delete all",
            onConfirm = { app.downloads.deleteAll() },
            onDismiss = { confirmDeleteAll = false }
        )
    }
}

@Composable
private fun SeasonHeader(group: DownloadGroup, onCancel: () -> Unit) {
    val done = group.items.count { it.isComplete }
    val stoppable = group.stoppableIds.size
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 10.dp)
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.10f))
            .padding(start = 16.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                group.title,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary
            )
            Text(
                "$done of ${group.items.size} downloaded" + if (stoppable > 0) " · $stoppable to go" else "",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        if (stoppable > 0) {
            TextButton(onClick = onCancel) {
                Icon(Icons.Filled.Close, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.size(3.dp))
                Text("Cancel season", fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun DownloadRow(
    record: DownloadRecord,
    decision: NetDecision,
    compactTitle: Boolean,
    onPlay: () -> Unit,
    onUseMobileData: () -> Unit,
    onRetry: () -> Unit,
    onPause: () -> Unit,
    onStop: () -> Unit,
    onDelete: () -> Unit
) {
    val stoppable = DownloadIndex.canStop(record)
    val userPaused = record.statusEnum == DownloadStatus.FAILED && record.error == DownloadIndex.PAUSED_NOTE
    Card(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp)
            // A tap on a row that is mid-transfer used to restart it. Now only a finished row
            // is tappable, and everything else is driven by the explicit buttons.
            .clickable(enabled = record.isComplete) { onPlay() }
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    if (compactTitle && record.episode != null && record.season != null &&
                        !record.title.contains("S${record.season}E${record.episode}")
                    ) "Episode ${record.episode} · ${record.title}" else record.title,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium
                )
                Spacer(Modifier.height(3.dp))
                val sub = MaterialTheme.colorScheme.onSurfaceVariant
                val soFar = if (record.bytesDownloaded > 0 && record.totalBytes > 0)
                    " · ${formatBytes(record.bytesDownloaded)} of ${formatBytes(record.totalBytes)}" else ""
                when (record.statusEnum) {
                    DownloadStatus.COMPLETE -> Text(
                        "Ready offline · ${formatBytes(record.totalBytes)}",
                        fontSize = 12.sp,
                        color = sub
                    )
                    DownloadStatus.QUEUED -> when (decision) {
                        NetDecision.WAIT_FOR_WIFI -> {
                            Text("Waiting for Wi-Fi$soFar", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                            TextButton(
                                onClick = onUseMobileData,
                                contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)
                            ) { Text("Download now using mobile data", fontSize = 12.sp) }
                        }
                        NetDecision.WAIT_FOR_NETWORK ->
                            Text("Waiting for a connection$soFar", fontSize = 12.sp, color = sub)
                        NetDecision.ALLOW -> Text(
                            record.error?.takeIf { it.isNotBlank() }
                                ?: ((if (record.allowMobileData) "Queued · using mobile data" else "Queued") + soFar),
                            fontSize = 12.sp,
                            color = sub
                        )
                    }
                    DownloadStatus.RUNNING -> {
                        val pct = record.percent
                        val pace = if (record.speedBps > 0) " · ${SpeedMeter.formatSpeed(record.speedBps)}" else ""
                        val eta = SpeedMeter.etaSeconds(record.totalBytes - record.bytesDownloaded, record.speedBps)
                            ?.takeIf { it > 0 }?.let { " · ${SpeedMeter.formatEta(it)} left" }.orEmpty()
                        Text(
                            if (record.totalBytes > 0)
                                "${formatBytes(record.bytesDownloaded)} of ${formatBytes(record.totalBytes)}$pace$eta"
                            else "Downloading… ${formatBytes(record.bytesDownloaded)}$pace",
                            fontSize = 12.sp,
                            color = sub
                        )
                        Spacer(Modifier.height(4.dp))
                        if (pct >= 0) {
                            LinearProgressIndicator(
                                progress = { pct / 100f },
                                modifier = Modifier.fillMaxWidth()
                            )
                        } else {
                            LinearProgressIndicator(Modifier.fillMaxWidth())
                        }
                    }
                    DownloadStatus.FAILED -> if (userPaused) Text(
                        "Paused$soFar",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.primary
                    ) else Text(
                        record.error ?: "Failed — tap to retry",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.error
                    )
                }
            }
            if (stoppable) {
                // Queued or transferring: hold it where it is, or make it stop for good.
                if (record.statusEnum == DownloadStatus.RUNNING) {
                    TextButton(onClick = onPause) {
                        Icon(Icons.Filled.Pause, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.size(3.dp))
                        Text("Pause", fontSize = 12.sp)
                    }
                }
                TextButton(onClick = onStop) {
                    Icon(Icons.Filled.Close, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.size(3.dp))
                    Text("Stop", fontSize = 12.sp)
                }
            } else {
                if (!record.isComplete) {
                    IconButton(onClick = onRetry) {
                        if (userPaused) Icon(Icons.Filled.PlayArrow, contentDescription = "Resume")
                        else Icon(Icons.Filled.Refresh, contentDescription = "Retry")
                    }
                }
                IconButton(onClick = onDelete) {
                    Icon(Icons.Filled.Delete, contentDescription = "Delete")
                }
            }
        }
    }
}
