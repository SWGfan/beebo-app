package com.beeboentertainment.movie.livetv

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Forward30
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay30
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.server.SafeText
import com.beeboentertainment.movie.server.ServerException
import com.beeboentertainment.movie.server.rememberServerLoad
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.tv.LocalIsTv
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.TimeZone

private enum class LiveTab(val label: String) { CHANNELS("Channels"), GUIDE("What's on") }

/**
 * Live TV: your channels (favourites first) with what is on now and next, and a simple guide grid
 * for the next few hours. Tap a channel or a programme to watch. Nothing here supplies channels or
 * guide data: it is your own antenna and tuner at home, reached through your Beebo computer.
 */
@Composable
fun LiveTvScreen(onWatch: (String) -> Unit, onUnauthorized: () -> Unit) {
    val client = remember { LiveTvClient.get() }
    var reload by remember { mutableIntStateOf(0) }
    var tabName by rememberSaveable { mutableStateOf(LiveTab.CHANNELS.name) }
    val tab = LiveTab.valueOf(tabName)
    var favouritesOnly by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var channels by remember { mutableStateOf<List<LiveChannel>?>(null) }
    var hasGuide by remember { mutableStateOf(false) }
    var refused by remember { mutableStateOf<String?>(null) }

    val loaded = rememberServerLoad("channels", onUnauthorized, reload) {
        try { client.channels() } catch (e: ServerException) {
            if (LiveTvLogic.isNotAllowed(e.code)) { refused = LiveTvLogic.message(e.code, e.message); null } else throw e
        }
    }
    LaunchedEffect(loaded.value) { loaded.value?.let { channels = it.channels; hasGuide = it.hasGuide } }

    val refusal = refused
    val all = channels
    when {
        refusal != null -> EmptyBox(refusal)
        loaded.error != null && all == null -> ErrorBox(loaded.error, onRetry = { reload++ })
        all == null -> LoadingBox()
        all.isEmpty() -> EmptyBox("No channels yet. On your Beebo computer, open Settings, Live TV, and set up your tuner.")
        else -> Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                LiveTab.values().forEach { t -> FilterChip(selected = t == tab, onClick = { tabName = t.name }, label = { Text(t.label) }) }
                FilterChip(selected = favouritesOnly, onClick = { favouritesOnly = !favouritesOnly }, label = { Text("Favourites") })
            }
            val shown = LiveTvLogic.order(all).let { if (favouritesOnly) LiveTvLogic.favouritesOnly(it) else it }
            val toggle: (LiveChannel) -> Unit = { c ->
                scope.launch {
                    try {
                        val on = !c.favourite
                        client.setFavourite(c.key, on)
                        channels = LiveTvLogic.withFavourite(channels.orEmpty(), c.key, on)
                    } catch (e: UnauthorizedException) { onUnauthorized() } catch (_: Exception) { }
                }
            }
            when {
                shown.isEmpty() -> EmptyBox(if (favouritesOnly) "No favourite channels yet. Tap the star on a channel." else "No channels.")
                tab == LiveTab.CHANNELS -> ChannelList(shown, onWatch, toggle, hasGuide)
                else -> GuideGrid(client, shown, onWatch, onUnauthorized)
            }
        }
    }
}

