package com.beeboentertainment.movie.photos

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.compose.AsyncImagePainter
import coil.compose.SubcomposeAsyncImage
import coil.compose.SubcomposeAsyncImageContent
import coil.request.ImageRequest
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.player.CastHelper
import com.beeboentertainment.movie.player.CastLoadResult
import com.beeboentertainment.movie.player.CastMedia
import com.beeboentertainment.movie.spacesaver.gallery.rememberAuthedImageLoader
import com.beeboentertainment.movie.ui.CastIconButton
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Photos: the home PC's picture library, like the phone's own gallery. Timeline (newest first,
 * grouped by month), Albums (one per PC folder) and Videos, a full-screen viewer with swipe, pinch
 * zoom and video playback, and casting a photo or a slideshow to the TV.
 */
@Composable
fun PhotosScreen(onOpenBackup: () -> Unit, onUnauthorized: () -> Unit = {}, showBackup: Boolean = true) {
    val client = remember { PhotosClient() }
    val loader = rememberAuthedImageLoader()
    val scope = rememberCoroutineScope()
    var section by remember { mutableStateOf("Timeline") }
    var album by remember { mutableStateOf<PhotoAlbum?>(null) }
    val items = remember { mutableStateListOf<PhotoItem>() }
    var nextOffset by remember { mutableStateOf<Int?>(0) }
    var albums by remember { mutableStateOf<List<PhotoAlbum>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var viewing by remember { mutableStateOf(-1) }
    var retry by remember { mutableStateOf(0) }

    suspend fun loadMore(reset: Boolean) {
        if (loading) return
        val from = if (reset) 0 else nextOffset ?: return
        loading = true
        try {
            val page = client.timeline(from, album?.id, videosOnly = section == "Videos")
            if (reset) items.clear()
            items.addAll(page.items)
            nextOffset = page.nextOffset
            error = null
        } catch (e: PhotosException) {
            if (e.code == 401) onUnauthorized()
            error = e.message
        } catch (e: Exception) {
            error = "Couldn't reach your home computer. ${e.message.orEmpty()}".trim()
        } finally { loading = false }
    }

    LaunchedEffect(section, album, retry) {
        viewing = -1
        if (section == "Albums" && album == null) {
            loading = true
            try { albums = client.albums().albums; error = null } catch (e: PhotosException) {
                if (e.code == 401) onUnauthorized(); error = e.message
            } catch (e: Exception) { error = "Couldn't reach your home computer." } finally { loading = false }
        } else loadMore(reset = true)
    }

    if (viewing >= 0 && viewing < items.size) {
        BackHandler { viewing = -1 }
        PhotoViewer(items, viewing, client, loader, onClose = { viewing = -1 })
        return
    }
    BackHandler(enabled = album != null) { album = null }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("Timeline", "Albums", "Videos").forEach { s ->
                FilterChip(selected = section == s, onClick = { album = null; section = s }, label = { Text(s) })
            }
            Box(Modifier.weight(1f))
            CastIconButton()
            if (showBackup) TextButton(onClick = onOpenBackup) { Text("Backup") }
        }
        album?.let { a ->
            Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { album = null }) { Text("← Albums") }
                Text(a.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        error?.let {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(it, color = MaterialTheme.colorScheme.error)
                Button(onClick = { retry++ }) { Text("Try again") }
            }
        }
        Box(Modifier.weight(1f)) {
            if (section == "Albums" && album == null) {
                AlbumGrid(albums, client, loader) { album = it }
            } else {
                TimelineGrid(items, client, loader, loading, hasMore = nextOffset != null,
                    onNeedMore = { scope.launch { loadMore(false) } }, onOpen = { viewing = it })
            }
            if (loading && items.isEmpty() && albums.isEmpty()) CircularProgressIndicator(Modifier.align(Alignment.Center))
        }
    }
}

private fun monthOf(ms: Long): String = SimpleDateFormat("MMMM yyyy", Locale.getDefault()).format(Date(ms))

