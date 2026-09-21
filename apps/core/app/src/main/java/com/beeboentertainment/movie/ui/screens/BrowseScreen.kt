package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.AlphaIndex
import com.beeboentertainment.movie.core.BrowseFilter
import com.beeboentertainment.movie.core.BrowseLogic
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.CatalogCache
import com.beeboentertainment.movie.data.Genre
import com.beeboentertainment.movie.data.Movie
import com.beeboentertainment.movie.data.MoviesResponse
import com.beeboentertainment.movie.data.TvShow
import com.beeboentertainment.movie.data.TvShowsResponse
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.downloads.DownloadStatus
import com.beeboentertainment.movie.ui.AlphaBar
import com.beeboentertainment.movie.ui.DownloadBadge
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.GenreFilterRow
import com.beeboentertainment.movie.ui.LetterHeader
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.PosterCard
import com.beeboentertainment.movie.core.TrailerLogic
import com.beeboentertainment.movie.ui.tv.DpadTextField
import com.beeboentertainment.movie.ui.tv.LocalIsTv
import kotlinx.coroutines.launch

/**
 * Browse: films AND shows in one place.
 *
 * The All / Films / Shows switch picks which titles go in the one A-Z grid, so all three look
 * the same: genre chips (combined TV genres split, see BrowseLogic.splitGenre), the A-Z bar, and
 * the same poster cards and details overlays. The one search box searches both whichever switch
 * is on, best match first, and a search that finds nothing offers "Request this title".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrowseScreen(
    filter: BrowseFilter,
    onFilterChange: (BrowseFilter) -> Unit,
    /** True once when the top bar's search icon brought us here; [onSearchFocused] clears it. */
    focusSearch: Boolean,
    onSearchFocused: () -> Unit,
    onUnauthorized: () -> Unit,
    onOpenShow: (String) -> Unit,
    onOpenActor: (Int, String) -> Unit,
    onOpenCollection: (Int, String) -> Unit,
    onOpenCollections: () -> Unit,
    /** Opens Request a title; the query and switch prefill it when a search found nothing. */
    onRequestTitle: (query: String, filter: BrowseFilter) -> Unit,
    /** Opens a music route (an album or an artist). */
    onOpenMusic: (String) -> Unit = {}
) {
    val isTv = LocalIsTv.current
    var query by rememberSaveable { mutableStateOf("") }
    val searchFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    LaunchedEffect(focusSearch) {
        if (focusSearch) {
            runCatching { searchFocus.requestFocus() }
            if (!isTv) keyboard?.show()
            onSearchFocused()
        }
    }

    Column(Modifier.fillMaxSize()) {
        // Music is its own library (artists, albums, songs, its own search), so the switch comes
        // first and the films-and-shows search box, chips and grid only belong to the other three.
        if (filter == BrowseFilter.MUSIC) {
            BrowseSwitch(filter, onFilterChange)
            com.beeboentertainment.movie.music.MusicBrowse(
                onOpenAlbum = { onOpenMusic(com.beeboentertainment.movie.music.MusicRoutes.album(it)) },
                onOpenArtist = { onOpenMusic(com.beeboentertainment.movie.music.MusicRoutes.artist(it)) },
                onUnauthorized = onUnauthorized
            )
            return@Column
        }
        // On a TV the box opens its keyboard on select, not whenever the D-pad passes over it.
        DpadTextField(
            Modifier.fillMaxWidth(),
            frameFocusRequester = if (isTv) searchFocus else null
        ) { tv ->
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text("Search films and shows") },
                singleLine = true,
                modifier = tv
                    .then(if (isTv) Modifier else Modifier.focusRequester(searchFocus))
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 4.dp)
            )
        }
        BrowseSwitch(filter, onFilterChange)
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            AssistChip(onClick = onOpenCollections, label = { Text("🎞️ Collections") })
            if (com.beeboentertainment.movie.core.ProfileLimits.of(com.beeboentertainment.movie.BeeboApp.instance.session.isAdmin, com.beeboentertainment.movie.BeeboApp.instance.session.isRestricted, com.beeboentertainment.movie.BeeboApp.instance.session.isGuest).showRequests) AssistChip(onClick = { onRequestTitle("", filter) }, label = { Text("🙋 Request a title") })
        }

        // All, Films and Shows are one grid with one layout (genres, A-Z, posters); the switch
        // only decides which titles are in it.
        CatalogGrid(
            filter = filter,
            query = query,
            onUnauthorized = onUnauthorized,
            onOpenShow = onOpenShow,
            onOpenActor = onOpenActor,
            onOpenCollection = onOpenCollection,
            onRequestThis = { onRequestTitle(query.trim(), filter) }
        )
    }
}

