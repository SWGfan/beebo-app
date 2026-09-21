package com.beeboentertainment.movie.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.beeboentertainment.movie.core.TvFeatures
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.ui.tv.LocalIsTv
import com.beeboentertainment.movie.data.CastMember

/**
 * A row of circular cast photos with names, matching the website's ℹ️ panel.
 *
 * Renders NOTHING at all when the cast list is empty — an empty state here would just be noise,
 * and an empty list simply means nothing is cached yet. `profile` is null for people with no
 * cached photo (initials stand in), and `character` is usually null today, so its line is omitted
 * rather than left blank. Tapping a face lists that person's other titles.
 */
@Composable
fun CastRow(
    cast: List<CastMember>,
    baseUrl: String?,
    onActor: (CastMember) -> Unit,
    modifier: Modifier = Modifier
) {
    if (cast.isEmpty()) return
    Column(modifier) {
        Text(
            "Cast",
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary
        )
        Spacer(Modifier.height(6.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            items(cast, key = { it.id }) { person ->
                Column(
                    modifier = Modifier
                        .width(64.dp)
                        .clickable { onActor(person) },
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    val profileUrl = UrlUtils.join(baseUrl, person.profile)
                    Box(
                        Modifier
                            .size(56.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.surfaceVariant),
                        contentAlignment = Alignment.Center
                    ) {
                        if (profileUrl != null) {
                            AsyncImage(
                                model = profileUrl,
                                contentDescription = person.name,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize()
                            )
                        } else {
                            // no cached photo — initials rather than a broken image
                            Text(
                                initialsOf(person.name),
                                fontSize = 16.sp,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(
                        person.name,
                        fontSize = 10.sp,
                        maxLines = 2,
                        textAlign = TextAlign.Center,
                        lineHeight = 12.sp
                    )
                    // character is optional and usually absent today
                    person.character?.takeIf { it.isNotBlank() }?.let {
                        Text(
                            it,
                            fontSize = 9.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            textAlign = TextAlign.Center,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

/** "Al Pacino" -> "AP"; used when a person has no cached photo. */
fun initialsOf(name: String): String =
    name.trim().split(Regex("\\s+"))
        .filter { it.isNotBlank() }
        .take(2)
        .map { it.first().uppercaseChar() }
        .joinToString("")
        .ifBlank { "?" }

/**
 * The title details overlay — the app's twin of the website's ℹ️ panel.
 *
 * Poster, year, quality badge, genre chips, the overview, and the main cast as tappable
 * circular photos.
 */
@Composable
fun TitleDetailsDialog(
    title: String,
    year: Int?,
    quality: String?,
    overview: String?,
    genreNames: List<String>,
    posterUrl: String?,
    isDownloaded: Boolean = false,
    /** TV shows have no single file to download or flag, so those actions are hidden. */
    showDownloadAction: Boolean = true,
    showFlagAction: Boolean = true,
    playLabel: String = "▶ Play",
    extraLine: String? = null,
    cast: List<CastMember> = emptyList(),
    baseUrl: String? = null,
    /**
     * Favourite / watchlist / watched controls for this title. A slot rather than fixed content
     * so the dialog stays a pure presenter: a screen with no library target for what it is
     * showing simply passes nothing, and nothing is drawn.
     */
    libraryControls: (@Composable () -> Unit)? = null,
    onActor: (CastMember) -> Unit = {},
    /** "Part of the Alien Collection" - a film in a franchise; tapping opens that collection. */
    partOf: String? = null,
    onPartOf: (() -> Unit)? = null,
    /** "▶ Watch the trailer" - only for a title with a TMDB id. Reachable with a TV remote, unlike the poster button. */
    onTrailer: (() -> Unit)? = null,
    onPlay: () -> Unit,
    onDownload: () -> Unit = {},
    onFlag: () -> Unit = {},
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text(title, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                val sub = listOfNotNull(year?.toString(), quality, extraLine).joinToString(" · ")
                if (sub.isNotBlank()) {
                    Text(sub, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Row {
                    Box(
                        Modifier
                            .width(90.dp)
                            .height(135.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant),
                        contentAlignment = Alignment.Center
                    ) {
                        if (posterUrl != null) {
                            AsyncImage(
                                model = posterUrl,
                                contentDescription = title,
                                modifier = Modifier.fillMaxSize()
                            )
                        } else {
                            Icon(
                                Icons.Filled.Movie,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        if (genreNames.isNotEmpty()) {
                            // Wrapped by hand: FlowRow is still experimental in this Compose version.
                            genreNames.chunked(2).forEach { rowGenres ->
                                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    rowGenres.forEach { g ->
                                        AssistChip(onClick = {}, label = { Text(g, fontSize = 11.sp) })
                                    }
                                }
                                Spacer(Modifier.height(4.dp))
                            }
                        }
                    }
                }
                if (partOf != null && onPartOf != null) {
                    Spacer(Modifier.height(8.dp))
                    TextButton(
                        onClick = { onDismiss(); onPartOf() },
                        modifier = Modifier.dpadFocusRing()
                    ) {
                        Text("🔗 $partOf ›", fontSize = 13.sp)
                    }
                }
                if (onTrailer != null && com.beeboentertainment.movie.core.ProfileLimits.of(com.beeboentertainment.movie.BeeboApp.instance.session.isAdmin, com.beeboentertainment.movie.BeeboApp.instance.session.isRestricted, com.beeboentertainment.movie.BeeboApp.instance.session.isGuest).showTrailers) {
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = onTrailer, modifier = Modifier.dpadFocusRing()) {
                        Text("▶ Watch the trailer on YouTube", fontSize = 13.sp)
                    }
                }
                if (libraryControls != null) {
                    Spacer(Modifier.height(12.dp))
                    libraryControls()
                }
                if (!overview.isNullOrBlank()) {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        overview,
                        fontSize = 13.sp,
                        modifier = Modifier.heightIn(max = 180.dp)
                    )
                }
                if (cast.isNotEmpty()) {
                    Spacer(Modifier.height(14.dp))
                    CastRow(cast = cast, baseUrl = baseUrl, onActor = onActor)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onDismiss(); onPlay() }) { Text(playLabel) }
        },
        dismissButton = {
            Row {
                if (showFlagAction) {
                    TextButton(onClick = { onDismiss(); onFlag() }) { Text("⚠ Bad quality") }
                }
                if (showDownloadAction && TvFeatures.downloadsAvailable(LocalIsTv.current)) {
                    TextButton(onClick = { onDismiss(); onDownload() }) {
                        Text(if (isDownloaded) "Delete" else "Download")
                    }
                }
            }
        }
    )
}