@Composable
private fun TimelineGrid(
    items: List<PhotoItem>, client: PhotosClient, loader: ImageLoader, loading: Boolean, hasMore: Boolean,
    onNeedMore: () -> Unit, onOpen: (Int) -> Unit,
) {
    val state = rememberLazyGridState()
    val nearEnd by remember { derivedStateOf { (state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) > state.layoutInfo.totalItemsCount - 40 } }
    LaunchedEffect(nearEnd, items.size) { if (nearEnd && hasMore && !loading) onNeedMore() }
    if (items.isEmpty() && !loading) {
        Text("No photos yet. On the PC, open Beebo › Phone Backups to choose your photo folders, or turn on Photo backup on this phone.", Modifier.padding(20.dp))
        return
    }
    // Month headers span the full width; photos flow in between.
    val rows = remember(items.size) {
        val out = ArrayList<Pair<String?, Int>>()
        var month: String? = null
        items.forEachIndexed { i, it ->
            val m = monthOf(it.takenAtMs)
            if (m != month) { out += m to -1; month = m }
            out += null to i
        }
        out
    }
    LazyVerticalGrid(columns = GridCells.Adaptive(96.dp), state = state, contentPadding = PaddingValues(4.dp), modifier = Modifier.fillMaxSize()) {
        items(rows.size, span = { GridItemSpan(if (rows[it].first != null) maxLineSpan else 1) }) { r ->
            val (header, index) = rows[r]
            if (header != null) {
                Text(header, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 8.dp, top = 14.dp, bottom = 6.dp))
            } else {
                val item = items[index]
                Box(Modifier.padding(2.dp).aspectRatio(1f).clip(RoundedCornerShape(3.dp)).background(Color(0xFF1B1F27)).clickable { onOpen(index) }) {
                    AsyncImage(
                        model = ImageRequest.Builder(LocalContext.current).data(client.thumbUrl(item.id)).crossfade(true).build(),
                        imageLoader = loader, contentDescription = item.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
                    )
                    if (item.isVideo) Icon(Icons.Filled.PlayCircle, contentDescription = "Video", tint = Color.White, modifier = Modifier.align(Alignment.BottomEnd).padding(4.dp).size(22.dp))
                }
            }
        }
    }
}

