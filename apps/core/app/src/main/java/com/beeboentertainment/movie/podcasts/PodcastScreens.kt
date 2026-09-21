package com.beeboentertainment.movie.podcasts

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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Forward30
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.audio.AudioKind
import com.beeboentertainment.movie.audio.AudioPrefs
import com.beeboentertainment.movie.audiobooks.AudiobookLogic
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.music.MusicPlayer
import com.beeboentertainment.movie.server.CoverImage
import com.beeboentertainment.movie.server.CoverUrls
import com.beeboentertainment.movie.server.SafeText
import com.beeboentertainment.movie.server.rememberServerLoad
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.tv.DpadTextField
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
private fun ShowArt(image: String?, modifier: Modifier = Modifier) =
    CoverImage(CoverUrls.external(image), Icons.Filled.Mic, modifier)

private enum class PodTab(val label: String) { NEW("New"), SHOWS("Following"), QUEUE("Queue"), FIND("Find") }

/** Starts an episode with the person's speed and the queue behind it; the caller opens the player. */
private suspend fun startEpisode(context: android.content.Context, client: PodcastClient, e: EpisodeDto): Boolean {
    val prefs = runCatching { client.prefs().prefs }.getOrDefault(PodcastPrefs())
    val queue = runCatching { client.queue().episodes }.getOrDefault(emptyList())
    return PodcastPlayer.start(context, e, PodcastLogic.upNext(e.key, queue), PodcastLogic.resumeSec(e), PodcastLogic.speedFor(prefs, e.feedId))
}

/**
 * Podcasts: what is new across the shows you follow, the shows, your queue, and finding more.
 * Episodes stream from your computer (which fetches them from the publisher); a copy can be kept
 * on the computer. Your place follows you between devices.
 */
@Composable
fun PodcastsScreen(onOpenShow: (String) -> Unit, onOpenListen: () -> Unit, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    val client = remember { PodcastClient.get() }
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    var tabName by rememberSaveable { mutableStateOf(PodTab.NEW.name) }
    val tab = PodTab.valueOf(tabName)
    var message by remember { mutableStateOf<String?>(null) }

    val play: (EpisodeDto) -> Unit = { e ->
        scope.launch {
            if (startEpisode(context, client, e)) onOpenListen() else message = "That episode has no audio the app can play."
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PodTab.values().forEach { t -> FilterChip(selected = t == tab, onClick = { tabName = t.name }, label = { Text(t.label) }) }
        }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp)) }
        when (tab) {
            PodTab.NEW -> NewTab(client, reload, { reload++ }, play, onOpenShow, onUnauthorized)
            PodTab.SHOWS -> ShowsTab(client, reload, onOpenShow, onUnauthorized) { reload++ }
            PodTab.QUEUE -> QueueTab(client, reload, { reload++ }, play, onUnauthorized)
            PodTab.FIND -> FindTab(client, onOpenShow, onUnauthorized) { reload++ }
        }
    }
}

@Composable
private fun NewTab(client: PodcastClient, reload: Int, bump: () -> Unit, play: (EpisodeDto) -> Unit, onOpenShow: (String) -> Unit, onUnauthorized: () -> Unit) {
    val latest = rememberServerLoad("latest", onUnauthorized, reload) { client.latest().episodes }
    val cont = rememberServerLoad("cont", onUnauthorized, reload) { client.continueListening().episodes }
    val subs = rememberServerLoad("subs-count", onUnauthorized, reload) { client.subscriptions().shows.size }
    when {
        latest.error != null && latest.value == null -> ErrorBox(latest.error, onRetry = bump)
        latest.value == null -> LoadingBox()
        latest.value.isEmpty() && cont.value.orEmpty().isEmpty() ->
            EmptyBox(if ((subs.value ?: 0) == 0) "You aren't following any shows yet. Use Find to search, or paste a show's feed address." else "You're all caught up.")
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 12.dp)) {
            val inProgress = cont.value.orEmpty()
            if (inProgress.isNotEmpty()) {
                item { Text("Continue listening", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(12.dp)) }
                items(inProgress, key = { "c" + it.key }) { EpisodeRow(client, it, play, onOpenShow, bump, onUnauthorized) }
            }
            item { Text("New episodes", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(12.dp)) }
            items(latest.value, key = { "n" + it.key }) { EpisodeRow(client, it, play, onOpenShow, bump, onUnauthorized) }
        }
    }
}

