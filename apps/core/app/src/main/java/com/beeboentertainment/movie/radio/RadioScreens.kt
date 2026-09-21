package com.beeboentertainment.movie.radio

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Radio
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.audio.AudioKind
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.music.MusicPlayer
import com.beeboentertainment.movie.server.CoverImage
import com.beeboentertainment.movie.server.CoverUrls
import com.beeboentertainment.movie.server.SafeText
import com.beeboentertainment.movie.server.ServerException
import com.beeboentertainment.movie.server.rememberServerLoad
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.tv.DpadTextField
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class RadioTab(val label: String) { FAVOURITES("Favourites"), BROWSE("Browse"), MINE("My stations"), RECENT("Recent") }

@Composable
private fun StationLogo(s: Station, modifier: Modifier = Modifier) = CoverImage(CoverUrls.external(s.favicon), Icons.Filled.Radio, modifier, corner = 6)

/**
 * Internet radio: browse and search stations (from the open Radio Browser directory, through your
 * computer), keep favourites, add a station of your own by its stream address. Tap a station to
 * play it; it keeps playing with the screen off.
 */
@Composable
fun RadioScreen(onOpenListen: () -> Unit, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    val client = remember { RadioClient.get() }
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    var tabName by rememberSaveable { mutableStateOf(RadioTab.BROWSE.name) }
    val tab = RadioTab.valueOf(tabName)
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var addDialog by remember { mutableStateOf(false) }
    val favourites = rememberServerLoad("favs", onUnauthorized, reload) { client.favourites().favorites }
    val favList = favourites.value.orEmpty()

    fun play(s: Station) {
        busy = true; message = null
        scope.launch {
            try {
                RadioPlayer.play(context, s)
                onOpenListen()
            } catch (e: UnauthorizedException) { onUnauthorized() } catch (e: ServerException) {
                message = RadioLogic.refusal(e.code, e.message)
            } catch (e: Exception) { message = e.message ?: "That station couldn't be started." } finally { busy = false }
        }
    }
    fun toggleFavourite(s: Station) {
        scope.launch {
            try {
                if (RadioLogic.isFavourite(favList, s.id)) client.removeFavourite(s.id) else client.addFavourite(s)
                reload++
            } catch (e: UnauthorizedException) { onUnauthorized() } catch (e: ServerException) { message = RadioLogic.refusal(e.code, e.message) } catch (_: Exception) { }
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RadioTab.values().forEach { t -> FilterChip(selected = t == tab, onClick = { tabName = t.name }, label = { Text(t.label) }) }
        }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) }
        when (tab) {
            RadioTab.FAVOURITES -> when {
                favourites.error != null && favourites.value == null -> ErrorBox(favourites.error, onRetry = { reload++ })
                favourites.value == null -> LoadingBox()
                favList.isEmpty() -> EmptyBox("No favourites yet. Tap the star on a station.")
                else -> StationList(favList, favList, busy, { play(it) }, { toggleFavourite(it) })
            }
            RadioTab.BROWSE -> BrowseTab(client, favList, busy, onUnauthorized, { play(it) }, { toggleFavourite(it) })
            RadioTab.MINE -> {
                val mine = rememberServerLoad("mine", onUnauthorized, reload) { client.custom().custom }
                when {
                    mine.error != null && mine.value == null -> ErrorBox(mine.error, onRetry = { reload++ })
                    mine.value == null -> LoadingBox()
                    else -> Column(Modifier.fillMaxSize()) {
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) { OutlinedButton(onClick = { addDialog = true }) { Text("Add a station") } }
                        if (mine.value.isEmpty()) EmptyBox("Add a station by the address of its stream.")
                        else StationList(mine.value, favList, busy, { play(it) }, { toggleFavourite(it) })
                    }
                }
            }
            RadioTab.RECENT -> {
                val recent = rememberServerLoad("recent", onUnauthorized, reload) { client.recent().recent }
                when {
                    recent.error != null && recent.value == null -> ErrorBox(recent.error, onRetry = { reload++ })
                    recent.value == null -> LoadingBox()
                    recent.value.isEmpty() -> EmptyBox("Stations you listen to will appear here.")
                    else -> StationList(recent.value, favList, busy, { play(it) }, { toggleFavourite(it) })
                }
            }
        }
    }
    if (addDialog) AddStationDialog(
        onDismiss = { addDialog = false },
        onAdd = { name, url ->
            addDialog = false
            scope.launch {
                try { client.addCustom(name, url); reload++ } catch (e: UnauthorizedException) { onUnauthorized() }
                catch (e: ServerException) { message = RadioLogic.refusal(e.code, e.message) } catch (e: Exception) { message = e.message }
            }
        }
    )
}

@Composable
private fun BrowseTab(client: RadioClient, favs: List<Station>, busy: Boolean, onUnauthorized: () -> Unit, play: (Station) -> Unit, toggle: (Station) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var tag by rememberSaveable { mutableStateOf<String?>(null) }
    var debounced by remember { mutableStateOf("") }
    LaunchedEffect(query) { delay(400); debounced = query.trim() }
    val stations = rememberServerLoad(Pair(debounced, tag), onUnauthorized, 0) {
        client.browse(name = debounced.takeIf { it.length >= 2 }, tag = tag).stations
    }
    Column(Modifier.fillMaxSize()) {
        DpadTextField(Modifier.fillMaxWidth().padding(horizontal = 10.dp)) { tv ->
            OutlinedTextField(value = query, onValueChange = { query = it.take(100) }, label = { Text("Search stations by name") }, singleLine = true, modifier = tv.fillMaxWidth().padding(vertical = 4.dp))
        }
        androidx.compose.foundation.lazy.LazyRow(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(RadioLogic.TAGS) { t -> FilterChip(selected = tag == t, onClick = { tag = if (tag == t) null else t }, label = { Text(t) }) }
        }
        when {
            stations.error != null && stations.value == null -> ErrorBox(stations.error)
            stations.value == null -> LoadingBox()
            stations.value.isEmpty() -> EmptyBox("No stations found.")
            else -> StationList(stations.value, favs, busy, play, toggle)
        }
    }
}