@Composable
private fun ChannelList(channels: List<LiveChannel>, onWatch: (String) -> Unit, toggle: (LiveChannel) -> Unit, hasGuide: Boolean) {
    val now = System.currentTimeMillis()
    val zone = remember { TimeZone.getDefault() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 12.dp)) {
        if (!hasGuide) item { Text("No guide is set up, so only channel names are shown.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp)) }
        items(channels, key = { it.key }) { c ->
            Row(Modifier.fillMaxWidth().clickable { onWatch(c.key) }.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(LiveTvLogic.numberLabel(c), modifier = Modifier.width(48.dp), fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(LiveTvLogic.channelName(c), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (c.hd) Text(" HD", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    LiveTvLogic.nowLine(c, zone)?.let {
                        Text(it, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        LinearProgressIndicator(progress = { LiveTvLogic.progress(c.now, now) }, modifier = Modifier.fillMaxWidth().padding(top = 3.dp, end = 12.dp))
                    }
                    LiveTvLogic.nextLine(c, zone)?.let { Text(it, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                IconButton(onClick = { toggle(c) }) {
                    Icon(
                        if (c.favourite) Icons.Filled.Star else Icons.Filled.StarBorder,
                        contentDescription = if (c.favourite) "Remove ${LiveTvLogic.channelName(c)} from favourites" else "Add ${LiveTvLogic.channelName(c)} to favourites",
                        tint = if (c.favourite) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

private val DP_PER_MINUTE = 4.dp
private val NAME_WIDTH = 104.dp
private val ROW_HEIGHT = 56.dp

/** A simple grid: channel names down the side, three hours across, scrolling together. Tap a programme to watch that channel. */
@Composable
private fun GuideGrid(client: LiveTvClient, channels: List<LiveChannel>, onWatch: (String) -> Unit, onUnauthorized: () -> Unit) {
    var reload by remember { mutableIntStateOf(0) }
    val guide = rememberServerLoad("guide", onUnauthorized, reload) { client.guide(hours = 3) }
    val g = guide.value
    val zone = remember { TimeZone.getDefault() }
    when {
        guide.error != null && g == null -> ErrorBox(guide.error, onRetry = { reload++ })
        g == null -> LoadingBox()
        !g.hasGuide -> EmptyBox("No guide is set up. On your Beebo computer, open Settings, Live TV, and add a guide file or address.")
        else -> {
            val rows = g.rows.associateBy { it.channel }
            val totalMin = ((g.to - g.from) / 60_000f)
            val scroll = rememberScrollState()
            val now = System.currentTimeMillis()
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                Row {
                    Spacer(Modifier.width(NAME_WIDTH))
                    Box(Modifier.horizontalScroll(scroll).width(DP_PER_MINUTE * totalMin).height(24.dp)) {
                        LiveTvLogic.timeMarks(g.from, g.to, zone).forEach { (min, label) ->
                            Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.offset(x = DP_PER_MINUTE * min))
                        }
                    }
                }
                channels.forEach { ch ->
                    val row = rows[ch.key]
                    Row(Modifier.padding(vertical = 2.dp)) {
                        Column(Modifier.width(NAME_WIDTH).height(ROW_HEIGHT).clickable { onWatch(ch.key) }.padding(horizontal = 6.dp), verticalArrangement = Arrangement.Center) {
                            Text(LiveTvLogic.numberLabel(ch), fontSize = 12.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                            Text(LiveTvLogic.channelName(ch), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Box(Modifier.horizontalScroll(scroll).width(DP_PER_MINUTE * totalMin).height(ROW_HEIGHT)) {
                            val cells = LiveTvLogic.cells(row?.programmes.orEmpty(), g.from, g.to)
                            if (cells.isEmpty()) Text("No guide for this channel", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
                            cells.forEach { cell ->
                                val onNow = now >= cell.programme.start && now < cell.programme.stop
                                Column(
                                    Modifier
                                        .offset(x = DP_PER_MINUTE * cell.offsetMin)
                                        .width((DP_PER_MINUTE * cell.lengthMin) - 2.dp)
                                        .height(ROW_HEIGHT - 4.dp)
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(if (onNow) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant)
                                        .clickable { onWatch(ch.key) }
                                        .padding(horizontal = 6.dp, vertical = 3.dp),
                                    verticalArrangement = Arrangement.Center
                                ) {
                                    Text(LiveTvLogic.titleLine(cell.programme.title, cell.programme.subTitle), fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    Text(
                                        (if (cell.cutOffLeft) "‹ " else "") + LiveTvLogic.clock(cell.programme.start, zone) + (if (cell.programme.isNew) " · New" else ""),
                                        fontSize = 10.sp, maxLines = 1, color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/* ================================== Watching ================================== */

/** Fire-and-forget: tell the computer this viewer has left, so the tuner is freed. */
private object LiveTvSessions {
    private val scope = CoroutineScope(Dispatchers.IO)
    fun stop(ticket: String) { scope.launch { runCatching { LiveTvClient.get().stop(ticket) } } }
}

private sealed class Tuning {
    object Starting : Tuning()
    data class Playing(val watch: WatchResponse, val url: String) : Tuning()
    data class Refused(val message: String, val retryable: Boolean) : Tuning()
}

/**
 * Watching live TV: the picture, a LIVE badge, pause, back and forward 30 seconds inside the rewind
 * buffer, Go live, and channel up / down. A busy tuner or a profile that may not use Live TV gets a
 * plain message instead of a black screen.
 */
@Composable
fun LiveTvWatchScreen(initialChannel: String, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    val isTv = LocalIsTv.current
    val client = remember { LiveTvClient.get() }
    val scope = rememberCoroutineScope()
    var channelKey by remember { mutableStateOf(initialChannel) }
    var attempt by remember { mutableIntStateOf(0) }
    var tuning by remember { mutableStateOf<Tuning>(Tuning.Starting) }
    var lastTicket by remember { mutableStateOf<String?>(null) }
    var channels by remember { mutableStateOf<List<LiveChannel>>(emptyList()) }
    val focus = remember { FocusRequester() }

    // Channel list (for up / down and the name), refreshed once.
    LaunchedEffect(Unit) {
        try { channels = LiveTvLogic.order(client.channels().channels) } catch (e: UnauthorizedException) { onUnauthorized() } catch (_: Exception) { }
    }
    // Tune. A change of channel lets go of the old tuner first, so a one-tuner setup can switch.
    LaunchedEffect(channelKey, attempt) {
        tuning = Tuning.Starting
        // Wait for the computer to confirm, so the tuner is free when the next channel asks for one.
        lastTicket?.let { runCatching { client.stop(it) }; lastTicket = null }
        try {
            val w = client.watch(channelKey)
            val path = LiveTvLogic.playlistPath(w)
            val url = path?.let { UrlUtils.join(BeeboApp.instance.session.baseUrl, it) }
            if (url == null) {
                if (w.ticket.isNotBlank()) LiveTvSessions.stop(w.ticket)
                tuning = Tuning.Refused("This Beebo computer sent a picture address the app can't use.", false)
            } else {
                lastTicket = w.ticket.takeIf { it.isNotBlank() }
                tuning = Tuning.Playing(w, url)
            }
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: ServerException) {
            tuning = Tuning.Refused(LiveTvLogic.message(e.code, e.message), retryable = !LiveTvLogic.isNotAllowed(e.code) && e.code != "off")
        } catch (e: Exception) {
            tuning = Tuning.Refused(e.message ?: "Live TV could not start.", true)
        }
    }
    DisposableEffect(Unit) { onDispose { lastTicket?.let { LiveTvSessions.stop(it) } } }

    val ch = channels.firstOrNull { it.key == channelKey }
    val switchBy: (Int) -> Unit = { step -> LiveTvLogic.neighbour(channels, channelKey, step)?.let { channelKey = it.key } }

    when (val t = tuning) {
        Tuning.Starting -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            androidx.compose.material3.CircularProgressIndicator()
            Spacer(Modifier.height(12.dp))
            Text("Tuning" + (ch?.let { " " + LiveTvLogic.channelName(it) } ?: "") + "…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        is Tuning.Refused -> Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text(t.message, textAlign = TextAlign.Center)
            if (t.retryable) Button(onClick = { attempt++ }, modifier = Modifier.padding(top = 12.dp)) { Text("Try again") }
        }
        is Tuning.Playing -> LivePlayer(
            watch = t.watch, url = t.url, channel = ch, focus = focus, isTv = isTv,
            onChannelStep = switchBy,
            onFavourite = { on ->
                scope.launch {
                    try { client.setFavourite(channelKey, on); channels = LiveTvLogic.withFavourite(channels, channelKey, on) } catch (e: UnauthorizedException) { onUnauthorized() } catch (_: Exception) { }
                }
            },
            onRetry = { attempt++ },
            context = context
        )
    }
}

@Composable
private fun LivePlayer(
    watch: WatchResponse, url: String, channel: LiveChannel?, focus: FocusRequester, isTv: Boolean,
    onChannelStep: (Int) -> Unit, onFavourite: (Boolean) -> Unit, onRetry: () -> Unit, context: android.content.Context,
) {
    val app = BeeboApp.instance
    val player = remember(url) {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(app.api.okHttp)))
            .build()
    }
    var playing by remember { mutableStateOf(false) }
    var buffering by remember { mutableStateOf(true) }
    var failed by remember { mutableStateOf(false) }
    var liveOffsetMs by remember { mutableStateOf<Long?>(null) }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying }
            override fun onPlaybackStateChanged(state: Int) { buffering = state == Player.STATE_BUFFERING || state == Player.STATE_IDLE }
            override fun onPlayerError(error: PlaybackException) { failed = true }
        }
        player.addListener(listener)
        player.setMediaItem(MediaItem.Builder().setUri(url).setMimeType(MimeTypes.APPLICATION_M3U8).build())
        player.prepare()
        player.playWhenReady = true
        onDispose { player.removeListener(listener); player.release() }
    }
    LaunchedEffect(player) {
        while (true) {
            liveOffsetMs = player.currentLiveOffset.takeIf { it != C.TIME_UNSET }
            delay(500)
        }
    }
    LaunchedEffect(Unit) { if (isTv) runCatching { focus.requestFocus() } }

    fun jump(deltaSec: Int) {
        val target = player.currentPosition + deltaSec * 1000L
        val start = 0L
        player.seekTo(target.coerceAtLeast(start))
    }
    fun goLive() { player.seekToDefaultPosition(); player.play() }
    fun toggle() { if (player.isPlaying) player.pause() else player.play() }

    Column(
        Modifier.fillMaxSize().onPreviewKeyEvent { e ->
            if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            when (LiveTvLogic.keyFor(e.key.nativeKeyCode)) {
                LiveTvLogic.Key.PLAY_PAUSE -> { toggle(); true }
                LiveTvLogic.Key.PLAY -> { player.play(); true }
                LiveTvLogic.Key.PAUSE -> { player.pause(); true }
                LiveTvLogic.Key.REWIND -> { jump(-LiveTvLogic.JUMP_SEC); true }
                LiveTvLogic.Key.FAST_FORWARD -> { jump(LiveTvLogic.JUMP_SEC); true }
                LiveTvLogic.Key.CHANNEL_UP -> { onChannelStep(1); true }
                LiveTvLogic.Key.CHANNEL_DOWN -> { onChannelStep(-1); true }
                LiveTvLogic.Key.GO_LIVE -> { goLive(); true }
                LiveTvLogic.Key.NONE -> false
            }
        }
    ) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(androidx.compose.ui.graphics.Color.Black)) {
            AndroidView(
                factory = { PlayerView(it).apply { useController = false; this.player = player; keepScreenOn = true } },
                update = { it.player = player },
                modifier = Modifier.fillMaxSize()
            )
            if (buffering && !failed) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { androidx.compose.material3.CircularProgressIndicator() }
            val atLive = LiveTvLogic.isAtLive(liveOffsetMs)
            Text(
                LiveTvLogic.liveBadge(liveOffsetMs),
                color = androidx.compose.ui.graphics.Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.align(Alignment.TopStart).padding(8.dp)
                    .background(if (atLive) androidx.compose.ui.graphics.Color(0xFFD32F2F) else androidx.compose.ui.graphics.Color(0xAA000000), RoundedCornerShape(4.dp))
                    .padding(horizontal = 8.dp, vertical = 2.dp)
            )
        }
        Column(Modifier.fillMaxWidth().padding(12.dp).verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
            val name = channel?.let { LiveTvLogic.numberLabel(it) + "  " + LiveTvLogic.channelName(it) } ?: SafeText.clean(watch.channel.name, 60)
            Text(name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val nowTitle = LiveTvLogic.title(channel?.now) ?: LiveTvLogic.title(watch.now)
            if (nowTitle != null) Text(nowTitle, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (failed) {
                Text("The picture stopped.", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp))
                OutlinedButton(onClick = onRetry) { Text("Try again") }
            }
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { onChannelStep(-1) }) { Icon(Icons.Filled.SkipPrevious, contentDescription = "Channel down", modifier = Modifier.size(32.dp)) }
                IconButton(onClick = { jump(-LiveTvLogic.JUMP_SEC) }) { Icon(Icons.Filled.Replay30, contentDescription = "Back 30 seconds", modifier = Modifier.size(32.dp)) }
                IconButton(onClick = { toggle() }, modifier = Modifier.focusRequester(focus)) {
                    Icon(if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, contentDescription = if (playing) "Pause" else "Play", modifier = Modifier.size(52.dp), tint = MaterialTheme.colorScheme.primary)
                }
                IconButton(onClick = { jump(LiveTvLogic.JUMP_SEC) }, enabled = !LiveTvLogic.isAtLive(liveOffsetMs)) { Icon(Icons.Filled.Forward30, contentDescription = "Forward 30 seconds", modifier = Modifier.size(32.dp)) }
                IconButton(onClick = { onChannelStep(1) }) { Icon(Icons.Filled.SkipNext, contentDescription = "Channel up", modifier = Modifier.size(32.dp)) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = { goLive() }, enabled = !LiveTvLogic.isAtLive(liveOffsetMs)) { Text("Go live") }
                val fav = channel?.favourite == true
                OutlinedButton(onClick = { onFavourite(!fav) }, enabled = channel != null) {
                    Icon(if (fav) Icons.Filled.Star else Icons.Filled.StarBorder, contentDescription = null)
                    Spacer(Modifier.width(6.dp)); Text(if (fav) "Favourite" else "Add to favourites")
                }
            }
            val window = LiveTvLogic.rewindWindow(watch.timeshiftMinutes)
            if (window.isNotEmpty()) Text("You can pause and rewind $window.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
        }
    }
}
