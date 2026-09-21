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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import coil.compose.AsyncImage
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.tv.DpadTextField
import com.beeboentertainment.movie.ui.tv.LocalIsTv
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * Music in the phone and TV app.
 *
 * Where it lives: Browse's switch reads All · Films · Shows · Music. Browse is "what is in the
 * library", and music is one more kind of thing in it, one tap from the bottom bar (or the TV
 * rail) - the same place Plex puts its Music library next to Movies and TV. Library stays the
 * personal lists (watchlist, history, downloads), which songs are not.
 *
 * Routes: music/album/{id}, music/artist/{id} and music/now (Now Playing) are registered by
 * [musicRoutes]; the mini player under every screen opens Now Playing.
 */

object MusicRoutes {
    const val NOW_PLAYING = "music/now"
    const val ALBUM = "music/album/{id}"
    const val ARTIST = "music/artist/{id}"
    fun album(id: String) = "music/album/$id"
    fun artist(id: String) = "music/artist/$id"

    /** The top bar's name for a music route, or null. */
    fun screenName(route: String?): String? = when (route) {
        NOW_PLAYING -> "Now Playing"
        ALBUM -> "Album"
        ARTIST -> "Artist"
        else -> null
    }
}

fun NavGraphBuilder.musicRoutes(navController: NavController, onUnauthorized: () -> Unit) {
    composable(MusicRoutes.ALBUM) { entry ->
        MusicAlbumScreen(
            albumId = entry.arguments?.getString("id").orEmpty(),
            onOpenArtist = { navController.navigate(MusicRoutes.artist(it)) },
            onUnauthorized = onUnauthorized
        )
    }
    composable(MusicRoutes.ARTIST) { entry ->
        MusicArtistScreen(
            artistId = entry.arguments?.getString("id").orEmpty(),
            onOpenAlbum = { navController.navigate(MusicRoutes.album(it)) },
            onUnauthorized = onUnauthorized
        )
    }
    composable(MusicRoutes.NOW_PLAYING) {
        NowPlayingScreen(onOpenAlbum = { navController.navigate(MusicRoutes.album(it)) })
    }
}

/** Opens Now Playing when the music notification is tapped. */
@Composable
fun MusicNavEffects(navController: NavController) {
    val open by MusicPlayer.openNowPlaying.collectAsState()
    LaunchedEffect(open) {
        if (open > 0) runCatching { navController.navigate(MusicRoutes.NOW_PLAYING) { launchSingleTop = true } }
    }
}

internal fun absolute(path: String?): String? = UrlUtils.join(BeeboApp.instance.session.baseUrl, path)