@Composable
private fun AlbumGrid(albums: List<PhotoAlbum>, client: PhotosClient, loader: ImageLoader, onOpen: (PhotoAlbum) -> Unit) {
    LazyVerticalGrid(columns = GridCells.Adaptive(150.dp), contentPadding = PaddingValues(8.dp), modifier = Modifier.fillMaxSize()) {
        items(albums, key = { it.id }) { a ->
            Column(Modifier.padding(6.dp).clickable { onOpen(a) }) {
                AsyncImage(
                    model = ImageRequest.Builder(LocalContext.current).data(client.thumbUrl(a.coverId)).crossfade(true).build(),
                    imageLoader = loader, contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(8.dp)).background(Color(0xFF1B1F27)),
                )
                Text(a.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                Text("${a.count} item${if (a.count == 1) "" else "s"}", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/* ------------------------------------ viewer ------------------------------------ */

@Composable
private fun PhotoViewer(items: List<PhotoItem>, start: Int, client: PhotosClient, loader: ImageLoader, onClose: () -> Unit) {
    val context = LocalContext.current
    val pager = rememberPagerState(initialPage = start.coerceIn(0, items.lastIndex)) { items.size }
    val scope = rememberCoroutineScope()
    var slideshow by remember { mutableStateOf(false) }
    var castNote by remember { mutableStateOf<String?>(null) }
    val route by com.beeboentertainment.movie.rtc.RemoteAccess.route.collectAsState()
    // The one-argument CastRule.decide on purpose: photos are cast a whole album at a time, so
    // the away-from-home trick of passing ONE film through this phone (PhoneCastRelay) does not
    // apply here. Photos still cast at home and on a plain server address, as they always have.
    val castAllowed = com.beeboentertainment.movie.rtc.CastRule.decide(route) !is com.beeboentertainment.movie.rtc.CastRule.Decision.Blocked

    // While a Cast session is up, the TV follows the photo on screen.
    LaunchedEffect(pager.currentPage, castAllowed) {
        if (castAllowed && castSessionActive(context)) {
            items.getOrNull(pager.currentPage)?.let { castNote = castItem(context, client, it) }
        }
    }
    // Slideshow: next photo every 5 seconds (videos play to the end on the TV by themselves).
    LaunchedEffect(slideshow) {
        while (slideshow) {
            delay(5000)
            if (pager.currentPage >= items.lastIndex) { slideshow = false; break }
            pager.animateScrollToPage(pager.currentPage + 1)
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        HorizontalPager(state = pager, modifier = Modifier.fillMaxSize(), key = { items[it].id }) { page ->
            val item = items[page]
            val active = pager.currentPage == page && !pager.isScrollInProgress
            if (item.isVideo) VideoPage(client.originalUrl(item.id), active)
            else ZoomablePhoto(client.viewUrl(item.id), item.name, loader)
        }
        val current = items.getOrNull(pager.currentPage)
        Row(Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.4f)).padding(4.dp).align(Alignment.TopCenter), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = "Close", tint = Color.White) }
            Column(Modifier.weight(1f)) {
                Text(current?.name.orEmpty(), color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
                current?.let {
                    Text(SimpleDateFormat("d MMM yyyy, h:mm a", Locale.getDefault()).format(Date(it.takenAtMs)), color = Color.White.copy(alpha = 0.7f), style = MaterialTheme.typography.bodySmall)
                }
            }
            CastIconButton()
            TextButton(onClick = {
                if (!slideshow && castAllowed && castSessionActive(context)) current?.let { scope.launch { castNote = castItem(context, client, it) } }
                slideshow = !slideshow
            }) { Text(if (slideshow) "Stop slideshow" else "Slideshow", color = Color.White) }
        }
        castNote?.let {
            Text(it, color = Color.White, modifier = Modifier.align(Alignment.BottomCenter).background(Color.Black.copy(alpha = 0.6f)).padding(10.dp))
            LaunchedEffect(it) { delay(4000); castNote = null }
        }
    }
}

private fun castSessionActive(context: Context): Boolean = CastHelper.isSessionConnected(context)

/** Show [item] on the connected TV. Returns a short note for the screen, or null when it worked. */
private suspend fun castItem(context: Context, client: PhotosClient, item: PhotoItem): String? {
    if (!CastHelper.isSessionConnected(context)) return null
    val media = runCatching { client.cast(item.id) }.getOrElse { return "Couldn't send this to the TV." }
    val url = client.absolute(media.url)
    if (url.isBlank()) return "Couldn't send this to the TV."
    return when (CastHelper.loadOnReceiver(context, CastMedia(url, media.contentType, item.name, item.isVideo))) {
        CastLoadResult.Failed -> "Couldn't send this to the TV."
        CastLoadResult.Sent, CastLoadResult.NoSession -> null
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class) // transformable(canPan): swipe pages at 1x, pan when zoomed
@Composable
private fun ZoomablePhoto(url: String, name: String, loader: ImageLoader) {
    var scale by remember { mutableStateOf(1f) }
    var ox by remember { mutableStateOf(0f) }
    var oy by remember { mutableStateOf(0f) }
    val state = rememberTransformableState { zoom, pan, _ ->
        scale = (scale * zoom).coerceIn(1f, 6f)
        if (scale > 1f) { ox += pan.x; oy += pan.y } else { ox = 0f; oy = 0f }
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        SubcomposeAsyncImage(
            model = ImageRequest.Builder(LocalContext.current).data(url.ifBlank { null }).crossfade(true).build(),
            imageLoader = loader, contentDescription = name, contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize()
                .pointerInput(Unit) { detectTapGestures(onDoubleTap = { if (scale > 1f) { scale = 1f; ox = 0f; oy = 0f } else scale = 2.5f }) }
                .graphicsLayer(scaleX = scale, scaleY = scale, translationX = ox, translationY = oy)
                // Only take drags while zoomed in, so a swipe at normal size still turns the page.
                .transformable(state = state, canPan = { scale > 1f }),
        ) {
            when (painter.state) {
                is AsyncImagePainter.State.Loading -> CircularProgressIndicator(color = Color.White)
                is AsyncImagePainter.State.Error -> Icon(Icons.Filled.BrokenImage, contentDescription = null, tint = Color.White.copy(alpha = 0.7f), modifier = Modifier.size(64.dp))
                else -> SubcomposeAsyncImageContent()
            }
        }
    }
}

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
@Composable
private fun VideoPage(url: String, active: Boolean) {
    val context = LocalContext.current
    val player = remember(url) {
        val token = BeeboApp.instance.session.token
        val factory = OkHttpDataSource.Factory(BeeboApp.instance.api.okHttp).apply {
            if (!token.isNullOrBlank()) setDefaultRequestProperties(mapOf("Authorization" to "Bearer $token"))
        }
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(factory)).build().apply {
            if (url.isNotBlank()) { setMediaItem(MediaItem.fromUri(url)); prepare() }
            playWhenReady = false
        }
    }
    LaunchedEffect(player, active) { player.playWhenReady = active; if (!active) player.pause() }
    DisposableEffect(player) { onDispose { player.release() } }
    AndroidView(factory = { ctx ->
        PlayerView(ctx).apply { this.player = player; useController = true; setBackgroundColor(android.graphics.Color.BLACK) }
    }, modifier = Modifier.fillMaxSize())
}
