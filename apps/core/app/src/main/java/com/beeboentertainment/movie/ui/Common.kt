package com.beeboentertainment.movie.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DownloadDone
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Search
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.material.icons.filled.CastConnected
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
import androidx.compose.ui.viewinterop.AndroidView
import androidx.mediarouter.app.MediaRouteButton
import coil.compose.AsyncImage
import com.beeboentertainment.movie.core.TvFeatures
import com.beeboentertainment.movie.player.CastHelper
import com.beeboentertainment.movie.ui.tv.LocalIsTv
import com.beeboentertainment.movie.ui.tv.tvLongPress
import androidx.compose.ui.focus.focusProperties

/**
 * The Cast button for the app bar.
 *
 * MediaRouteButton is a plain View, so it comes in through AndroidView. It needs an AppCompat
 * theme, which is why Theme.BeeboEntertainment derives from Theme.AppCompat. If Cast isn't available on
 * this device (no Play services) we render nothing at all rather than a dead button.
 */
@Composable
fun CastIconButton(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    if (!CastHelper.isAvailable(context)) return
    // Away from home a TV can't reach this phone's tunnel by itself, so the phone passes the
    // video on - but only on Wi-Fi, never on mobile data, where every byte would be paid for
    // twice (CastRule, PhoneCastRelay). When it can't work there is no button, just a quiet
    // explanation where it would be. At home, and on any other server address, as before.
    val route by com.beeboentertainment.movie.rtc.RemoteAccess.route.collectAsState()
    val decision = remember(route) {
        // Away-from-home needs more than the route (Wi-Fi, an address a TV could reach), so it
        // asks RemoteAccess. A preview with none of that set up falls back to the plain answer.
        runCatching { com.beeboentertainment.movie.rtc.RemoteAccess.castDecision() }
            .getOrElse { com.beeboentertainment.movie.rtc.CastRule.decide(route) }
    }
    if (decision is com.beeboentertainment.movie.rtc.CastRule.Decision.Blocked) {
        val network = com.beeboentertainment.movie.rtc.RemoteAccess.currentNetwork
        var explain by remember { mutableStateOf(false) }
        androidx.compose.material3.IconButton(onClick = { explain = true }, modifier = modifier) {
            androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.Filled.CastConnected, contentDescription = com.beeboentertainment.movie.rtc.CastRule.blockedTitle(network), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f))
        }
        if (explain) {
            androidx.compose.material3.AlertDialog(
                onDismissRequest = { explain = false },
                title = { Text(com.beeboentertainment.movie.rtc.CastRule.blockedTitle(network)) },
                text = { Text(com.beeboentertainment.movie.rtc.CastRule.blockedExplanation(network)) },
                confirmButton = { androidx.compose.material3.TextButton(onClick = { explain = false }) { Text("OK") } }
            )
        }
        return
    }
    AndroidView(
        modifier = modifier.size(44.dp),
        factory = { ctx ->
            MediaRouteButton(ctx).also { button -> CastHelper.setUpMediaRouteButton(ctx, button) }
        }
    )
}

/** Centered spinner used while a list loads. */
@Composable
fun LoadingBox(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

/** Visible, non-fatal error with a retry affordance — never a crash. */
@Composable
fun ErrorBox(message: String, onRetry: (() -> Unit)? = null, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                message,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onBackground
            )
            if (onRetry != null) {
                TextButton(onClick = onRetry) { Text("Try again") }
            }
        }
    }
}

@Composable
fun EmptyBox(message: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(message, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Small rounded label used for the quality badge ("1080p"). */
@Composable
fun QualityChip(text: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        color = MaterialTheme.colorScheme.primary,
        shape = RoundedCornerShape(4.dp)
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onPrimary
        )
    }
}

/**
 * Green "NEW" banner for recently-added titles, matching the website and the Windows app.
 * The server decides what counts as new (added in the last 7 days) and sends `isNew`.
 */
@Composable
fun NewBanner(modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        color = Color(0xFF2E9E44),
        shape = RoundedCornerShape(4.dp)
    ) {
        Text(
            "NEW",
            modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            color = Color.White
        )
    }
}

/**
 * One poster tile in a grid.
 *
 * `posterUrl` is null whenever the server has no cached poster for the item (the API returns
 * null, never an absolute URL), so a placeholder is the normal case, not an error case.
 */