/** All · Films · Shows · Music. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BrowseSwitch(filter: BrowseFilter, onFilterChange: (BrowseFilter) -> Unit) {
    SingleChoiceSegmentedButtonRow(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 2.dp)
    ) {
        BrowseFilter.entries.forEachIndexed { i, option ->
            SegmentedButton(
                selected = filter == option,
                onClick = { onFilterChange(option) },
                shape = SegmentedButtonDefaults.itemShape(i, BrowseFilter.entries.size),
                label = { Text(option.label, maxLines = 1) }
            )
        }
    }
}

/** Both catalogues, painted from the cache at once and refreshed behind it when stale. */
private class BrowseCatalog(
    val movies: MoviesResponse?,
    val shows: TvShowsResponse?,
    val loading: Boolean,
    val error: String?
)

@Composable
private fun rememberBrowseCatalog(onUnauthorized: () -> Unit, reloadKey: Int): BrowseCatalog {
    val app = BeeboApp.instance
    var movies by remember { mutableStateOf(CatalogCache.movies(null)) }
    var shows by remember { mutableStateOf(CatalogCache.tvShows(null)) }
    var loading by remember { mutableStateOf(movies == null || shows == null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(reloadKey) {
        error = null
        try {
            if (reloadKey > 0 || !CatalogCache.moviesFresh(null)) {
                val r = app.api.movies(genre = null)
                CatalogCache.putMovies(null, r)
                movies = r
                // Movie Trivia builds its questions from this (the old Films grid used to save it).
                if (r.ok) kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
                    com.beeboentertainment.movie.campsite.CampsiteTriviaCache.save(app.session, r)
                }
            }
            if (reloadKey > 0 || !CatalogCache.tvShowsFresh(null)) {
                val r = app.api.tvShows(genre = null)
                CatalogCache.putTvShows(null, r)
                shows = r
            }
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            // A catalogue already on screen stays; only an empty screen shows the error.
            if (movies == null && shows == null) error = e.message ?: "Couldn't load the library."
        } finally {
            loading = false
        }
    }
    return BrowseCatalog(movies, shows, loading, error)
}

/**
 * The merged grid: All's A-Z grid when [query] is blank, otherwise search results for the switch,
 * best match first. Films play and shows open, exactly as in their own grids.
 */
@Composable
private fun CatalogGrid(
    filter: BrowseFilter,
    query: String,
    onUnauthorized: () -> Unit,
    onOpenShow: (String) -> Unit,
    onOpenActor: (Int, String) -> Unit,
    onOpenCollection: (Int, String) -> Unit,
    onRequestThis: () -> Unit
) {
    val app = BeeboApp.instance
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var reloadKey by remember { mutableStateOf(0) }
    val catalog = rememberBrowseCatalog(onUnauthorized, reloadKey)
    val searching = BrowseLogic.isSearching(query)

    val movieGenres = catalog.movies?.genres.orEmpty()
    val showGenres = catalog.shows?.genres.orEmpty()
    val movieGenreNames = remember(movieGenres) { movieGenres.associate { it.id to it.name } }
    val showGenreNames = remember(showGenres) { showGenres.associate { it.id to it.name } }
    // Chips are merged by name for whatever the switch shows; the chip ids are just positions in
    // that list, so the selection is remembered by name and survives switching All/Films/Shows.
    val genreChips = remember(catalog.movies, catalog.shows, filter) {
        BrowseLogic.genreChips(
            films = catalog.movies?.items.orEmpty(),
            shows = catalog.shows?.items.orEmpty(),
            filter = filter,
            filmGenres = movieGenreNames,
            showGenres = showGenreNames,
            filmGenreIds = { it.genres },
            showGenreIds = { it.genres }
        ).mapIndexed { i, chip -> Genre(id = i + 1, name = chip.name, count = chip.count) }
    }
    var selectedGenreName by rememberSaveable { mutableStateOf<String?>(null) }
    val selectedChip = genreChips.firstOrNull { it.name.equals(selectedGenreName, ignoreCase = true) }
    val genreName = selectedChip?.name

    val hits = remember(catalog.movies, catalog.shows, filter, query, genreName) {
        BrowseLogic.results(
            films = catalog.movies?.items.orEmpty()
                .filter { BrowseLogic.inGenre(it.genres, movieGenreNames, if (searching) null else genreName) },
            shows = catalog.shows?.items.orEmpty()
                .filter { BrowseLogic.inGenre(it.genres, showGenreNames, if (searching) null else genreName) },
            filter = filter,
            query = query,
            filmTitle = { it.title },
            showTitle = { it.name }
        )
    }

    val downloads by app.downloads.items.collectAsState()
    val downloadsById = remember(downloads) { downloads.associateBy { it.id } }
    var movieDetails by remember { mutableStateOf<Movie?>(null) }
    var pendingDownload by remember { mutableStateOf<Movie?>(null) }
    var showDetails by remember { mutableStateOf<TvShow?>(null) }
    val gridState = rememberLazyGridState()
    val openTrailer = com.beeboentertainment.movie.ui.rememberTrailerOpener(onUnauthorized)

    @Composable
    fun Tile(hit: BrowseLogic.Hit<Movie, TvShow>) {
        val movie = hit.film
        val show = hit.show
        if (movie != null) {
            val badge = when (downloadsById[movie.id]?.statusEnum) {
                DownloadStatus.COMPLETE -> DownloadBadge.DONE
                DownloadStatus.RUNNING, DownloadStatus.QUEUED -> DownloadBadge.RUNNING
                else -> DownloadBadge.NONE
            }
            PosterCard(
                title = movie.title,
                // "Film" / "Show" is only worth saying when both are mixed in.
                subtitle = listOfNotNull(movie.year?.toString(), "Film".takeIf { filter == BrowseFilter.ALL })
                    .joinToString(" · ").ifEmpty { null },
                posterUrl = UrlUtils.join(app.session.baseUrl, movie.poster),
                quality = movie.quality,
                isNew = movie.isNew,
                downloadState = badge,
                onCollection = movie.collectionId?.let { id -> { onOpenCollection(id, movie.collectionName.orEmpty()) } },
                onInfo = { movieDetails = movie },
                onTrailer = movie.tmdbId?.takeIf { TrailerLogic.canShow(it) }?.let { id -> { openTrailer("movie", id) } },
                onClick = { playMovie(context, movie) },
                onDownload = { pendingDownload = movie }
            )
        } else if (show != null) {
            PosterCard(
                title = show.name,
                subtitle = listOfNotNull(
                    "Show".takeIf { filter == BrowseFilter.ALL },
                    if (show.episodeCount > 0) "${show.episodeCount} episodes" else null
                ).joinToString(" · ").ifEmpty { null },
                posterUrl = UrlUtils.join(app.session.baseUrl, show.poster),
                quality = show.quality,
                isNew = show.isNew,
                onInfo = { showDetails = show },
                onTrailer = show.tmdbId?.takeIf { TrailerLogic.canShow(it) }?.let { id -> { openTrailer("tv", id) } },
                onClick = { onOpenShow(show.key) }
            )
        }
    }

    fun keyOf(hit: BrowseLogic.Hit<Movie, TvShow>): String =
        if (hit.film != null) "film:" + hit.film.id else "show:" + hit.show?.key

    Column(Modifier.fillMaxSize()) {
        if (!searching && genreChips.isNotEmpty()) {
            GenreFilterRow(genreChips, selectedChip?.id) { id ->
                selectedGenreName = genreChips.firstOrNull { it.id == id }?.name
            }
            Spacer(Modifier.height(4.dp))
        }
        val state = BrowseLogic.searchState(query, hits.size, catalog.loading)
        when {
            catalog.error != null && hits.isEmpty() -> ErrorBox(catalog.error, onRetry = { reloadKey++ })
            !searching && hits.isEmpty() && catalog.loading -> LoadingBox()
            !searching && hits.isEmpty() -> EmptyBox(
                when (filter) {
                    BrowseFilter.FILMS -> "No films here yet."
                    BrowseFilter.SHOWS -> "No shows here yet."
                    // MUSIC draws its own screen above and never reaches this grid.
                    BrowseFilter.ALL, BrowseFilter.MUSIC -> "Nothing here yet."
                }
            )
            searching && state == BrowseLogic.SearchState.LOADING -> LoadingBox()
            searching && state == BrowseLogic.SearchState.TOO_SHORT -> EmptyBox("Nothing matches \"${query.trim()}\".")
            searching && state == BrowseLogic.SearchState.REQUEST_THIS_TITLE -> RequestThisTitle(query.trim(), onRequestThis)
            searching -> LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 110.dp),
                contentPadding = PaddingValues(8.dp),
                modifier = Modifier.fillMaxSize()
            ) {
                items(hits, key = { keyOf(it) }) { Tile(it) }
            }
            else -> {
                val sections = remember(hits) { AlphaIndex.sections(hits) { it.title } }
                val headerIndices = remember(sections) { AlphaIndex.headerIndices(sections) }
                val available = remember(hits) { AlphaIndex.availableLetters(hits) { it.title } }
                AlphaBar(
                    available = available,
                    onLetter = { letter ->
                        headerIndices[letter]?.let { index -> scope.launch { gridState.animateScrollToItem(index) } }
                    }
                )
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 110.dp),
                    state = gridState,
                    contentPadding = PaddingValues(8.dp),
                    modifier = Modifier.fillMaxSize()
                ) {
                    sections.forEach { (letter, sectionHits) ->
                        item(key = "header-$letter", span = { GridItemSpan(maxLineSpan) }) { LetterHeader(letter) }
                        items(sectionHits, key = { keyOf(it) }) { Tile(it) }
                    }
                }
            }
        }
    }

    MovieOverlays(
        detailsFor = movieDetails,
        pendingDownloadFor = pendingDownload,
        genres = movieGenres,
        onDismissDetails = { movieDetails = null },
        onAskDownload = { pendingDownload = it },
        onDismissDownload = { pendingDownload = null },
        onUnauthorized = onUnauthorized,
        onOpenActor = onOpenActor,
        onOpenCollection = onOpenCollection
    )
    ShowDetailsOverlay(
        details = showDetails,
        genres = showGenres,
        onDismiss = { showDetails = null },
        onOpenShow = onOpenShow,
        onUnauthorized = onUnauthorized,
        onOpenActor = onOpenActor
    )
}

/** A search that found nothing: not a dead end, a way to ask for it. */
@Composable
private fun RequestThisTitle(query: String, onRequest: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            "\"$query\" isn't in your library yet.",
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.titleMedium
        )
        Spacer(Modifier.height(6.dp))
        Text(
            "You can ask for it, and see when it's added.",
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(14.dp))
        Button(onClick = onRequest) { Text("🙋 Request this title") }
    }
}
