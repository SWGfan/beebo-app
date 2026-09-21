package com.beeboentertainment.movie.ui.screens

import com.beeboentertainment.movie.core.TrailerLogic
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.AlphaIndex
import com.beeboentertainment.movie.core.CollectionsLogic
import com.beeboentertainment.movie.core.TitleRequestLogic
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiException
import com.beeboentertainment.movie.data.CollectionDetail
import com.beeboentertainment.movie.data.CollectionPart
import com.beeboentertainment.movie.data.Movie
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.player.PlayerActivity
import com.beeboentertainment.movie.ui.CollectionTile
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.PosterCard
import com.beeboentertainment.movie.ui.RequestNoteDialog
import kotlinx.coroutines.launch

/**
 * One franchise — the app's twin of the website's Sequels view. Reached from the Collections
 * grid, the 🔗 poster chip, and "Part of the … Collection" in a film's details.
 *
 * `GET /api/collections/<id>` lists every film in release order: the ones you have play, the
 * ones you don't are dimmed and can be requested (the same request "Request a title" makes).
 * A server from before that endpoint answers 404, and this falls back to the old
 * owned-films-only grid from `GET /api/movies?collection=<id>`.
 */
@Composable
fun CollectionScreen(
    collectionId: Int,
    collectionName: String,
    onUnauthorized: () -> Unit
) {
    val app = BeeboApp.instance
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val openTrailer = com.beeboentertainment.movie.ui.rememberTrailerOpener(onUnauthorized)
    // The owner's chosen Movies search site, for the 🔍 on films not in the library (Google if unset).
    var movieSite by remember { mutableStateOf<com.beeboentertainment.movie.data.SearchSite?>(null) }
    LaunchedEffect(Unit) {
        runCatching { app.api.searchSites() }.getOrNull()?.let { movieSite = it.movies }
    }
    fun lookUp(title: String, year: Int?) {
        val url = com.beeboentertainment.movie.core.SearchSiteLogic.url(movieSite, title, year)
        if (!com.beeboentertainment.movie.ui.openExternalUrl(context, url)) {
            android.widget.Toast.makeText(context, "No web browser found on this device.", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    var detail by remember { mutableStateOf<CollectionDetail?>(null) }
    /** Only set on an older server with no /api/collections/<id>. */
    var legacy by remember { mutableStateOf<List<Movie>?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }

    var requestFor by remember { mutableStateOf<CollectionPart?>(null) }
    var requestBusy by remember { mutableStateOf(false) }
    var requestError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(collectionId, reloadKey) {
        loading = true
        error = null
        try {
            detail = app.api.collection(collectionId).collection
            legacy = null
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: ApiException) {
            if (e.code == 404) {
                try {
                    legacy = AlphaIndex.sorted(app.api.movies(collection = collectionId).items) { it.title }
                } catch (e2: UnauthorizedException) {
                    onUnauthorized()
                } catch (e2: Exception) {
                    error = e2.message ?: "Couldn't load this collection."
                }
            } else {
                error = e.message ?: "Couldn't load this collection."
            }
        } catch (e: Exception) {
            error = e.message ?: "Couldn't load this collection."
        } finally {
            loading = false
        }
    }

    fun play(movie: Movie) {
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

    fun choose(part: CollectionPart) {
        val movie = part.movie
        when (CollectionsLogic.partAction(part)) {
            CollectionsLogic.PartAction.PLAY -> if (movie != null) play(movie)
            CollectionsLogic.PartAction.REQUEST, CollectionsLogic.PartAction.REQUESTED_BY_OTHERS -> {
                requestError = null
                requestFor = part
            }
            CollectionsLogic.PartAction.REQUESTED_BY_YOU -> notice = "You've already asked for ${part.title}."
            CollectionsLogic.PartAction.ADDED -> notice = "${part.title} has been marked as added — it should appear shortly."
            CollectionsLogic.PartAction.DISMISSED -> notice = "The owner isn't getting ${part.title}."
        }
    }

    val shownDetail = detail
    val shownLegacy = legacy
    when {
        loading -> LoadingBox()
        error != null -> ErrorBox(error!!, onRetry = { reloadKey++ })
        shownDetail != null -> LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 110.dp),
            contentPadding = PaddingValues(8.dp),
            modifier = Modifier.fillMaxSize()
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column(Modifier.padding(start = 4.dp, top = 4.dp, bottom = 6.dp)) {
                    Text(CollectionsLogic.title(shownDetail), fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text(
                        CollectionsLogic.detailSummary(shownDetail),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    if (shownDetail.ownedCount < shownDetail.total) {
                        Text(
                            "In release order. Dimmed films aren't in your library — pick one to request it.",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    notice?.let {
                        Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }
            items(shownDetail.parts, key = { it.tmdbId }) { part ->
                val movie = part.movie
                CollectionTile(
                    title = part.title,
                    subtitle = part.year?.toString(),
                    posterUrl = UrlUtils.join(
                        app.session.baseUrl,
                        CollectionsLogic.posterPath(movie?.poster ?: part.poster, part.tmdbPoster)
                    ),
                    badge = CollectionsLogic.partBadge(part) ?: movie?.quality,
                    dimmed = !part.owned,
                    onTrailer = part.tmdbId.takeIf { TrailerLogic.canShow(it) }?.let { id -> { openTrailer("movie", id) } },
                    onSearch = if (part.owned) null else ({ lookUp(part.title, part.year) }),
                    onClick = { choose(part) }
                )
            }
        }
        shownLegacy != null && shownLegacy.isEmpty() -> EmptyBox("Nothing from $collectionName is in your library.")
        shownLegacy != null -> LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 110.dp),
            contentPadding = PaddingValues(8.dp),
            modifier = Modifier.fillMaxSize()
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column(Modifier.padding(start = 4.dp, top = 4.dp, bottom = 6.dp)) {
                    Text(collectionName, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text("${shownLegacy.size} in your library", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            items(shownLegacy, key = { it.id }) { movie ->
                PosterCard(
                    title = movie.title,
                    subtitle = movie.year?.toString(),
                    posterUrl = UrlUtils.join(app.session.baseUrl, movie.poster),
                    quality = movie.quality,
                    isNew = movie.isNew,
                    onTrailer = movie.tmdbId?.takeIf { TrailerLogic.canShow(it) }?.let { id -> { openTrailer("movie", id) } },
                    onClick = { play(movie) }
                )
            }
        }
        else -> EmptyBox("Nothing from $collectionName is in your library.")
    }

    val pending = requestFor
    if (pending != null) {
        RequestNoteDialog(
            title = pending.title,
            subtitle = listOfNotNull("Film", pending.year?.toString()).joinToString(" · "),
            posterUrl = UrlUtils.join(app.session.baseUrl, CollectionsLogic.posterPath(pending.poster, pending.tmdbPoster)),
            busy = requestBusy,
            error = requestError,
            onSubmit = { note ->
                requestBusy = true
                requestError = null
                scope.launch {
                    try {
                        val r = app.api.requestTitle(
                            TitleRequestLogic.buildCreate("movie", pending.tmdbId, pending.title, pending.year, note, pending.tmdbPoster)
                        )
                        detail = detail?.let {
                            CollectionsLogic.withRequested(it, pending.tmdbId, r.request?.id.orEmpty(), r.request?.status ?: "requested")
                        }
                        notice = TitleRequestLogic.successMessage(pending.title, r.created, r.deduped, r.appended)
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