@Composable
internal fun Cover(url: String?, modifier: Modifier = Modifier, round: Boolean = false, corner: Int = 8) {
    Box(
        modifier
            .clip(if (round) CircleShape else RoundedCornerShape(corner.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center
    ) {
        val full = absolute(url)
        if (full != null) {
            AsyncImage(model = full, contentDescription = null, modifier = Modifier.fillMaxSize())
        } else {
            Icon(
                if (round) Icons.Filled.Person else Icons.Filled.MusicNote,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** Loads something from the music API with the usual loading / error / signed-out handling. */
private class Loaded<T>(val value: T?, val loading: Boolean, val error: String?)

@Composable
private fun <T> rememberMusicLoad(key: Any?, onUnauthorized: () -> Unit, reload: Int, load: suspend () -> T): Loaded<T> {
    var value by remember(key) { mutableStateOf<T?>(null) }
    var loading by remember(key) { mutableStateOf(true) }
    var error by remember(key) { mutableStateOf<String?>(null) }
    LaunchedEffect(key, reload) {
        loading = true
        error = null
        try {
            value = load()
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: "Couldn't load your music."
        } finally {
            loading = false
        }
    }
    return Loaded(value, loading, error)
}

/* ================================ Browse → Music ================================ */

private enum class MusicSection(val label: String) { ALBUMS("Albums"), ARTISTS("Artists"), SONGS("Songs") }

@Composable
fun MusicBrowse(
    onOpenAlbum: (String) -> Unit,
    onOpenArtist: (String) -> Unit,
    onUnauthorized: () -> Unit
) {
    val context = LocalContext.current
    val isTv = LocalIsTv.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    var sectionName by rememberSaveable { mutableStateOf(MusicSection.ALBUMS.name) }
    val section = MusicSection.valueOf(sectionName)
    var query by rememberSaveable { mutableStateOf("") }
    var showQuality by remember { mutableStateOf(false) }
    val client = remember { MusicClient.get() }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            DpadTextField(Modifier.weight(1f)) { tv ->
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text("Search artists, albums and songs") },
                    singleLine = true,
                    modifier = tv.fillMaxWidth().padding(vertical = 4.dp)
                )
            }
            IconButton(onClick = { showQuality = true }) {
                Icon(Icons.Filled.Settings, contentDescription = "Music streaming quality")
            }
        }
        if (query.trim().length >= 2) {
            MusicSearchResults(query.trim(), client, onOpenAlbum, onOpenArtist, onUnauthorized)
        } else {
            Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MusicSection.entries.forEach { s ->
                    FilterChip(selected = s == section, onClick = { sectionName = s.name }, label = { Text(s.label) })
                }
            }
            when (section) {
                MusicSection.ALBUMS -> AlbumsGrid(client, onOpenAlbum, onUnauthorized, isTv)
                MusicSection.ARTISTS -> ArtistsGrid(client, onOpenArtist, onUnauthorized)
                MusicSection.SONGS -> SongsList(client, onOpenAlbum, onUnauthorized)
            }
        }
    }
    if (showQuality) QualityDialog(onDismiss = { showQuality = false })
}

@Composable
private fun LibraryStateBox(status: MusicStatus?, emptyText: String) {
    val text = when {
        status != null && !status.configured -> "No music yet. On your Beebo computer, open Settings and choose your Music folder."
        status?.scanning == true -> "Your Beebo computer is still reading your music. Pull back in a minute."
        else -> emptyText
    }
    EmptyBox(text)
}

@Composable
private fun AlbumsGrid(client: MusicClient, onOpenAlbum: (String) -> Unit, onUnauthorized: () -> Unit, isTv: Boolean) {
    var reload by remember { mutableIntStateOf(0) }
    var sort by rememberSaveable { mutableStateOf("title") }
    val albums = rememberMusicLoad(sort, onUnauthorized, reload) { client.albums(sort = sort.takeIf { it != "title" }).items }
    val status = rememberMusicLoad("status", onUnauthorized, reload) { client.status() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("title" to "A-Z", "artist" to "Artist", "year" to "Year", "added" to "Recently added").forEach { (key, label) ->
                TextButton(onClick = { sort = key }) {
                    Text(label, fontWeight = if (sort == key) FontWeight.Bold else FontWeight.Normal)
                }
            }
        }
        when {
            albums.error != null && albums.value == null -> ErrorBox(albums.error, onRetry = { reload++ })
            albums.value == null -> LoadingBox()
            albums.value.isEmpty() -> LibraryStateBox(status.value, "No albums found.")
            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = if (isTv) 150.dp else 120.dp),
                contentPadding = PaddingValues(8.dp),
                modifier = Modifier.fillMaxSize()
            ) {
                items(albums.value, key = { it.id }) { album -> AlbumTile(album) { onOpenAlbum(album.id) } }
            }
        }
    }
}