@Composable
private fun StationList(stations: List<Station>, favs: List<Station>, busy: Boolean, play: (Station) -> Unit, toggle: (Station) -> Unit) {
    LazyColumn(Modifier.fillMaxSize()) {
        items(stations, key = { it.id }) { s ->
            val fav = RadioLogic.isFavourite(favs, s.id)
            Row(Modifier.fillMaxWidth().clickable(enabled = !busy) { play(s) }.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                StationLogo(s, Modifier.size(48.dp))
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(RadioLogic.name(s), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
                    Text(RadioLogic.subtitle(s), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = { toggle(s) }) {
                    Icon(if (fav) Icons.Filled.Star else Icons.Filled.StarBorder, contentDescription = if (fav) "Remove ${RadioLogic.name(s)} from favourites" else "Add ${RadioLogic.name(s)} to favourites",
                        tint = if (fav) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun AddStationDialog(onDismiss: () -> Unit, onAdd: (String, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    val address = RadioLogic.stationAddressOrNull(url)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add a station") },
        text = {
            Column {
                DpadTextField(Modifier.fillMaxWidth()) { tv -> OutlinedTextField(value = name, onValueChange = { name = it.take(100) }, label = { Text("Name") }, singleLine = true, modifier = tv.fillMaxWidth()) }
                DpadTextField(Modifier.fillMaxWidth().padding(top = 8.dp)) { tv -> OutlinedTextField(value = url, onValueChange = { url = it.take(1000) }, label = { Text("Stream address (https://...)") }, singleLine = true, modifier = tv.fillMaxWidth()) }
                Text("Your computer connects to it and relays the sound. Only plain audio streams work.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = { TextButton(enabled = address != null, onClick = { onAdd(SafeText.clean(name, 100), address!!) }) { Text("Add") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

/** What is playing: the station, its live status, the track name from the stream, and a short history. */
@Composable
fun RadioListenScreen(onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    val state by MusicPlayer.state.collectAsState()
    val now by RadioPlayer.now.collectAsState()
    val client = remember { RadioClient.get() }
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val favourites = rememberServerLoad("favs", onUnauthorized, reload) { client.favourites().favorites }

    val n = now
    if (n == null || state.kind != AudioKind.RADIO || !state.hasSong) { EmptyBox("No station is playing. Open Radio and pick one."); return }
    val fav = RadioLogic.isFavourite(favourites.value.orEmpty(), n.station.id)
    val line = RadioLogic.nowPlayingLine(n.session)

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            StationLogo(n.station, Modifier.fillMaxWidth(0.55f).aspectRatio(1f))
        }
        Text(RadioLogic.name(n.station), style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        Text(
            RadioLogic.stateLabel(n.session.state, n.session.error).ifBlank { if (state.isPlaying) "Live" else "Paused" },
            color = MaterialTheme.colorScheme.primary
        )
        if (line != null) Text(line, modifier = Modifier.padding(top = 8.dp), textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis)
        else Text("Now playing isn't sent by this station.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = {
                scope.launch {
                    try {
                        if (fav) client.removeFavourite(n.station.id) else client.addFavourite(n.station)
                        reload++
                    } catch (e: UnauthorizedException) { onUnauthorized() } catch (e: ServerException) { message = RadioLogic.refusal(e.code, e.message) } catch (_: Exception) { }
                }
            }) { Icon(if (fav) Icons.Filled.Star else Icons.Filled.StarBorder, contentDescription = if (fav) "Remove from favourites" else "Add to favourites", tint = if (fav) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) }
            IconButton(onClick = {
                if (state.errorText != null || n.session.state == "failed") {
                    scope.launch { try { RadioPlayer.restart(context) } catch (e: UnauthorizedException) { onUnauthorized() } catch (e: ServerException) { message = RadioLogic.refusal(e.code, e.message) } catch (e: Exception) { message = e.message } }
                } else if (state.isPlaying) MusicPlayer.pause() else MusicPlayer.play()
            }) { Icon(if (state.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, contentDescription = if (state.isPlaying) "Pause" else "Play", modifier = Modifier.size(52.dp), tint = MaterialTheme.colorScheme.primary) }
            IconButton(onClick = { RadioPlayer.stop() }) { Icon(Icons.Filled.Stop, contentDescription = "Stop the station", modifier = Modifier.size(32.dp)) }
        }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        state.errorText?.let { Text("The stream stopped. Press play to reconnect.", color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        val history = n.session.history.mapNotNull { h ->
            val a = SafeText.clean(h.artist, 80); val t = SafeText.clean(h.title, 100)
            (if (a.isNotBlank() && t.isNotBlank()) "$a - $t" else t.ifBlank { SafeText.clean(h.raw, 160) }).ifBlank { null }
        }.drop(if (line != null) 1 else 0).take(6)
        if (history.isNotEmpty()) {
            Text("Earlier", style = MaterialTheme.typography.titleSmall, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            history.forEach { Text(it, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth()) }
        }
        Spacer(Modifier.padding(8.dp))
    }
}
