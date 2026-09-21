package com.beeboentertainment.movie.spacesaver.gallery

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import coil.ImageLoader
import coil.compose.AsyncImagePainter
import coil.compose.SubcomposeAsyncImage
import coil.compose.SubcomposeAsyncImageContent
import coil.request.ImageRequest
import com.beeboentertainment.movie.BeeboApp

/**
 * Full-screen, horizontally swipeable viewer over one folder's [items] — the "show my friends"
 * experience. Dark background, minimal chrome: just the filename and a close button.
 *
 * Photos load full-size via the `file` route through the authed Coil loader, and support
 * pinch-to-zoom. Videos play in an ExoPlayer whose OkHttp DataSource carries the bearer token, with
 * the standard media3 transport controls. Only the currently-visible page's video plays; every
 * player is released in [DisposableEffect]'s onDispose, so swiping away or closing frees it
 * immediately.
 *
 * @param startIndex which item to open on.
 * @param onClose invoked when the user closes the viewer.
 */
@Composable
fun SpaceSaverViewerScreen(
    items: List<GalleryItem>,
    startIndex: Int,
    client: SpaceSaverGalleryClient,
    imageLoader: ImageLoader,
    onClose: () -> Unit
) {
    if (items.isEmpty()) {
        onClose()
        return
    }
    val safeStart = startIndex.coerceIn(0, items.lastIndex)
    val pagerState = rememberPagerState(initialPage = safeStart) { items.size }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        HorizontalPager(
            state = pagerState,
            modifier = Modifier.fillMaxSize()
        ) { page ->
            val item = items[page]
            val isActive = pagerState.currentPage == page && !pagerState.isScrollInProgress
            if (item.isVideo) {
                VideoPage(
                    fileUrl = client.fileUrl(item.rel),
                    active = isActive
                )
            } else {
                PhotoPage(
                    fileUrl = client.fileUrl(item.rel),
                    contentDescription = item.name,
                    imageLoader = imageLoader
                )
            }
        }

        // Top chrome: filename + close, over a subtle scrim so it stays legible on any image.
        val current = items.getOrNull(pagerState.currentPage)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color.Black.copy(alpha = 0.35f))
                .padding(horizontal = 4.dp, vertical = 4.dp)
                .align(Alignment.TopCenter),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onClose) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = "Close",
                    tint = Color.White
                )
            }
            Text(
                text = current?.name.orEmpty(),
                color = Color.White,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(end = 12.dp)
            )
        }
    }
}

@Composable
private fun PhotoPage(
    fileUrl: String,
    contentDescription: String,
    imageLoader: ImageLoader
) {
    val context = LocalContext.current
    var scale by remember { mutableStateOf(1f) }
    var offsetX by remember { mutableStateOf(0f) }
    var offsetY by remember { mutableStateOf(0f) }
    val transformState = rememberTransformableState { zoomChange, panChange, _ ->
        scale = (scale * zoomChange).coerceIn(1f, 5f)
        if (scale > 1f) {
            offsetX += panChange.x
            offsetY += panChange.y
        } else {
            offsetX = 0f
            offsetY = 0f
        }
    }

    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        SubcomposeAsyncImage(
            model = ImageRequest.Builder(context)
                .data(fileUrl.ifBlank { null })
                .crossfade(true)
                .build(),
            imageLoader = imageLoader,
            contentDescription = contentDescription,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer(
                    scaleX = scale,
                    scaleY = scale,
                    translationX = offsetX,
                    translationY = offsetY
                )
                .transformable(state = transformState)
        ) {
            when (painter.state) {
                is AsyncImagePainter.State.Loading ->
                    CircularProgressIndicator(color = Color.White)
                is AsyncImagePainter.State.Error ->
                    Icon(
                        imageVector = Icons.Filled.BrokenImage,
                        contentDescription = null,
                        tint = Color.White.copy(alpha = 0.7f),
                        modifier = Modifier.size(64.dp)
                    )
                else -> SubcomposeAsyncImageContent()
            }
        }
    }
}

// @OptIn (not @UnstableApi) so the media3 opt-in is satisfied HERE and does not propagate out to
// SpaceSaverViewerScreen / SpaceSaverGalleryScreen — the public entry point stays annotation-free,
// so navigation code wiring it in never needs to opt in.
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
@Composable
private fun VideoPage(fileUrl: String, active: Boolean) {
    val context = LocalContext.current

    // One player per composed video page, keyed on the URL so a page reused for a different item
    // rebuilds. Released in onDispose — swiping away or closing frees it at once.
    val player = remember(fileUrl) {
        val token = BeeboApp.instance.session.token
        val dataSourceFactory = OkHttpDataSource.Factory(BeeboApp.instance.api.okHttp).apply {
            if (!token.isNullOrBlank()) {
                setDefaultRequestProperties(mapOf("Authorization" to "Bearer $token"))
            }
        }
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            .build()
            .apply {
                if (fileUrl.isNotBlank()) {
                    setMediaItem(MediaItem.fromUri(fileUrl))
                    prepare()
                }
                playWhenReady = false
            }
    }

    // Only the settled current page plays; others pause. Also pauses when the page leaves.
    LaunchedEffect(player, active) {
        player.playWhenReady = active
        if (!active) player.pause()
    }

    DisposableEffect(player) {
        onDispose { player.release() }
    }

    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        if (fileUrl.isBlank()) {
            Icon(
                imageVector = Icons.Filled.BrokenImage,
                contentDescription = null,
                tint = Color.White.copy(alpha = 0.7f),
                modifier = Modifier.size(64.dp)
            )
        } else {
            AndroidView(
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        this.player = player
                        useController = true
                        setShowNextButton(false)
                        setShowPreviousButton(false)
                        setBackgroundColor(android.graphics.Color.BLACK)
                    }
                },
                modifier = Modifier.fillMaxSize()
            )
        }
    }
}