@Composable
fun PosterCard(
    title: String,
    subtitle: String?,
    posterUrl: String?,
    quality: String?,
    isNew: Boolean = false,
    downloadState: DownloadBadge = DownloadBadge.NONE,
    onClick: () -> Unit,
    onDownload: (() -> Unit)? = null,
    /** The website's ℹ️ affordance: opens the title details overlay. */
    onInfo: (() -> Unit)? = null,
    /** The 🔗 franchise chip: present only when the title belongs to a collection. */
    onCollection: (() -> Unit)? = null,
    /** ▶ trailer button (top-right, under the details button): only for titles with a TMDB id. */
    onTrailer: (() -> Unit)? = null,
    /** Look-it-up button (bottom-right) for a title you don't have; ignored when onDownload is set. */
    onSearch: (() -> Unit)? = null,
    /** A title that isn't in the library: faded, mostly grey poster. */
    dimmed: Boolean = false,
    /** Short label in the top-left corner, e.g. "Not owned". */
    label: String? = null
) {
    // On a TV the corner buttons are too small to aim a remote at and would make every poster
    // four D-pad stops wide, so they stay visible but unfocusable there: select plays, and a long
    // press of select (or Menu / Info) opens the details overlay. A TV has no Download button at all.
    val isTv = LocalIsTv.current
    val cornerButton = Modifier.focusProperties { canFocus = !isTv }
    Column(
        Modifier
            .fillMaxWidth()
            .tvLongPress(onClick = onClick, onLongClick = onInfo)
            .clickable(onClick = onClick)
            .padding(4.dp)
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(2f / 3f)
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
        ) {
            if (posterUrl != null) {
                AsyncImage(
                    model = posterUrl,
                    contentDescription = title,
                    modifier = if (dimmed) Modifier.fillMaxSize().alpha(0.55f) else Modifier.fillMaxSize(),
                    colorFilter = if (dimmed) DimmedPosterFilter else null
                )
            } else {
                // No cached poster on the server — show a neutral placeholder.
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Filled.Movie,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            // Corner badges stack down the top-left so they stay readable at phone poster size
            // rather than crowding into one row.
            if (isNew || !quality.isNullOrBlank() || !label.isNullOrBlank()) {
                Column(
                    Modifier.align(Alignment.TopStart).padding(4.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp)
                ) {
                    if (isNew) NewBanner()
                    if (!quality.isNullOrBlank()) QualityChip(quality)
                    if (!label.isNullOrBlank()) NotOwnedChip(label)
                }
            }
            if (onInfo != null || onTrailer != null) {
                // Details on top, the trailer button under it: one column in the top-right corner.
                Column(
                    Modifier.align(Alignment.TopEnd).padding(2.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    if (onInfo != null) {
                        Box(Modifier.clip(RoundedCornerShape(50)).background(Color(0xAA000000))) {
                            IconButton(onClick = onInfo, modifier = cornerButton.size(30.dp)) {
                                Icon(
                                    Icons.Filled.Info,
                                    contentDescription = "Details",
                                    tint = Color.White,
                                    modifier = Modifier.size(17.dp)
                                )
                            }
                        }
                    }
                    if (onTrailer != null) {
                        // The YouTube play button itself (its own red and white), no dark circle behind it.
                        IconButton(onClick = onTrailer, modifier = cornerButton.size(30.dp)) {
                                Icon(
                                    androidx.compose.ui.res.painterResource(com.beeboentertainment.movie.R.drawable.ic_youtube),
                                    contentDescription = "Watch the trailer on YouTube",
                                    tint = Color.Unspecified,
                                    modifier = Modifier.size(width = 26.dp, height = 19.dp)
                                )
                        }
                    }
                }
            }
            if (onSearch != null && onDownload == null) {
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .padding(2.dp)
                        .clip(RoundedCornerShape(50))
                        .background(Color(0xAA000000))
                ) {
                    IconButton(onClick = onSearch, modifier = cornerButton.size(30.dp)) {
                        Icon(
                            Icons.Filled.Search,
                            contentDescription = "Look this up",
                            tint = Color.White,
                            modifier = Modifier.size(17.dp)
                        )
                    }
                }
            }
            if (onCollection != null) {
                // Bottom-left, so the four badges sit one per corner and stay readable.
                Box(
                    Modifier
                        .align(Alignment.BottomStart)
                        .padding(2.dp)
                        .clip(RoundedCornerShape(50))
                        .background(Color(0xAA000000))
                ) {
                    IconButton(onClick = onCollection, modifier = cornerButton.size(30.dp)) {
                        Icon(
                            Icons.Filled.Link,
                            contentDescription = "Part of a series",
                            tint = Color.White,
                            modifier = Modifier.size(17.dp)
                        )
                    }
                }
            }
            if (onDownload != null && TvFeatures.downloadsAvailable(isTv)) {
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .padding(2.dp)
                        .clip(RoundedCornerShape(50))
                        .background(Color(0xAA000000))
                ) {
                    IconButton(onClick = onDownload, modifier = cornerButton.size(32.dp)) {
                        when (downloadState) {
                            DownloadBadge.DONE -> Icon(
                                Icons.Filled.DownloadDone,
                                contentDescription = "Downloaded",
                                tint = Color(0xFF7BD88F),
                                modifier = Modifier.size(18.dp)
                            )
                            // In progress AND actionable: the ring shows it's working, the
                            // ✕ shows it can be stopped. Previously this was a bare spinner,
                            // which read as "nothing you can do".
                            DownloadBadge.RUNNING -> Box(contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(22.dp),
                                    strokeWidth = 2.dp,
                                    color = Color.White
                                )
                                Icon(
                                    Icons.Filled.Close,
                                    contentDescription = "Stop download",
                                    tint = Color.White,
                                    modifier = Modifier.size(12.dp)
                                )
                            }
                            DownloadBadge.NONE -> Icon(
                                Icons.Filled.Download,
                                contentDescription = "Download",
                                tint = Color.White,
                                modifier = Modifier.size(18.dp)
                            )
                        }
                    }
                }
            }
        }
        Text(
            title,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 4.dp),
            color = if (dimmed) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onBackground
        )
        if (!subtitle.isNullOrBlank()) {
            Text(
                subtitle,
                maxLines = 1,
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** Mostly grey: reads as "not yours yet" while the poster is still recognisable. */
private val DimmedPosterFilter = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0.25f) })

