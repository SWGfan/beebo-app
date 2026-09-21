package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.core.formatBytes
import com.beeboentertainment.movie.data.Episode
import com.beeboentertainment.movie.downloads.NetworkMonitor
import com.beeboentertainment.movie.downloads.SeasonQueue
import com.beeboentertainment.movie.downloads.SpaceCheck
import com.beeboentertainment.movie.downloads.StorageReclaim

/** "Download only on Wi-Fi" switch. Used on the Downloads screen and in Settings. */
@Composable
fun DownloadWifiOnlySetting(modifier: Modifier = Modifier) {
    val settings = BeeboApp.instance.downloads.settings
    val wifiOnly by settings.wifiOnly.collectAsState()
    Row(
        modifier
            .fillMaxWidth()
            .clickable { settings.setWifiOnly(!wifiOnly) }
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text("Download only on Wi-Fi", style = MaterialTheme.typography.bodyLarge)
            Text(
                "Downloads wait on mobile data or a metered network, and carry on by themselves on Wi-Fi.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = wifiOnly, onCheckedChange = { settings.setWifiOnly(it) })
    }
}

/** The one-time note for people who had the app before the Wi-Fi rule existed. */
@Composable
fun DownloadWifiOnlyNotice(modifier: Modifier = Modifier) {
    val settings = BeeboApp.instance.downloads.settings
    val show by settings.showNotice.collectAsState()
    if (!show) return
    Card(
        modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text("Downloads now wait for Wi-Fi", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            Text(
                "To save your mobile data, new downloads start on Wi-Fi. You can turn this off below, " +
                    "or tap \"Download now using mobile data\" on a single download.",
                fontSize = 12.sp
            )
            TextButton(onClick = { settings.dismissNotice() }, modifier = Modifier.align(Alignment.End)) {
                Text("Got it")
            }
        }
    }
}

/**
 * Confirmation for "Download season" / "Download show": how many episodes, the total size when
 * the server reports sizes, a free-space warning, and "Only unwatched episodes".
 *
 * @param episodes the season's (or show's) episodes, already in watching order
 * @param scopeLabel "Season 2", "Unsorted" or the show's name
 */
@Composable
fun BatchDownloadDialog(
    showKey: String,
    showName: String?,
    posterPath: String?,
    scopeLabel: String,
    episodes: List<Episode>,
    onDismiss: () -> Unit
) {
    val app = BeeboApp.instance
    val repo = app.downloads
    val items by repo.items.collectAsState()
    val wifiOnly by repo.settings.wifiOnly.collectAsState()
    val net by NetworkMonitor.state.collectAsState()
    var onlyUnwatched by remember { mutableStateOf(false) }

    val existing = remember(items) { items.associateBy { it.id } }
    val offerUnwatched = remember(episodes) { SeasonQueue.offerUnwatchedOption(episodes) }
    val toQueue = SeasonQueue.candidates(episodes, existing, onlyUnwatched && offerUnwatched)
    val free = remember { repo.freeSpaceOnDisk() }
    val estimate = SpaceCheck.estimate(
        sizes = toQueue.map { it.size },
        freeBytes = free,
        committedBytes = SpaceCheck.committedBytes(items),
        fallbackPerItem = SpaceCheck.fallbackEpisodeSize(items, showKey)
    )
    val n = toQueue.size
    val plural = if (n == 1) "episode" else "episodes"
    // Offered only once the batch genuinely doesn't fit — never suggested pre-emptively.
    val reclaimPlan = remember(items, estimate.fits, estimate.shortByBytes) {
        if (estimate.fits == false) StorageReclaim.plan(items, estimate.shortByBytes) else null
    }
    var useReclaim by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (n == 0) "Nothing new to download" else "Download $scopeLabel?") },
        text = {
            Column {
                if (n == 0) {
                    Text(
                        if (onlyUnwatched) "Every unwatched episode of $scopeLabel is already downloaded or queued."
                        else "Every episode of $scopeLabel is already downloaded or queued."
                    )
                } else {
                    Text(
                        buildString {
                            append("$n $plural")
                            estimate.serverTotalBytes?.let { append(" · ${formatBytes(it)}") }
                            append(", downloaded one after another in episode order.")
                        }
                    )
                    val skipped = episodes.size - n
                    if (skipped > 0) {
                        Text(
                            "$skipped already on this phone, queued or left out.",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "${formatBytes(free)} free on this phone.",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    if (estimate.fits == false) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "This probably won't fit: about ${formatBytes(estimate.shortByBytes)} more space is needed. " +
                                "Downloads stop when the phone runs out of room.",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.error
                        )
                        if (reclaimPlan != null && reclaimPlan.candidates.isNotEmpty()) {
                            val count = reclaimPlan.candidates.size
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable { useReclaim = !useReclaim }
                                    .padding(top = 6.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Checkbox(checked = useReclaim, onCheckedChange = { useReclaim = it })
                                Column {
                                    Text(
                                        "Free up space first (${formatBytes(reclaimPlan.freesBytes)})",
                                        fontSize = 13.sp
                                    )
                                    Text(
                                        "Removes $count already-played download${if (count == 1) "" else "s"}, oldest first" +
                                            if (!reclaimPlan.coversShortfall) " — still might not be quite enough" else "",
                                        fontSize = 12.sp,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    }
                    if (wifiOnly && net.connected && !net.unmetered) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "You're on mobile data, so these will wait for Wi-Fi.",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
                if (offerUnwatched) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { onlyUnwatched = !onlyUnwatched }
                            .padding(top = 6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Checkbox(checked = onlyUnwatched, onCheckedChange = { onlyUnwatched = it })
                        Text("Only unwatched episodes")
                    }
                }
            }
        },
        confirmButton = {
            if (n > 0) {
                TextButton(onClick = {
                    if (useReclaim && reclaimPlan != null) repo.deleteForReclaim(reclaimPlan)
                    val records = SeasonQueue.records(
                        episodes = toQueue,
                        existing = existing,
                        showKey = showKey,
                        showName = showName,
                        posterUrl = UrlUtils.join(app.session.baseUrl, posterPath),
                        afterSeq = repo.lastQueueSeq()
                    ) { ep -> UrlUtils.join(app.session.baseUrl, ep.stream) }
                    repo.enqueueAll(records)
                    onDismiss()
                }) {
                    Text(
                        when {
                            useReclaim -> "Free up space & download"
                            estimate.fits == false -> "Download anyway"
                            else -> "Download $n"
                        }
                    )
                }
            } else {
                TextButton(onClick = onDismiss) { Text("OK") }
            }
        },
        dismissButton = {
            if (n > 0) TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}