@Composable
internal fun AlbumTile(album: MusicAlbum, subtitle: String? = null, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(4.dp)
    ) {
        Cover(album.cover, Modifier.fillMaxWidth().aspectRatio(1f))
        Text(album.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
        Text(
            subtitle ?: listOfNotNull(album.artist, album.year?.toString()).joinToString(" · "),
            maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun ArtistsGrid(client: MusicClient, onOpenArtist: (String) -> Unit, onUnauthorized: () -> Unit) {
    var reload by remember { mutableIntStateOf(0) }
    val artists = rememberMusicLoad("artists", onUnauthorized, reload) { client.artists().items }
    val status = rememberMusicLoad("status", onUnauthorized, reload) { client.status() }
    when {
        artists.error != null && artists.value == null -> ErrorBox(artists.error, onRetry = { reload++ })
        artists.value == null -> LoadingBox()
        artists.value.isEmpty() -> LibraryStateBox(status.value, "No artists found.")
        else -> LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 120.dp),
            contentPadding = PaddingValues(8.dp),
            modifier = Modifier.fillMaxSize()
        ) {
            items(artists.value, key = { it.id }) { artist -> ArtistTile(artist) { onOpenArtist(artist.id) } }
        }
    }
}

@Composable
private fun ArtistTile(artist: MusicArtist, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(6.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Cover(artist.cover, Modifier.fillMaxWidth().aspectRatio(1f), round = true)
        Text(artist.name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
        Text(
            if (artist.albumCount == 1) "1 album" else "${artist.albumCount} albums",
            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun SongsList(client: MusicClient, onOpenAlbum: (String) -> Unit, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    var reload by remember { mutableIntStateOf(0) }
    val songs = rememberMusicLoad("songs", onUnauthorized, reload) { client.tracks().items }
    val status = rememberMusicLoad("status", onUnauthorized, reload) { client.status() }
    when {
        songs.error != null && songs.value == null -> ErrorBox(songs.error, onRetry = { reload++ })
        songs.value == null -> LoadingBox()
        songs.value.isEmpty() -> LibraryStateBox(status.value, "No songs found.")
        else -> {
            val list = songs.value
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 8.dp)) {
                item {
                    Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { MusicPlayer.play(context, list, 0, shuffle = true) }) {
                            Icon(Icons.Filled.Shuffle, contentDescription = null)
                            Spacer(Modifier.width(6.dp))
                            Text("Shuffle all ${list.size}")
                        }
                    }
                }
                itemsIndexed(list, key = { _, t -> t.id }) { i, t ->
                    SongRow(t, showCover = true, onClick = { MusicPlayer.play(context, list, i) }, onOpenAlbum = onOpenAlbum)
                }
            }
        }
    }
}

@Composable
private fun MusicSearchResults(
    query: String,
    client: MusicClient,
    onOpenAlbum: (String) -> Unit,
    onOpenArtist: (String) -> Unit,
    onUnauthorized: () -> Unit
) {
    val context = LocalContext.current
    var debounced by remember { mutableStateOf(query) }
    LaunchedEffect(query) { delay(250); debounced = query }
    val result = rememberMusicLoad(debounced, onUnauthorized, 0) { client.search(debounced) }
    val r = result.value
    when {
        result.error != null && r == null -> ErrorBox(result.error)
        r == null -> LoadingBox()
        r.artists.isEmpty() && r.albums.isEmpty() && r.tracks.isEmpty() -> EmptyBox("Nothing in your music matches \"$query\".")
        else -> LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 120.dp),
            contentPadding = PaddingValues(8.dp),
            modifier = Modifier.fillMaxSize()
        ) {
            if (r.artists.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) { SectionTitle("Artists") }
                items(r.artists.take(12), key = { "a" + it.id }) { a -> ArtistTile(a) { onOpenArtist(a.id) } }
            }
            if (r.albums.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) { SectionTitle("Albums") }
                items(r.albums.take(24), key = { "l" + it.id }) { a -> AlbumTile(a) { onOpenAlbum(a.id) } }
            }
            if (r.tracks.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) { SectionTitle("Songs") }
                r.tracks.forEachIndexed { i, t ->
                    item(key = "t" + t.id, span = { GridItemSpan(maxLineSpan) }) {
                        SongRow(t, showCover = true, onClick = { MusicPlayer.play(context, r.tracks, i) }, onOpenAlbum = onOpenAlbum)
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 6.dp, vertical = 8.dp))
}