/** The small "Not owned" corner label. */
@Composable
fun NotOwnedChip(text: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        color = Color(0xCC3A1F22),
        shape = RoundedCornerShape(4.dp)
    ) {
        Text(
            text.uppercase(),
            modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
            color = Color(0xFFFF9D9D)
        )
    }
}

enum class DownloadBadge { NONE, RUNNING, DONE }

/**
 * Plain yes/no confirmation. Used for every download action — starting one costs gigabytes,
 * stopping or deleting one throws bytes away, so none of them should happen on a stray tap.
 */
@Composable
fun ConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = {
            TextButton(onClick = { onDismiss(); onConfirm() }) { Text(confirmLabel) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}

/**
 * The sticky A–Z jump bar that sits above the Movies and TV grids.
 * Letters with nothing behind them are dimmed and inert, matching the website.
 */
@Composable
fun AlphaBar(
    available: Set<Char>,
    onLetter: (Char) -> Unit,
    modifier: Modifier = Modifier
) {
    androidx.compose.foundation.lazy.LazyRow(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        items(com.beeboentertainment.movie.core.AlphaIndex.LETTERS.size) { i ->
            val letter = com.beeboentertainment.movie.core.AlphaIndex.LETTERS[i]
            val enabled = letter in available
            Box(
                Modifier
                    .size(width = 22.dp, height = 26.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .then(
                        if (enabled) Modifier.clickable { onLetter(letter) } else Modifier
                    ),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    letter.toString(),
                    fontSize = 12.sp,
                    fontWeight = if (enabled) FontWeight.Bold else FontWeight.Normal,
                    // dimmed == nothing filed under this letter
                    color = if (enabled) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f)
                )
            }
        }
    }
}

/** Full-width section header inside the poster grid. */
@Composable
fun LetterHeader(letter: Char) {
    Text(
        letter.toString(),
        fontSize = 15.sp,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 8.dp, top = 10.dp, bottom = 2.dp)
    )
}

/** Horizontal row of genre filter chips shared by the Movies and TV tabs. */
@Composable
fun GenreFilterRow(
    genres: List<com.beeboentertainment.movie.data.Genre>,
    selected: Int?,
    onSelect: (Int?) -> Unit
) {
    androidx.compose.foundation.lazy.LazyRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp)
    ) {
        item {
            androidx.compose.material3.FilterChip(
                selected = selected == null,
                onClick = { onSelect(null) },
                label = { Text("All") }
            )
        }
        items(genres.size) { i ->
            val g = genres[i]
            androidx.compose.material3.FilterChip(
                selected = selected == g.id,
                onClick = { onSelect(if (selected == g.id) null else g.id) },
                label = { Text(if (g.count > 0) "${g.name} (${g.count})" else g.name) }
            )
        }
    }
}
