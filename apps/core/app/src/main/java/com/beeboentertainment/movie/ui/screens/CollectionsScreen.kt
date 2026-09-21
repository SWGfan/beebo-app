package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.CollectionsLogic
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.CollectionSummary
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.ui.CollectionTile
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.dpadFocusRing

/**
 * Every film franchise the library owns part of, as a poster grid. Reached from the Movies tab.
 * A tile opens that collection's page (CollectionScreen), which lists the films in release
 * order, owned and not.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CollectionsScreen(
    onOpenCollection: (Int, String) -> Unit,
    onRequestTitle: () -> Unit,
    onUnauthorized: () -> Unit
) {
    val app = BeeboApp.instance

    var items by remember { mutableStateOf<List<CollectionSummary>>(emptyList()) }
    var unchecked by remember { mutableStateOf(0) }
    var refreshing by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var filterName by rememberSaveable { mutableStateOf(CollectionsLogic.Filter.ALL.name) }
    var query by rememberSaveable { mutableStateOf("") }
    val filter = CollectionsLogic.Filter.valueOf(filterName)

    LaunchedEffect(reloadKey) {
        loading = items.isEmpty()
        error = null
        try {
            val r = app.api.collections()
            items = r.items
            unchecked = r.unchecked
            refreshing = r.refreshing
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            error = e.message ?: "Couldn't load your collections."
        } finally {
            loading = false
        }
    }

    val visible = remember(items, filter, query) { CollectionsLogic.filter(items, filter, query) }

    Column(Modifier.fillMaxSize()) {
        if (items.size > 8) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text("Search collections") },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 4.dp)
            )
        }
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CollectionsLogic.Filter.entries.forEach { f ->
                FilterChip(
                    selected = f == filter,
                    onClick = { filterName = f.name },
                    label = { Text(f.label) }
                )
            }
            if (com.beeboentertainment.movie.core.ProfileLimits.of(com.beeboentertainment.movie.BeeboApp.instance.session.isAdmin, com.beeboentertainment.movie.BeeboApp.instance.session.isRestricted, com.beeboentertainment.movie.BeeboApp.instance.session.isGuest).showRequests) TextButton(onClick = onRequestTitle, modifier = Modifier.dpadFocusRing()) { Text("🙋 Request a title") }
        }

        when {
            loading -> LoadingBox()
            error != null -> ErrorBox(error!!, onRetry = { reloadKey++ })
            items.isEmpty() -> EmptyBox(
                if (unchecked > 0 || refreshing) {
                    "No collections found yet. $unchecked of your films are still being checked " +
                        "— come back in a few minutes."
                } else {
                    "No collections yet. When your library has a film from a series (Alien, Toy Story, " +
                        "Harry Potter…), the series shows up here."
                }
            )
            visible.isEmpty() -> EmptyBox("No collections match.")
            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 120.dp),
                contentPadding = PaddingValues(8.dp),
                modifier = Modifier.fillMaxSize()
            ) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Column(Modifier.padding(start = 4.dp, top = 2.dp, bottom = 6.dp)) {
                        Text("${items.size} collection${if (items.size == 1) "" else "s"}", fontSize = 13.sp, fontWeight = FontWeight.Bold)
                        if (unchecked > 0) {
                            Text(
                                "$unchecked film${if (unchecked == 1) " is" else "s are"} still being checked for a series.",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
                items(visible, key = { it.id }) { c ->
                    CollectionTile(
                        title = CollectionsLogic.title(c),
                        subtitle = CollectionsLogic.subtitle(c),
                        posterUrl = UrlUtils.join(app.session.baseUrl, CollectionsLogic.posterPath(c.poster, c.tmdbPoster)),
                        badge = if (c.complete) "Complete" else null,
                        onClick = { onOpenCollection(c.id, CollectionsLogic.title(c)) }
                    )
                }
            }
        }
    }
}
