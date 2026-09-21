package com.beeboentertainment.movie.ui.screens

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.MissingTitlesLogic
import com.beeboentertainment.movie.core.SearchSiteLogic
import com.beeboentertainment.movie.core.TitleRequestLogic
import com.beeboentertainment.movie.core.TrailerLogic
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.MissingTitle
import com.beeboentertainment.movie.data.Movie
import com.beeboentertainment.movie.data.SearchSite
import com.beeboentertainment.movie.data.TvShow
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.player.PlayerActivity
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.PosterCard
import com.beeboentertainment.movie.ui.RequestNoteDialog
import com.beeboentertainment.movie.ui.dpadFocusRing
import com.beeboentertainment.movie.ui.openExternalUrl
import com.beeboentertainment.movie.ui.rememberTrailerOpener
import kotlinx.coroutines.launch

/**
 * "This actor's other titles" — reached by tapping a face in the cast row.
 *
 * Both library endpoints take an `actor` filter (a TMDB person id, not a name), so the top is
 * just the two of them side by side under one heading. Under them, "Not in your library" lists
 * the person's other well-known work the library doesn't have (GET /api/actor/<id>/missing), so
 * people get an idea what to look for next. That part is extra: if it fails, or the server is
 * older, or there's no internet, it simply doesn't appear.
 */
@Composable
fun ActorScreen(
    personId: Int,
    personName: String,
    onOpenShow: (String) -> Unit,
    onUnauthorized: () -> Unit
) {
    val app = BeeboApp.instance
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val openTrailer = rememberTrailerOpener(onUnauthorized)

    var movies by remember { mutableStateOf<List<Movie>>(emptyList()) }
    var shows by remember { mutableStateOf<List<TvShow>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    var missing by remember { mutableStateOf<List<MissingTitle>>(emptyList()) }
    var missingLoading by remember { mutableStateOf(true) }
    var movieSite by remember { mutableStateOf<SearchSite?>(null) }
    var tvSite by remember { mutableStateOf<SearchSite?>(null) }

    var sheetFor by remember { mutableStateOf<MissingTitle?>(null) }
    var requestFor by remember { mutableStateOf<MissingTitle?>(null) }
    var requestBusy by remember { mutableStateOf(false) }
    var requestError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(personId, reloadKey) {
        loading = true
        error = null
        try {
            movies = app.api.movies(actor = personId).items
            shows = app.api.tvShows(actor = personId).items
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            error = e.message ?: "Couldn't load this actor's titles."
        } finally {
            loading = false
        }
    }

    LaunchedEffect(personId, reloadKey) {
        missingLoading = true
        try {
            missing = app.api.actorMissing(personId).items
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            // Older server, no internet, TMDB down: the section just isn't shown.
            missing = emptyList()
        } finally {
            missingLoading = false
        }
        if (missing.isNotEmpty()) {
            runCatching { app.api.searchSites() }.getOrNull()?.let {
                movieSite = it.movies
                tvSite = it.tv
            }
        }
    }

    val ownedMovieIds = remember(movies) { movies.mapNotNull { it.tmdbId }.toSet() }
    val ownedShowIds = remember(shows) { shows.mapNotNull { it.tmdbId }.toSet() }
    val notOwned = remember(missing, ownedMovieIds, ownedShowIds) {
        val kept = MissingTitlesLogic.withoutOwned(missing, ownedMovieIds, ownedShowIds)
        MissingTitlesLogic.films(kept) + MissingTitlesLogic.shows(kept)
    }

    fun search(item: MissingTitle, site: SearchSite?) {
        val url = SearchSiteLogic.url(site, item.title, item.year)
        if (!openExternalUrl(context, url)) {
            Toast.makeText(context, "No web browser found on this device.", Toast.LENGTH_SHORT).show()
        }
    }
    fun siteFor(item: MissingTitle): SearchSite = SearchSiteLogic.siteFor(item.kind, movieSite, tvSite)

    when {
        loading -> LoadingBox()
        error != null -> ErrorBox(error!!, onRetry = { reloadKey++ })
        movies.isEmpty() && shows.isEmpty() && notOwned.isEmpty() && !missingLoading ->
            EmptyBox("Nothing else with $personName in your library.")
        else -> LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 110.dp),
            contentPadding = PaddingValues(8.dp),
            modifier = Modifier.fillMaxSize()
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column(Modifier.padding(start = 4.dp, top = 4.dp, bottom = 6.dp)) {
                    Text(personName, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text(
                        if (movies.isEmpty() && shows.isEmpty()) "Nothing with them in your library yet" else "In your library",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            if (movies.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) { SectionLabel("Movies") }
                items(movies, key = { "m-" + it.id }) { movie ->
                    PosterCard(
                        title = movie.title,
                        subtitle = movie.year?.toString(),
                        posterUrl = UrlUtils.join(app.session.baseUrl, movie.poster),
                        quality = movie.quality,
                        onTrailer = movie.tmdbId?.takeIf { TrailerLogic.canShow(it) }?.let { id -> { openTrailer("movie", id) } },
                        onClick = {
                            context.startActivity(
                                PlayerActivity.intentFor(
                                    context,
                                    itemId = movie.id,
                                    kind = "movie",
                                    title = movie.title,
                                    streamUrl = UrlUtils.join(app.session.baseUrl, movie.stream),
                                    localPath = app.downloads.localPath(movie.id),
                                    posterUrl = UrlUtils.join(app.session.baseUrl, movie.poster)
                                )
                            )
                        }
                    )
                }
            }

            if (shows.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) { SectionLabel("TV Shows") }
                items(shows, key = { "t-" + it.key }) { show ->
                    PosterCard(
                        title = show.name,
                        subtitle = if (show.episodeCount > 0) "${show.episodeCount} episodes" else null,
                        posterUrl = UrlUtils.join(app.session.baseUrl, show.poster),
                        quality = show.quality,
                        onTrailer = show.tmdbId?.takeIf { TrailerLogic.canShow(it) }?.let { id -> { openTrailer("tv", id) } },
                        onClick = { onOpenShow(show.key) }
                    )
                }
            }

            if (missingLoading) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Row(Modifier.padding(start = 4.dp, top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.height(16.dp).width(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("Looking for their other titles…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            } else if (notOwned.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Column(Modifier.padding(top = 10.dp)) {
                        SectionLabel(MissingTitlesLogic.SECTION_TITLE)
                        Text(
                            MissingTitlesLogic.SECTION_HINT,
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 4.dp, bottom = 2.dp)
                        )
                    }
                }
                items(notOwned, key = { "x-" + it.kind + "-" + it.tmdbId }) { item ->
                    PosterCard(
                        title = item.title,
                        subtitle = MissingTitlesLogic.subtitle(item),
                        posterUrl = item.poster,
                        quality = null,
                        dimmed = true,
                        label = MissingTitlesLogic.badge(item),
                        onTrailer = { openTrailer(item.kind, item.tmdbId) },
                        onSearch = { search(item, siteFor(item)) },
                        onClick = { sheetFor = item }
                    )
                }
            }
        }
    }

    val sheet = sheetFor
    if (sheet != null) {
        MissingTitleSheet(
            item = sheet,
            site = siteFor(sheet),
            onTrailer = { openTrailer(sheet.kind, sheet.tmdbId) },
            onSearch = { site -> search(sheet, site) },
            onRequest = {
                sheetFor = null
                requestError = null
                requestFor = sheet
            },
            onDismiss = { sheetFor = null }
        )
    }

    val pending = requestFor
    if (pending != null) {
        RequestNoteDialog(
            title = pending.title,
            subtitle = MissingTitlesLogic.subtitle(pending),
            posterUrl = pending.poster,
            busy = requestBusy,
            error = requestError,
            onSubmit = { note ->
                requestBusy = true
                requestError = null
                scope.launch {
                    try {
                        val r = app.api.requestTitle(
                            TitleRequestLogic.buildCreate(pending.kind, pending.tmdbId, pending.title, pending.year, note, pending.poster)
                        )
                        missing = MissingTitlesLogic.markRequested(
                            missing, pending.kind, pending.tmdbId, r.request?.id.orEmpty(), r.request?.status ?: "requested"
                        )
                        Toast.makeText(
                            context,
                            TitleRequestLogic.successMessage(pending.title, r.created, r.deduped, r.appended),
                            Toast.LENGTH_LONG
                        ).show()
                        requestFor = null
                    } catch (e: UnauthorizedException) {
                        requestFor = null
                        onUnauthorized()
                    } catch (e: Exception) {
                        requestError = e.message ?: "Couldn't send the request."
                    } finally {
                        requestBusy = false
                    }
                }
            },
            onDismiss = { requestFor = null }
        )
    }
}

