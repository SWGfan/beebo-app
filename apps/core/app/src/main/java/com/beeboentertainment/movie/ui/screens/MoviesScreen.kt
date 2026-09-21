package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.AlphaIndex
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.CatalogCache
import com.beeboentertainment.movie.data.CastMember
import com.beeboentertainment.movie.data.Genre
import com.beeboentertainment.movie.data.Movie
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.downloads.DownloadIndex
import com.beeboentertainment.movie.downloads.DownloadStatus
import com.beeboentertainment.movie.player.PlayerActivity
import com.beeboentertainment.movie.ui.AlphaBar
import com.beeboentertainment.movie.ui.ConfirmDialog
import com.beeboentertainment.movie.ui.DownloadBadge
import com.beeboentertainment.movie.ui.LetterHeader
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.GenreFilterRow
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.PosterCard
import com.beeboentertainment.movie.ui.LibraryControlsRow
import com.beeboentertainment.movie.ui.LibraryTarget
import com.beeboentertainment.movie.ui.TitleDetailsDialog
import kotlinx.coroutines.launch

/** Plays a film, from its download when there is one. Shared by Movies, Browse and search. */
fun playMovie(context: android.content.Context, movie: Movie) {
    val app = BeeboApp.instance
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

/**
 * A film's details overlay and its download confirmation, shared by the Films grid and Browse's
 * All grid and search results, so a film behaves the same wherever it is tapped.
 */
@Composable
fun MovieOverlays(
    detailsFor: Movie?,
    pendingDownloadFor: Movie?,
    genres: List<Genre>,
    onDismissDetails: () -> Unit,
    onAskDownload: (Movie) -> Unit,
    onDismissDownload: () -> Unit,
    onUnauthorized: () -> Unit,
    onOpenActor: (Int, String) -> Unit,
    onOpenCollection: (Int, String) -> Unit
) {
    val app = BeeboApp.instance
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val downloads by app.downloads.items.collectAsState()
    val downloadsById = remember(downloads) { downloads.associateBy { it.id } }
    /** Cast for that movie. Empty means "nothing cached" - the row renders nothing at all. */
    var detailsCast by remember { mutableStateOf<List<CastMember>>(emptyList()) }
    val openTrailer = com.beeboentertainment.movie.ui.rememberTrailerOpener(onUnauthorized)

    // Credits are fetched only when the overlay actually opens, never for the whole grid.
    LaunchedEffect(detailsFor?.id) {
        val id = detailsFor?.id
        detailsCast = if (id.isNullOrBlank()) emptyList()
        else runCatching { app.api.credits("movie", id).cast }.getOrDefault(emptyList())
    }

    /**
     * Carry out a confirmed download action. Which one it is depends on the row's live state,
     * so a tap on something already downloading STOPS it rather than starting it again.
     */
    fun performDownloadAction(movie: Movie, action: DownloadIndex.TapAction) {
        when (action) {
            DownloadIndex.TapAction.STOP -> app.downloads.stop(movie.id)
            DownloadIndex.TapAction.DELETE -> app.downloads.delete(movie.id)
            DownloadIndex.TapAction.START -> {
                val stream = UrlUtils.join(app.session.baseUrl, movie.stream) ?: return
                app.downloads.enqueue(
                    id = movie.id,
                    kind = "movie",
                    title = movie.title,
                    streamUrl = stream,
                    posterUrl = UrlUtils.join(app.session.baseUrl, movie.poster)
                )
            }
        }
    }

    val pending = pendingDownloadFor
    if (pending != null) {
        val action = DownloadIndex.tapAction(downloadsById[pending.id])
        ConfirmDialog(
            title = DownloadIndex.confirmTitle(action),
            message = DownloadIndex.confirmMessage(action, pending.title),
            confirmLabel = DownloadIndex.confirmButton(action),
            onConfirm = { performDownloadAction(pending, action) },
            onDismiss = onDismissDownload
        )
    }

    val details = detailsFor
    if (details != null) {
        TitleDetailsDialog(
            title = details.title,
            year = details.year,
            quality = details.quality,
            overview = details.overview,
            // ids -> names using the genre list the same response already gave us
            genreNames = details.genres.mapNotNull { id -> genres.firstOrNull { it.id == id }?.name },
            posterUrl = UrlUtils.join(app.session.baseUrl, details.poster),
            isDownloaded = app.downloads.get(details.id)?.isComplete == true,
            cast = detailsCast,
            baseUrl = app.session.baseUrl,
            libraryControls = {
                LibraryControlsRow(
                    target = LibraryTarget(
                        kind = "movie",
                        id = details.id,
                        title = details.title,
                        poster = details.poster,
                        stream = details.stream
                    ),
                    onUnauthorized = onUnauthorized
                )
            },
            onActor = { person -> onOpenActor(person.id, person.name) },
            partOf = details.collectionId?.let {
                com.beeboentertainment.movie.core.CollectionsLogic.partOfLine(details.collectionName)
                    ?: "Part of a collection"
            },
            onPartOf = details.collectionId?.let { id ->
                { onOpenCollection(id, details.collectionName.orEmpty()) }
            },
            onTrailer = details.tmdbId?.takeIf { com.beeboentertainment.movie.core.TrailerLogic.canShow(it) }
                ?.let { id -> { openTrailer("movie", id) } },
            onPlay = { playMovie(context, details) },
            onDownload = { onAskDownload(details) },
            onFlag = { scope.launch { runCatching { app.api.flagQuality("movie", details.id) } } },
            onDismiss = onDismissDetails
        )
    }
}