/** One song: tap plays it (and what follows it in this list); ⋮ offers Play next / Add to queue. */
@Composable
internal fun SongRow(
    track: MusicTrack,
    showCover: Boolean,
    onClick: () -> Unit,
    onOpenAlbum: ((String) -> Unit)?,
    number: String? = null,
    showArtist: Boolean = true
) {
    val context = LocalContext.current
    val playing by MusicPlayer.state.collectAsState()
    val isCurrent = playing.trackId == track.id
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (showCover) {
            Cover(track.cover, Modifier.size(44.dp), corner = 4)
            Spacer(Modifier.width(10.dp))
        } else if (number != null) {
            Text(number, modifier = Modifier.width(30.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
        }
        Column(Modifier.weight(1f)) {
            Text(
                track.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (isCurrent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                fontWeight = if (isCurrent) FontWeight.Bold else FontWeight.Normal
            )
            val sub = listOfNotNull(track.artist.takeIf { showArtist }, track.album.takeIf { showCover }).joinToString(" · ")
            if (sub.isNotBlank()) Text(sub, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(MusicQueueLogic.formatDuration(track.duration), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More for ${track.title}") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("Play next") }, onClick = { menu = false; MusicPlayer.playNext(context, track) })
                DropdownMenuItem(text = { Text("Add to queue") }, onClick = { menu = false; MusicPlayer.addToQueue(context, track) })
                if (onOpenAlbum != null && track.albumId != null) {
                    DropdownMenuItem(text = { Text("Go to album") }, onClick = { menu = false; onOpenAlbum(track.albumId) })
                }
            }
        }
    }
}

@Composable
private fun QualityDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    var away by remember { mutableStateOf(MusicPrefs.awayQuality(context)) }
    var home by remember { mutableStateOf(MusicPrefs.homeQuality(context)) }
    var levelling by remember { mutableStateOf(MusicPrefs.levelling(context)) }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
        title = { Text("Music quality") },
        text = {
            LazyColumn {
                item { Text("Away from home", fontWeight = FontWeight.Bold) }
                items(MusicStreamRules.QUALITIES) { q ->
                    QualityOption(MusicStreamRules.qualityLabel(q), q == away) { away = q; MusicPrefs.setAwayQuality(context, q) }
                }
                item {
                    Text("Lower quality uses less data. Songs your phone can't play as they are are converted either way.",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                item { Spacer(Modifier.height(12.dp)); Text("At home", fontWeight = FontWeight.Bold) }
                items(MusicStreamRules.QUALITIES) { q ->
                    QualityOption(MusicStreamRules.qualityLabel(q), q == home) { home = q; MusicPrefs.setHomeQuality(context, q) }
                }
                item {
                    Text("Takes effect from the next song.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                item {
                    Spacer(Modifier.height(12.dp))
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Volume levelling", fontWeight = FontWeight.Bold)
                            Text("Turns loud songs down to an even level using the ReplayGain tags in your files. The files are not changed. Quiet songs are left as they are.",
                                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Switch(checked = levelling, onCheckedChange = { levelling = it; MusicPrefs.setLevelling(context, it) })
                    }
                }
            }
        }
    )
}

@Composable
private fun QualityOption(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected = selected, onClick = onClick)
        Text(label)
    }
}

/* ================================== Album ================================== */

@Composable
fun MusicAlbumScreen(albumId: String, onOpenArtist: (String) -> Unit, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    val client = remember { MusicClient.get() }
    var reload by remember { mutableIntStateOf(0) }
    val loaded = rememberMusicLoad(albumId, onUnauthorized, reload) { client.album(albumId) }
    val r = loaded.value
    when {
        loaded.error != null && r == null -> ErrorBox(loaded.error, onRetry = { reload++ })
        r?.album == null -> LoadingBox()
        else -> {
            val album = r.album
            val tracks = r.tracks
            val multiDisc = tracks.mapNotNull { it.discNo }.distinct().size > 1
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 12.dp)) {
                item {
                    Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.Bottom) {
                        Cover(album.cover, Modifier.size(150.dp))
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(album.title, style = MaterialTheme.typography.titleLarge, maxLines = 3, overflow = TextOverflow.Ellipsis)
                            Text(
                                album.artist,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .clickable(enabled = album.artistId != null) { album.artistId?.let(onOpenArtist) }
                                    .padding(vertical = 2.dp)
                            )
                            Text(
                                listOfNotNull(album.year?.toString(), album.genre, "${album.trackCount} songs", MusicQueueLogic.formatLength(album.duration).ifBlank { null })
                                    .joinToString(" · "),
                                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Button(onClick = { MusicPlayer.play(context, tracks, 0) }, enabled = tracks.isNotEmpty()) {
                            Icon(Icons.Filled.PlayArrow, contentDescription = null); Spacer(Modifier.width(4.dp)); Text("Play")
                        }
                        OutlinedButton(onClick = { MusicPlayer.play(context, tracks, 0, shuffle = true) }, enabled = tracks.size > 1) {
                            Icon(Icons.Filled.Shuffle, contentDescription = null); Spacer(Modifier.width(4.dp)); Text("Shuffle")
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                var lastDisc: Int? = null
                tracks.forEachIndexed { i, t ->
                    if (multiDisc && t.discNo != lastDisc) {
                        lastDisc = t.discNo
                        item(key = "disc-${t.discNo}-$i") {
                            Text("Disc ${t.discNo ?: 1}", fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                        }
                    }
                    item(key = t.id) {
                        SongRow(
                            t, showCover = false, number = t.trackNo?.toString() ?: "",
                            showArtist = t.artist != album.artist,
                            onClick = { MusicPlayer.play(context, tracks, i) }, onOpenAlbum = null
                        )
                    }
                }
            }
        }
    }
}

/* ================================== Artist ================================== */

@Composable
fun MusicArtistScreen(artistId: String, onOpenAlbum: (String) -> Unit, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    val client = remember { MusicClient.get() }
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    val loaded = rememberMusicLoad(artistId, onUnauthorized, reload) { client.artist(artistId) }
    val r = loaded.value
    when {
        loaded.error != null && r == null -> ErrorBox(loaded.error, onRetry = { reload++ })
        r?.artist == null -> LoadingBox()
        else -> LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 130.dp),
            contentPadding = PaddingValues(8.dp),
            modifier = Modifier.fillMaxSize()
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column(Modifier.padding(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Cover(r.artist.cover, Modifier.size(96.dp), round = true)
                        Spacer(Modifier.width(14.dp))
                        Column {
                            Text(r.artist.name, style = MaterialTheme.typography.titleLarge)
                            Text("${r.artist.albumCount} albums · ${r.artist.trackCount} songs", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        // Every song this artist has, in album order, played (or shuffled) as one queue.
                        val playAll: (Boolean) -> Unit = { shuffle ->
                            scope.launch {
                                val songs = runCatching { client.tracks(artistId = artistId).items }.getOrDefault(emptyList())
                                if (songs.isNotEmpty()) MusicPlayer.play(context, songs, 0, shuffle = shuffle)
                            }
                        }
                        Button(onClick = { playAll(false) }) {
                            Icon(Icons.Filled.PlayArrow, contentDescription = null); Spacer(Modifier.width(4.dp)); Text("Play")
                        }
                        OutlinedButton(onClick = { playAll(true) }) {
                            Icon(Icons.Filled.Shuffle, contentDescription = null); Spacer(Modifier.width(4.dp)); Text("Shuffle")
                        }
                    }
                    Text("Albums", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
                }
            }
            items(r.albums, key = { it.id }) { a ->
                AlbumTile(a, subtitle = listOfNotNull(a.year?.toString(), "${a.trackCount} songs").joinToString(" · ")) { onOpenAlbum(a.id) }
            }
        }
    }
}

/* ================================ Mini player ================================ */

/** The strip above the bottom bar while music is loaded: cover, song, play/pause, next. Tap opens Now Playing. */
@Composable
fun MusicMiniPlayer(currentRoute: String?, onOpen: () -> Unit) {
    val s by MusicPlayer.state.collectAsState()
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    if (!s.hasSong || currentRoute == MusicRoutes.NOW_PLAYING) return
    val meta = s.current?.mediaMetadata
    Surface(tonalElevation = 3.dp, modifier = Modifier.fillMaxWidth()) {
        Column {
            if (s.durationMs > 0) {
                Box(Modifier.fillMaxWidth().height(2.dp).background(MaterialTheme.colorScheme.surfaceVariant)) {
                    Box(
                        Modifier
                            .fillMaxWidth((s.positionMs.toFloat() / s.durationMs).coerceIn(0f, 1f))
                            .height(2.dp)
                            .background(MaterialTheme.colorScheme.primary)
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(Modifier.size(42.dp).clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.surfaceVariant)) {
                    val art = meta?.artworkUri?.toString()
                    if (art != null) AsyncImage(model = art, contentDescription = null, modifier = Modifier.fillMaxSize())
                    else Icon(Icons.Filled.MusicNote, contentDescription = null, modifier = Modifier.align(Alignment.Center))
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(meta?.title?.toString().orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
                    Text(meta?.artist?.toString().orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = { MusicPlayer.togglePlay() }) {
                    Icon(if (s.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, contentDescription = if (s.isPlaying) "Pause" else "Play")
                }
                IconButton(onClick = { MusicPlayer.next() }, enabled = s.upNext.isNotEmpty()) {
                    Icon(Icons.Filled.SkipNext, contentDescription = "Next song")
                }
            }
            HorizontalDivider()
        }
    }
}