/** What you can do with a title you don't have: trailer, look it up, ask the owner for it. */
@Composable
private fun MissingTitleSheet(
    item: MissingTitle,
    site: SearchSite,
    onTrailer: () -> Unit,
    onSearch: (SearchSite) -> Unit,
    onRequest: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text(item.title, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                val sub = listOfNotNull(MissingTitlesLogic.subtitle(item), MissingTitlesLogic.roleLine(item)).joinToString(" · ")
                Text(sub, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Row {
                    Box(
                        Modifier
                            .width(80.dp)
                            .height(120.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant),
                        contentAlignment = Alignment.Center
                    ) {
                        if (item.poster != null) {
                            AsyncImage(model = item.poster, contentDescription = item.title, modifier = Modifier.fillMaxSize())
                        } else {
                            Icon(Icons.Filled.Movie, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Spacer(Modifier.width(12.dp))
                    Text(
                        item.overview?.takeIf { it.isNotBlank() } ?: "This isn't in your library yet.",
                        fontSize = 13.sp,
                        modifier = Modifier.weight(1f).heightIn(max = 160.dp).verticalScroll(rememberScrollState())
                    )
                }
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = onTrailer, modifier = Modifier.fillMaxWidth().dpadFocusRing()) {
                    Text("▶ Watch the trailer on YouTube")
                }
                OutlinedButton(onClick = { onSearch(site) }, modifier = Modifier.fillMaxWidth().dpadFocusRing()) {
                    Text("🔍 " + SearchSiteLogic.buttonLabel(site))
                }
                if (SearchSiteLogic.showGoogleToo(site)) {
                    OutlinedButton(onClick = { onSearch(SearchSiteLogic.GOOGLE) }, modifier = Modifier.fillMaxWidth().dpadFocusRing()) {
                        Text("🔎 Search Google")
                    }
                }
                if (MissingTitlesLogic.canRequest(item)) {
                    OutlinedButton(onClick = onRequest, modifier = Modifier.fillMaxWidth().dpadFocusRing()) {
                        Text(MissingTitlesLogic.requestButtonLabel(item))
                    }
                } else {
                    Text(
                        MissingTitlesLogic.requestButtonLabel(item),
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(top = 8.dp)
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Close") }
        }
    )
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 4.dp, top = 10.dp, bottom = 2.dp)
    )
}
