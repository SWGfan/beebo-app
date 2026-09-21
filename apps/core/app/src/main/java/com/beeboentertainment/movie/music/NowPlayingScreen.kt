package com.beeboentertainment.movie.music

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.beeboentertainment.movie.ui.EmptyBox

/**
 * Now Playing: the cover, the song, a seek bar, previous / play / next, shuffle and repeat, and
 * two panels behind the cover - the lyrics (highlighted line by line when the song has timed
 * lyrics, tap a line to jump there) and the queue (tap to jump, ✕ to remove).
 */
@Composable
fun NowPlayingScreen(onOpenAlbum: (String) -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    val s by MusicPlayer.state.collectAsState()
    var panel by remember { mutableStateOf("cover") }
    var showSleepTimer by remember { mutableStateOf(false) }

    if (!s.hasSong) {
        EmptyBox("Nothing playing. Pick an album or a song in Browse → Music.")
        return
    }
    val meta = s.current?.mediaMetadata
    val trackId = s.trackId
    val albumId = s.current?.mediaMetadata?.extras?.getString(MusicMedia.EXTRA_ALBUM_ID)
    val hasLyrics = s.current?.mediaMetadata?.extras?.getBoolean(MusicMedia.EXTRA_HAS_LYRICS) ?: false

    Column(Modifier.fillMaxSize().padding(horizontal = 14.dp)) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            when (panel) {
                "lyrics" -> LyricsPanel(trackId, s.positionMs) { MusicPlayer.seekTo(it) }
                "queue" -> QueuePanel(s)
                else -> Box(
                    Modifier
                        .fillMaxWidth(0.9f)
                        .aspectRatio(1f)
                        .clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant),
                    contentAlignment = Alignment.Center
                ) {
                    val art = meta?.artworkUri?.toString()
                    if (art != null) AsyncImage(model = art, contentDescription = null, modifier = Modifier.fillMaxSize())
                    else Icon(Icons.Filled.MusicNote, contentDescription = null, modifier = Modifier.size(64.dp))
                }
            }
        }

        Text(
            meta?.title?.toString().orEmpty(),
            style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 10.dp)
        )
        Text(
            listOfNotNull(meta?.artist?.toString(), meta?.albumTitle?.toString()).joinToString(" · "),
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .clip(RoundedCornerShape(4.dp))
                .clickable(enabled = albumId != null) { albumId?.let(onOpenAlbum) }
        )

        // Seek bar. While a finger is on it the bar follows the finger, not the player.
        var dragging by remember { mutableStateOf<Float?>(null) }
        val duration = s.durationMs.coerceAtLeast(0L)
        val position = dragging?.toLong() ?: s.positionMs
        Slider(
            value = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f,
            onValueChange = { if (duration > 0) dragging = it * duration },
            onValueChangeFinished = { dragging?.let { MusicPlayer.seekTo(it.toLong()) }; dragging = null },
            enabled = duration > 0,
            modifier = Modifier.fillMaxWidth()
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(MusicQueueLogic.formatDuration(position / 1000.0), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(MusicQueueLogic.formatDuration(duration / 1000.0), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { MusicPlayer.toggleShuffle() }) {
                Icon(
                    Icons.Filled.Shuffle, contentDescription = if (s.shuffle) "Shuffle on" else "Shuffle off",
                    tint = if (s.shuffle) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            IconButton(onClick = { MusicPlayer.previous() }) { Icon(Icons.Filled.SkipPrevious, contentDescription = "Previous song", modifier = Modifier.size(36.dp)) }
            IconButton(onClick = { MusicPlayer.togglePlay() }) {
                Icon(
                    if (s.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (s.isPlaying) "Pause" else "Play",
                    modifier = Modifier.size(48.dp),
                    tint = MaterialTheme.colorScheme.primary
                )
            }
            IconButton(onClick = { MusicPlayer.next() }, enabled = s.upNext.isNotEmpty()) {
                Icon(Icons.Filled.SkipNext, contentDescription = "Next song", modifier = Modifier.size(36.dp))
            }
            IconButton(onClick = { MusicPlayer.cycleRepeat() }) {
                Icon(
                    if (s.repeat == MusicQueueLogic.Repeat.ONE) Icons.Filled.RepeatOne else Icons.Filled.Repeat,
                    contentDescription = when (s.repeat) {
                        MusicQueueLogic.Repeat.OFF -> "Repeat off"
                        MusicQueueLogic.Repeat.ALL -> "Repeat the queue"
                        MusicQueueLogic.Repeat.ONE -> "Repeat this song"
                    },
                    tint = if (s.repeat == MusicQueueLogic.Repeat.OFF) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary
                )
            }
        }
        Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), horizontalArrangement = Arrangement.Center) {
            TextButton(onClick = { panel = if (panel == "lyrics") "cover" else "lyrics" }, enabled = hasLyrics) {
                Icon(Icons.Filled.Subtitles, contentDescription = null); Spacer(Modifier.width(6.dp))
                Text(if (hasLyrics) "Lyrics" else "No lyrics")
            }
            TextButton(onClick = { panel = if (panel == "queue") "cover" else "queue" }) {
                Icon(Icons.AutoMirrored.Filled.QueueMusic, contentDescription = null); Spacer(Modifier.width(6.dp))
                Text("Queue (${s.upNext.size})")
            }
            TextButton(onClick = { showSleepTimer = true }) {
                Icon(
                    Icons.Filled.Bedtime, contentDescription = null,
                    tint = if (s.sleepTimerLabel != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.width(6.dp))
                Text(s.sleepTimerLabel ?: "Sleep timer")
            }
        }
        val error = s.error
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
    }
    if (showSleepTimer) SleepTimerDialog(active = s.sleepTimer, onDismiss = { showSleepTimer = false })
}

/**
 * Pick how long until the music stops, or turn an active timer off. Not a single-choice list
 * (there is nothing to leave selected once a countdown is running - see [MusicSleepTimer]'s own
 * label for that), so plain rows rather than radio buttons.
 */
@Composable
private fun SleepTimerDialog(active: MusicSleepTimerState, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        title = { Text("Sleep timer") },
        text = {
            Column {
                if (active != MusicSleepTimerState.Off) {
                    Text(
                        "Currently: " + (MusicPlayer.state.value.sleepTimerLabel ?: ""),
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )
                }
                MusicSleepTimer.DURATIONS_MINUTES.forEach { minutes ->
                    SleepTimerRow("$minutes minutes") { MusicPlayer.startSleepTimer(minutes); onDismiss() }
                }
                SleepTimerRow("End of track") { MusicPlayer.startSleepTimerAtEndOfTrack(); onDismiss() }
                if (active != MusicSleepTimerState.Off) {
                    SleepTimerRow("Turn off") { MusicPlayer.cancelSleepTimer(); onDismiss() }
                }
            }
        }
    )
}

