package com.beeboentertainment.movie.trip

import android.view.WindowManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.compose.SubcomposeAsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * Present mode: the trip as a full-screen, swipeable slideshow ("show it off").
 *
 * The colours are fixed rather than taken from the app theme on purpose. The slideshow is meant to
 * be shown to other people, on this phone, cast or mirrored to a TV, and it has to look the same and
 * stay readable whether the phone is in light or dark mode: near-black ground, white text, one warm
 * accent, large type that scales up with the screen. Restrained and adult, not a toy.
 *
 * It needs no network: the cards are drawn from local data and the photos and videos are read from
 * the addresses the system photo picker returned.
 */

private val Ground = Color(0xFF0B0F14)
private val Ink = Color(0xFFFFFFFF)
private val InkSoft = Color(0xFFC3CCD6)
private val Accent = Color(0xFFF2B84B)

@Composable
internal fun TripPresentDialog(slides: List<Slide>, onClose: () -> Unit) {
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Present(slides, onClose)
    }
}

@Composable
private fun Present(slides: List<Slide>, onClose: () -> Unit) {
    val view = LocalView.current
    val window = (view.parent as? DialogWindowProvider)?.window
    DisposableEffect(window) {
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val controller = window?.let { WindowCompat.getInsetsController(it, view) }
        controller?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller?.hide(WindowInsetsCompat.Type.systemBars())
        onDispose {
            controller?.show(WindowInsetsCompat.Type.systemBars())
            window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    val pager = rememberPagerState(pageCount = { slides.size })
    val scope = rememberCoroutineScope()
    var auto by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }

    fun go(delta: Int) {
        val target = (pager.currentPage + delta).coerceIn(0, slides.lastIndex)
        scope.launch { pager.animateScrollToPage(target) }
    }

    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    LaunchedEffect(pager.currentPage, auto) {
        if (!auto) return@LaunchedEffect
        delay(dwellMs(slides[pager.currentPage]))
        if (pager.currentPage < slides.lastIndex) pager.animateScrollToPage(pager.currentPage + 1) else auto = false
    }

    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .background(Ground)
            .focusRequester(focus)
            .focusTarget()
            .onPreviewKeyEvent { e ->
                // A remote's arrows and page keys work the same as a swipe, for a TV or a keyboard.
                if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (e.key) {
                    Key.DirectionRight, Key.PageDown, Key.Spacebar -> { go(1); true }
                    Key.DirectionLeft, Key.PageUp -> { go(-1); true }
                    Key.Escape -> { onClose(); true }
                    else -> false
                }
            },
    ) {
        val scale = (maxWidth.value / 400f).coerceIn(1f, 2.4f)
        HorizontalPager(pager, Modifier.fillMaxSize(), key = { it }) { page ->
            SlideView(slides[page], active = pager.currentPage == page, scale = scale, maxWidth = maxWidth)
        }

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).align(Alignment.TopStart),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            TextButton(onClick = { auto = !auto }) {
                Text(if (auto) "Pause" else "Auto-play", color = Ink, fontSize = (16 * scale).sp)
            }
            TextButton(onClick = onClose) { Text("Close", color = Ink, fontSize = (16 * scale).sp) }
        }
        Text(
            "${pager.currentPage + 1} / ${slides.size}",
            color = InkSoft,
            fontSize = (14 * scale).sp,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp),
        )
    }
}

private fun dwellMs(slide: Slide): Long = when (slide.kind) {
    SlideKind.PHOTO -> 5_000L
    SlideKind.VIDEO -> 8_000L
    else -> TripExportPlanner.cardMs(slide) + 2_000L
}

@Composable
private fun SlideView(slide: Slide, active: Boolean, scale: Float, maxWidth: Dp) {
    when (slide.kind) {
        SlideKind.PHOTO -> PhotoSlide(slide.media)
        SlideKind.VIDEO -> VideoSlide(slide.media, active)
        else -> CardSlide(slide, scale, maxWidth)
    }
}

@Composable
private fun CardSlide(slide: Slide, scale: Float, maxWidth: Dp) {
    val cover = slide.kind == SlideKind.COVER
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = (maxWidth * 0.08f), vertical = 64.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = if (cover) Alignment.CenterHorizontally else Alignment.Start,
    ) {
        if (slide.title.isNotBlank()) {
            Text(
                slide.title,
                color = Ink,
                fontSize = ((if (cover) 40 else 30) * scale).sp,
                fontWeight = FontWeight.Bold,
                textAlign = if (cover) TextAlign.Center else TextAlign.Start,
            )
        }
        if (slide.subtitle.isNotBlank()) {
            Spacer(Modifier.height((8 * scale).dp))
            Text(
                slide.subtitle,
                color = Accent,
                fontSize = (18 * scale).sp,
                fontWeight = FontWeight.Medium,
                textAlign = if (cover) TextAlign.Center else TextAlign.Start,
            )
        }
        if (slide.body.isNotBlank()) {
            Spacer(Modifier.height((20 * scale).dp))
            Text(slide.body, color = Ink, fontSize = (22 * scale).sp, lineHeight = (32 * scale).sp)
        }
        if (slide.lines.isNotEmpty()) {
            Spacer(Modifier.height((24 * scale).dp))
            Column(verticalArrangement = Arrangement.spacedBy((10 * scale).dp)) {
                slide.lines.forEach { line ->
                    if (cover) {
                        Text(line, color = InkSoft, fontSize = (20 * scale).sp, textAlign = TextAlign.Center)
                    } else {
                        Row(verticalAlignment = Alignment.Top) {
                            Box(Modifier.padding(top = (11 * scale).dp).size((7 * scale).dp).background(Accent))
                            Spacer(Modifier.size((14 * scale).dp))
                            Text(line, color = Ink, fontSize = (22 * scale).sp, lineHeight = (30 * scale).sp)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PhotoSlide(media: TripMedia?) {
    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        if (media == null) return@Box
        SubcomposeAsyncImage(
            model = media.uri,
            contentDescription = "Trip photo",
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize(),
            error = { Unavailable("This photo can't be opened any more. Choose it again from the trip screen.") },
        )
    }
}

@Composable
private fun VideoSlide(media: TripMedia?, active: Boolean) {
    Box(
        Modifier.fillMaxSize().background(Color.Black).semantics { contentDescription = "Trip video" },
        contentAlignment = Alignment.Center,
    ) {
        // Only the slide on screen holds a player, so swiping past a long run of clips never
        // keeps several decoders alive.
        if (media != null && active) ActiveVideo(media)
    }
}

@Composable
private fun ActiveVideo(media: TripMedia) {
    val context = LocalContext.current
    var failed by remember(media.uri) { mutableStateOf(false) }
    val player = remember(media.uri) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(media.uri))
            repeatMode = Player.REPEAT_MODE_ONE
            playWhenReady = true
            addListener(object : Player.Listener {
                override fun onPlayerError(error: PlaybackException) { failed = true }
            })
            prepare()
        }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    if (failed) {
        Unavailable("This video can't be opened any more. Choose it again from the trip screen.")
    } else {
        AndroidView(
            factory = { PlayerView(it).apply { this.player = player; useController = false } },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
private fun Unavailable(message: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(message, color = InkSoft, fontSize = 18.sp, textAlign = TextAlign.Center)
    }
}