@Composable
private fun ShowsTab(client: PodcastClient, reload: Int, onOpenShow: (String) -> Unit, onUnauthorized: () -> Unit, bump: () -> Unit) {
    val shows = rememberServerLoad("shows", onUnauthorized, reload) { client.subscriptions().shows }
    when {
        shows.error != null && shows.value == null -> ErrorBox(shows.error, onRetry = bump)
        shows.value == null -> LoadingBox()
        shows.value.isEmpty() -> EmptyBox("You aren't following any shows yet.")
        else -> LazyVerticalGrid(columns = GridCells.Adaptive(130.dp), contentPadding = PaddingValues(8.dp), modifier = Modifier.fillMaxSize()) {
            items(shows.value, key = { it.id }) { s ->
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { onOpenShow(s.id) }.padding(4.dp)) {
                    ShowArt(s.image, Modifier.fillMaxWidth().aspectRatio(1f))
                    Text(SafeText.clean(s.title, 80), maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
                    Text(PodcastLogic.unplayedLabel(s), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun QueueTab(client: PodcastClient, reload: Int, bump: () -> Unit, play: (EpisodeDto) -> Unit, onUnauthorized: () -> Unit) {
    val queue = rememberServerLoad("queue", onUnauthorized, reload) { client.queue().episodes }
    val scope = rememberCoroutineScope()
    when {
        queue.error != null && queue.value == null -> ErrorBox(queue.error, onRetry = bump)
        queue.value == null -> LoadingBox()
        queue.value.isEmpty() -> EmptyBox("Your queue is empty. Use ⋮ on an episode to add it.")
        else -> LazyColumn(Modifier.fillMaxSize()) {
            item {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                    TextButton(onClick = { scope.launch { runCatching { client.queueClear() }; bump() } }) { Text("Clear the queue") }
                }
            }
            items(queue.value, key = { it.key }) { EpisodeRow(client, it, play, null, bump, onUnauthorized) }
        }
    }
}

@Composable
private fun FindTab(client: PodcastClient, onOpenShow: (String) -> Unit, onUnauthorized: () -> Unit, bump: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var debounced by remember { mutableStateOf("") }
    LaunchedEffect(query) { delay(400); debounced = query.trim() }
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val address = PodcastLogic.feedAddressOrNull(query)
    val results = rememberServerLoad(debounced, onUnauthorized, 0) { if (debounced.length >= 2 && address == null) client.search(debounced).results else emptyList() }

    fun follow(url: String, then: (ShowDto) -> Unit = {}) {
        busy = true; message = null
        scope.launch {
            try {
                val show = client.follow(url).show
                bump()
                then(show)
            } catch (e: UnauthorizedException) { onUnauthorized() } catch (e: Exception) { message = e.message ?: "Couldn't follow that show." } finally { busy = false }
        }
    }

    Column(Modifier.fillMaxSize()) {
        DpadTextField(Modifier.fillMaxWidth().padding(horizontal = 10.dp)) { tv ->
            OutlinedTextField(
                value = query, onValueChange = { query = it.take(1000) },
                label = { Text("Search shows, or paste a feed address") },
                singleLine = true, modifier = tv.fillMaxWidth().padding(vertical = 4.dp)
            )
        }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp)) }
        if (address != null) {
            Button(enabled = !busy, onClick = { follow(address) { onOpenShow(it.id) } }, modifier = Modifier.padding(12.dp)) { Text("Follow this feed") }
            Text("Your computer fetches the feed. Only web addresses are accepted.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp))
            return@Column
        }
        val r = results.value
        when {
            debounced.length < 2 -> EmptyBox("Search by name. Results come from a public podcast directory; your computer does the searching.")
            results.error != null && r == null -> ErrorBox(results.error)
            r == null -> LoadingBox()
            r.isEmpty() -> EmptyBox("No shows found for \"${SafeText.clean(debounced, 60)}\".")
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(r, key = { it.feedUrl }) { hit ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        ShowArt(hit.artwork, Modifier.size(56.dp))
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(SafeText.clean(hit.title, 100), maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
                            Text(SafeText.clean(hit.author, 60), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (hit.subscribed && PodcastLogic.isShowId(hit.feedId)) OutlinedButton(onClick = { onOpenShow(hit.feedId) }) { Text("Open") }
                        else OutlinedButton(enabled = !busy && PodcastLogic.feedAddressOrNull(hit.feedUrl) != null, onClick = { follow(hit.feedUrl) }) { Text("Follow") }
                    }
                }
            }
        }
    }
}

/** One episode: tap to play; ⋮ for the queue, played state and a copy kept on the computer. */
@Composable
private fun EpisodeRow(client: PodcastClient, e: EpisodeDto, play: (EpisodeDto) -> Unit, onOpenShow: ((String) -> Unit)?, bump: () -> Unit, onUnauthorized: () -> Unit) {
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    val playing by MusicPlayer.state.collectAsState()
    val isCurrent = playing.kind == AudioKind.PODCAST && playing.itemId == e.key
    fun act(block: suspend () -> Unit) {
        menu = false
        scope.launch { try { block(); bump() } catch (u: UnauthorizedException) { onUnauthorized() } catch (_: Exception) { } }
    }
    Row(Modifier.fillMaxWidth().clickable { play(e) }.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        ShowArt(e.image, Modifier.size(52.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(PodcastLogic.title(e), maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = if (isCurrent || !e.played) FontWeight.SemiBold else FontWeight.Normal,
                color = if (isCurrent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            Text(listOfNotNull(SafeText.clean(e.feedTitle, 40).ifBlank { null }, PodcastLogic.subtitle(e).ifBlank { null }).joinToString(" · "), fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (e.downloaded) Text("Kept on your computer", fontSize = 11.sp, color = MaterialTheme.colorScheme.primary)
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More for this episode") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (!e.inQueue) {
                    DropdownMenuItem(text = { Text("Play next") }, onClick = { act { client.queueAdd(e.key, next = true) } })
                    DropdownMenuItem(text = { Text("Add to queue") }, onClick = { act { client.queueAdd(e.key, next = false) } })
                } else DropdownMenuItem(text = { Text("Remove from queue") }, onClick = { act { client.queueRemove(e.key) } })
                DropdownMenuItem(text = { Text(if (e.played) "Mark as not played" else "Mark as played") }, onClick = { act { client.markPlayed(e.key, !e.played) } })
                if (PodcastLogic.canDownload(e, null)) DropdownMenuItem(text = { Text("Keep a copy on my computer") }, onClick = { act { client.download(e.key) } })
                else if (e.downloaded) DropdownMenuItem(text = { Text("Remove the copy") }, onClick = { act { client.removeDownload(e.key) } })
                if (onOpenShow != null && PodcastLogic.isShowId(e.feedId)) DropdownMenuItem(text = { Text("Go to the show") }, onClick = { menu = false; onOpenShow(e.feedId) })
            }
        }
    }
}

/* =================================== Show =================================== */

@Composable
fun PodcastShowScreen(showId: String, onOpenListen: () -> Unit, onUnauthorized: () -> Unit, onLeft: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    val client = remember { PodcastClient.get() }
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    var unplayedOnly by rememberSaveable { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var confirmLeave by remember { mutableStateOf(false) }
    val loaded = rememberServerLoad(Pair(showId, unplayedOnly), onUnauthorized, reload) { client.show(showId, unplayedOnly) }
    val r = loaded.value
    val play: (EpisodeDto) -> Unit = { e -> scope.launch { if (startEpisode(context, client, e)) onOpenListen() else message = "That episode has no audio the app can play." } }
    when {
        loaded.error != null && r == null -> ErrorBox(loaded.error, onRetry = { reload++ })
        r == null -> LoadingBox()
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 12.dp)) {
            item {
                Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.Bottom) {
                    ShowArt(r.feed.image, Modifier.size(120.dp))
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(SafeText.clean(r.feed.title, 120), style = MaterialTheme.typography.titleLarge, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        Text(SafeText.clean(r.feed.author, 80), color = MaterialTheme.colorScheme.primary)
                        Text("${r.feed.episodeCount} episodes · " + PodcastLogic.unplayedLabel(r.feed), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                val desc = SafeText.htmlToText(r.feed.description, 1500)
                if (desc.isNotBlank()) Text(desc, fontSize = 13.sp, maxLines = 6, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp))
                Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { scope.launch { runCatching { client.refresh(showId) }; reload++ } }) { Text("Refresh") }
                    OutlinedButton(onClick = { confirmLeave = true }) { Text("Unfollow") }
                    Text("Unplayed only", fontSize = 12.sp)
                    Switch(checked = unplayedOnly, onCheckedChange = { unplayedOnly = it })
                }
                message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp)) }
            }
            if (r.episodes.isEmpty()) item { Text(if (r.feed.pending) "Your computer is still loading this show." else "No episodes.", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(r.episodes, key = { it.key }) { EpisodeRow(client, it, play, null, { reload++ }, onUnauthorized) }
        }
    }
    if (confirmLeave) AlertDialog(
        onDismissRequest = { confirmLeave = false },
        title = { Text("Unfollow this show?") },
        text = { Text("Your place in its episodes is forgotten. You can follow it again any time.") },
        confirmButton = { TextButton(onClick = { confirmLeave = false; scope.launch { runCatching { client.unfollow(showId) }; onLeft() } }) { Text("Unfollow") } },
        dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text("Cancel") } }
    )
}