@Composable
private fun SleepTimerRow(label: String, onClick: () -> Unit) {
    Text(
        label,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp)
    )
}

@Composable
private fun LyricsPanel(trackId: String?, positionMs: Long, onSeek: (Long) -> Unit) {
    val client = remember { MusicClient.get() }
    var lyrics by remember(trackId) { mutableStateOf<LrcParser.Lyrics?>(null) }
    var failed by remember(trackId) { mutableStateOf(false) }
    LaunchedEffect(trackId) {
        if (trackId == null) return@LaunchedEffect
        val answer = runCatching { client.lyrics(trackId).lyrics }.getOrElse { failed = true; null }
        lyrics = answer?.let { LrcParser.parse(it.lrc ?: it.text) }
    }
    val l = lyrics
    when {
        failed && l == null -> EmptyBox("Couldn't fetch the lyrics.")
        l == null -> EmptyBox("Looking for lyrics…")
        l.lines.isEmpty() && l.text.isBlank() -> EmptyBox("No lyrics saved with this song.")
        !l.synced -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 12.dp)) {
            item { Text(l.text, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(), lineHeight = 26.sp) }
        }
        else -> {
            val active = LrcParser.activeIndex(l.lines, positionMs)
            val state = rememberLazyListState()
            LaunchedEffect(active) {
                if (active >= 0) runCatching { state.animateScrollToItem(maxOf(0, active - 2)) }
            }
            LazyColumn(Modifier.fillMaxSize(), state = state, contentPadding = PaddingValues(vertical = 40.dp)) {
                itemsIndexed(l.lines) { i, line ->
                    val on = i == active
                    Text(
                        line.text.ifBlank { "♪" },
                        textAlign = TextAlign.Center,
                        fontSize = if (on) 20.sp else 16.sp,
                        fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
                        color = if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        lineHeight = 30.sp,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onSeek(line.timeMs) }
                            .padding(vertical = 4.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun QueuePanel(s: MusicPlayer.State) {
    if (s.upNext.isEmpty()) {
        EmptyBox("Nothing else queued.")
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
        itemsIndexed(s.upNext, key = { _, e -> e.index }) { _, entry ->
            val meta = entry.item.mediaMetadata
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { MusicPlayer.jumpTo(entry.index) }
                    .padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(Modifier.size(38.dp).clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.surfaceVariant)) {
                    val art = meta.artworkUri?.toString()
                    if (art != null) AsyncImage(model = art, contentDescription = null, modifier = Modifier.fillMaxSize())
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(meta.title?.toString().orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(meta.artist?.toString().orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = { MusicPlayer.remove(entry.index) }) {
                    Icon(Icons.Filled.Close, contentDescription = "Remove from the queue", tint = Color.Unspecified)
                }
            }
        }
    }
}
