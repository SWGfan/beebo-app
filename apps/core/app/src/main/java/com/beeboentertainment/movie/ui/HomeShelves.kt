package com.beeboentertainment.movie.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ShelfItem

/** The two discovery shelves' contents. Empty lists draw nothing. */
data class HomeShelvesData(
    val recent: List<ShelfItem> = emptyList(),
    val recommended: List<ShelfItem> = emptyList(),
    val recommendedReason: String = ""
) {
    /** The server writes "Because you watched X"; this only covers a missing name. */
    val recommendedHeading: String get() = recommendedReason.ifBlank { "Recommended for you" }
    val isEmpty: Boolean get() = recent.isEmpty() && recommended.isEmpty()

    companion object {
        /** Where the shelves live: My Library, after its lists (they mix films and shows). */
        const val RECENT_HEADING = "Recently added"

        /** A film tile plays; a TV tile carries a show key and opens the show. */
        fun opensShow(item: ShelfItem): Boolean = item.kind == "tv"

        fun showKeyOf(item: ShelfItem): String = item.showKey?.takeIf { it.isNotBlank() } ?: item.id
    }
}

/**
 * The shelves, painted from [com.beeboentertainment.movie.data.ShelfCache] at once and fetched
 * behind the screen that shows them - a LaunchedEffect runs after the first frame, so the list
 * above never waits for them. Best effort: a failure or a 401 just leaves them empty (the
 * screen's own list call handles sign-out).
 */
@Composable
fun rememberHomeShelves(enabled: Boolean = true): HomeShelvesData {
    val app = com.beeboentertainment.movie.BeeboApp.instance
    var data by androidx.compose.runtime.remember {
        androidx.compose.runtime.mutableStateOf(
            HomeShelvesData(
                recent = com.beeboentertainment.movie.data.ShelfCache.recentlyAdded()?.items.orEmpty(),
                recommended = com.beeboentertainment.movie.data.ShelfCache.recommended()?.items.orEmpty(),
                recommendedReason = com.beeboentertainment.movie.data.ShelfCache.recommended()?.reason.orEmpty()
            )
        )
    }
    androidx.compose.runtime.LaunchedEffect(enabled) {
        if (!enabled) return@LaunchedEffect
        if (!app.session.isLoggedIn || com.beeboentertainment.movie.data.ShelfCache.fresh()) return@LaunchedEffect
        val recent = runCatching { app.api.recentlyAdded() }.getOrNull()?.takeIf { it.ok }?.also {
            com.beeboentertainment.movie.data.ShelfCache.putRecentlyAdded(it)
            data = data.copy(recent = it.items)
        }
        val recommended = runCatching { app.api.recommended() }.getOrNull()?.takeIf { it.ok }?.also {
            com.beeboentertainment.movie.data.ShelfCache.putRecommended(it)
            data = data.copy(recommended = it.items, recommendedReason = it.reason)
        }
        if (recent != null && recommended != null) com.beeboentertainment.movie.data.ShelfCache.markFetched()
    }
    return data
}

/** Both shelves, one under the other. Nothing at all when both are empty. */
@Composable
fun HomeShelves(data: HomeShelvesData, baseUrl: String?, onOpen: (ShelfItem) -> Unit, modifier: Modifier = Modifier) {
    if (data.isEmpty) return
    Column(modifier.fillMaxWidth().padding(top = 8.dp)) {
        ShelfRow(HomeShelvesData.RECENT_HEADING, data.recent, baseUrl, onOpen)
        ShelfRow(data.recommendedHeading, data.recommended, baseUrl, onOpen)
    }
}

/**
 * One horizontal discovery shelf - "Recently added", or the server's own "Because you watched X".
 *
 * Renders NOTHING AT ALL for an empty list: no heading, no box, no spinner. A server that has
 * only just been set up genuinely has nothing to recommend, and an empty frame sitting above the
 * grid would turn that ordinary fact into something that looks broken. The caller owns the
 * loading state and simply never calls this with an empty list.
 */
@Composable
fun ShelfRow(
    heading: String,
    items: List<ShelfItem>,
    baseUrl: String?,
    onOpen: (ShelfItem) -> Unit,
    modifier: Modifier = Modifier
) {
    if (items.isEmpty()) return
    Column(modifier.fillMaxWidth()) {
        Text(
            heading,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(start = 8.dp, top = 8.dp, bottom = 6.dp)
        )
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(horizontal = 8.dp)
        ) {
            // A movie id and a show key come from different id spaces, so the kind is part of
            // the key rather than trusting the two never to collide.
            items(items, key = { it.kind + ":" + it.id }) { item ->
                ShelfTile(
                    title = item.title,
                    posterUrl = UrlUtils.join(baseUrl, item.poster),
                    onClick = { onOpen(item) }
                )
            }
        }
        Spacer(Modifier.height(6.dp))
    }
}

/**
 * One tile. Deliberately narrower than a grid poster so a shelf reads as a shelf and not as a
 * stray row of the grid underneath it.
 */
@Composable
private fun ShelfTile(title: String, posterUrl: String?, onClick: () -> Unit) {
    Column(
        Modifier
            .width(92.dp)
            .clickable(onClick = onClick)
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(2f / 3f)
                .clip(RoundedCornerShape(8.dp))
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
                // No cached poster on the server - the normal case for a title TMDB hasn't been
                // asked about yet, not an error.
                Icon(
                    Icons.Filled.Movie,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        Text(
            title,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            fontSize = 11.sp,
            lineHeight = 13.sp,
            modifier = Modifier.padding(top = 4.dp),
            color = MaterialTheme.colorScheme.onBackground
        )
    }
}

/**
 * Home's Collections shelf: the film series in the library, fetched once [enabled] (after
 * Continue has painted). Best effort: a failure, an old server or a sign-out leaves it empty.
 */
@Composable
fun rememberHomeCollections(enabled: Boolean): List<com.beeboentertainment.movie.data.CollectionSummary> {
    val app = com.beeboentertainment.movie.BeeboApp.instance
    var items by androidx.compose.runtime.remember {
        androidx.compose.runtime.mutableStateOf(emptyList<com.beeboentertainment.movie.data.CollectionSummary>())
    }
    androidx.compose.runtime.LaunchedEffect(enabled) {
        if (!enabled || !app.session.isLoggedIn || items.isNotEmpty()) return@LaunchedEffect
        runCatching { app.api.collections() }.getOrNull()?.takeIf { it.ok }?.let { items = it.items }
    }
    return items
}

/** One horizontal shelf of collections, with "See all" opening the Collections grid. */
@Composable
fun CollectionsShelf(
    items: List<com.beeboentertainment.movie.data.CollectionSummary>,
    baseUrl: String?,
    onOpen: (Int, String) -> Unit,
    onSeeAll: () -> Unit
) {
    if (items.isEmpty()) return
    Column(Modifier.fillMaxWidth()) {
        androidx.compose.foundation.layout.Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "Collections",
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.weight(1f)
            )
            androidx.compose.material3.TextButton(onClick = onSeeAll) { Text("See all") }
        }
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(horizontal = 8.dp)
        ) {
            items(items, key = { "collection:" + it.id }) { c ->
                val title = com.beeboentertainment.movie.core.CollectionsLogic.title(c)
                ShelfTile(
                    title = title,
                    posterUrl = UrlUtils.join(
                        baseUrl,
                        com.beeboentertainment.movie.core.CollectionsLogic.posterPath(c.poster, c.tmdbPoster)
                    ),
                    onClick = { onOpen(c.id, title) }
                )
            }
        }
        Spacer(Modifier.height(6.dp))
    }
}