/* ================================== Listening ================================== */

@Composable
fun PodcastListenScreen(onOpenShow: (String) -> Unit, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    val state by MusicPlayer.state.collectAsState()
    val session by PodcastPlayer.session.collectAsState()
    val sleep by PodcastPlayer.sleep.collectAsState()
    val client = remember { PodcastClient.get() }
    var showSpeed by remember { mutableStateOf(false) }
    var showSleep by remember { mutableStateOf(false) }
    var showChapters by remember { mutableStateOf(false) }
    var showNotes by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }

    // The service kept playing after the app was reopened: rebuild the session from the server.
    val playingKey = if (state.kind == AudioKind.PODCAST) state.itemId else null
    LaunchedEffect(playingKey) {
        val key = playingKey ?: return@LaunchedEffect
        if (session?.episode?.key != key) {
            try {
                val e = client.episode(key).episode
                val queue = runCatching { client.queue().episodes }.getOrDefault(emptyList())
                PodcastPlayer.attach(context, e, PodcastLogic.upNext(key, queue))
            } catch (u: UnauthorizedException) { onUnauthorized() } catch (_: Exception) { }
        }
    }
    if (state.kind != AudioKind.PODCAST || !state.hasSong) { EmptyBox("No podcast is playing. Open Podcasts and pick an episode."); return }

    val s = session
    val meta = state.current?.mediaMetadata
    val duration = (state.durationMs / 1000.0).takeIf { it > 0 } ?: (s?.episode?.durationSec ?: 0.0)
    val position = state.positionMs / 1000.0
    val chapters = s?.chapters.orEmpty()
    val chapterIndex = AudiobookLogic.chapterIndexAt(chapters, position)
    var dragging by remember { mutableStateOf<Float?>(null) }
    val shown = dragging?.let { it * duration } ?: position

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            CoverImage(meta?.artworkUri?.toString(), Icons.Filled.Mic, Modifier.fillMaxWidth(0.7f).aspectRatio(1f), corner = 12)
        }
        Text(meta?.title?.toString().orEmpty(), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
        Text(
            chapters.getOrNull(chapterIndex)?.title ?: meta?.artist?.toString().orEmpty(),
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.clip(RoundedCornerShape(4.dp)).clickable(enabled = s != null && PodcastLogic.isShowId(s.episode.feedId)) { s?.episode?.feedId?.let(onOpenShow) }
        )
        Slider(
            value = if (duration > 0) (shown / duration).toFloat().coerceIn(0f, 1f) else 0f,
            onValueChange = { if (duration > 0) dragging = it },
            onValueChangeFinished = { dragging?.let { MusicPlayer.seekTo((it * duration * 1000).toLong()) }; dragging = null },
            enabled = duration > 0, modifier = Modifier.fillMaxWidth()
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(AudiobookLogic.formatClock(shown), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("-" + AudiobookLogic.formatClock((duration - shown).coerceAtLeast(0.0)), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { PodcastPlayer.skipBack(context) }) { Icon(Icons.Filled.Replay, contentDescription = "Back ${AudioPrefs.skipBackSeconds(context)} seconds", modifier = Modifier.size(34.dp)) }
            IconButton(onClick = { if (state.isPlaying) MusicPlayer.pause() else MusicPlayer.play() }) {
                Icon(if (state.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, contentDescription = if (state.isPlaying) "Pause" else "Play", modifier = Modifier.size(52.dp), tint = MaterialTheme.colorScheme.primary)
            }
            IconButton(onClick = { PodcastPlayer.skipForward(context) }) { Icon(Icons.Filled.Forward30, contentDescription = "Forward ${AudioPrefs.skipForwardSeconds(context)} seconds", modifier = Modifier.size(34.dp)) }
        }
        Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { showSpeed = true }) { Icon(Icons.Filled.Speed, contentDescription = null); Spacer(Modifier.width(4.dp)); Text(AudiobookLogic.speedLabel(state.speed.toDouble())) }
            TextButton(onClick = { showSleep = true }) {
                Icon(Icons.Filled.Bedtime, contentDescription = null, tint = if (sleep != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(4.dp)); Text(AudiobookLogic.sleepLabel(sleep, System.currentTimeMillis(), position)?.replace("end of chapter", "end of episode") ?: "Sleep")
            }
            if (chapters.isNotEmpty()) TextButton(onClick = { showChapters = true }) { Text("Chapters") }
            TextButton(onClick = { showNotes = true }) { Text("Notes") }
        }
        val next = s?.queueAfter?.firstOrNull()
        if (next != null) Text("Up next: " + PodcastLogic.title(next), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
        note?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        state.errorText?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        LaunchedEffect(note) { if (note != null) { delay(2500); note = null } }
    }

    if (showSpeed) PodcastSpeedDialog(state.speed.toDouble(), onPick = { v, forShow -> PodcastPlayer.setSpeed(v, s?.episode?.feedId, forShow) }, onDismiss = { showSpeed = false })
    if (showSleep) AlertDialog(
        onDismissRequest = { showSleep = false },
        confirmButton = { TextButton(onClick = { showSleep = false }) { Text("Close") } },
        title = { Text("Sleep timer") },
        text = {
            Column {
                PodcastLogic.SLEEP_MINUTES.forEach { m -> Text("$m minutes", modifier = Modifier.fillMaxWidth().clickable { PodcastPlayer.sleepInMinutes(m); showSleep = false }.padding(vertical = 10.dp)) }
                Text("End of episode", modifier = Modifier.fillMaxWidth().clickable { if (!PodcastPlayer.sleepAtEpisodeEnd()) note = "This episode's length isn't known."; showSleep = false }.padding(vertical = 10.dp))
                if (sleep != null) Text("Turn off", modifier = Modifier.fillMaxWidth().clickable { PodcastPlayer.cancelSleep(); showSleep = false }.padding(vertical = 10.dp), color = MaterialTheme.colorScheme.primary)
            }
        }
    )
    if (showChapters) AlertDialog(
        onDismissRequest = { showChapters = false },
        confirmButton = { TextButton(onClick = { showChapters = false }) { Text("Close") } },
        title = { Text("Chapters") },
        text = {
            LazyColumn {
                itemsIndexed(chapters) { i, c ->
                    Row(Modifier.fillMaxWidth().clickable { PodcastPlayer.seekToChapter(i); showChapters = false }.padding(vertical = 8.dp)) {
                        Text(c.title, modifier = Modifier.weight(1f), fontWeight = if (i == chapterIndex) FontWeight.Bold else FontWeight.Normal, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(AudiobookLogic.formatClock(c.start), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    )
    if (showNotes) AlertDialog(
        onDismissRequest = { showNotes = false },
        confirmButton = { TextButton(onClick = { showNotes = false }) { Text("Close") } },
        title = { Text("Show notes") },
        text = {
            val text = s?.episode?.let { PodcastLogic.notes(it) }.orEmpty().ifBlank { "No notes for this episode." }
            LazyColumn { item { Text(text, fontSize = 14.sp) } }
        }
    )
}

@Composable
private fun PodcastSpeedDialog(current: Double, onPick: (Double, Boolean) -> Unit, onDismiss: () -> Unit) {
    var value by remember { mutableStateOf(AudiobookLogic.clampSpeed(current).toFloat()) }
    var forShow by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
        title = { Text("Speed") },
        text = {
            Column {
                Text(AudiobookLogic.speedLabel(value.toDouble()), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
                Slider(value = value, valueRange = 0.5f..3f, steps = 49, onValueChange = { value = it }, onValueChangeFinished = { onPick(AudiobookLogic.clampSpeed(value.toDouble()), forShow) })
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    listOf(0.75, 1.0, 1.25, 1.5, 2.0).forEach { p -> TextButton(onClick = { value = p.toFloat(); onPick(p, forShow) }) { Text(AudiobookLogic.speedLabel(p)) } }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = forShow, onCheckedChange = { forShow = it })
                    Spacer(Modifier.width(8.dp))
                    Text("Remember for this show", fontSize = 13.sp)
                }
            }
        }
    )
}
