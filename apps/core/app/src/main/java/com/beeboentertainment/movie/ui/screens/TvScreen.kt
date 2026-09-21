package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.items as listItems
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.DownloadDone
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.focus.focusRequester
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.AlphaIndex
import com.beeboentertainment.movie.core.TvFeatures
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.core.WatchedMarks
import com.beeboentertainment.movie.data.ApiException
import com.beeboentertainment.movie.data.CastMember
import com.beeboentertainment.movie.data.CatalogCache
import com.beeboentertainment.movie.data.Episode
import com.beeboentertainment.movie.data.EpisodesResponse
import com.beeboentertainment.movie.data.Genre
import com.beeboentertainment.movie.data.TvShow
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.data.WatchedMarkResponse
import com.beeboentertainment.movie.downloads.DownloadIndex
import com.beeboentertainment.movie.downloads.DownloadStatus
import com.beeboentertainment.movie.downloads.NetDecision
import com.beeboentertainment.movie.downloads.NetworkMonitor
import com.beeboentertainment.movie.downloads.NetworkPolicy
import com.beeboentertainment.movie.downloads.SeasonQueue
import androidx.compose.material.icons.filled.HourglassEmpty
import com.beeboentertainment.movie.player.PlayerActivity
import com.beeboentertainment.movie.ui.AlphaBar
import com.beeboentertainment.movie.ui.CastRow
import com.beeboentertainment.movie.ui.LibraryControlsRow
import com.beeboentertainment.movie.ui.LibraryTarget
import com.beeboentertainment.movie.ui.TitleDetailsDialog
import com.beeboentertainment.movie.ui.ConfirmDialog
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.LetterHeader
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.GenreFilterRow
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.PosterCard
import com.beeboentertainment.movie.ui.QualityChip
import com.beeboentertainment.movie.ui.WatchedActions
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.drop
import androidx.lifecycle.repeatOnLifecycle

/** A show's details overlay, shared by the Browse grid and search results. */
@Composable
fun ShowDetailsOverlay(
    details: TvShow?,
    genres: List<Genre>,
    onDismiss: () -> Unit,
    onOpenShow: (String) -> Unit,
    onUnauthorized: () -> Unit,
    onOpenActor: (Int, String) -> Unit
) {
    val app = BeeboApp.instance
    var detailsCast by remember { mutableStateOf<List<CastMember>>(emptyList()) }
    val openTrailer = com.beeboentertainment.movie.ui.rememberTrailerOpener(onUnauthorized)

    LaunchedEffect(details?.key) {
        val key = details?.key
        detailsCast = if (key.isNullOrBlank()) emptyList()
        else runCatching { app.api.credits("tv", key).cast }.getOrDefault(emptyList())
    }

    if (details != null) {
        TitleDetailsDialog(
            title = details.name,
            year = details.year,
            quality = details.quality,
            // A show's overview only comes back from the episodes endpoint, not the list.
            overview = null,
            extraLine = if (details.episodeCount > 0) "${details.episodeCount} episodes" else null,
            genreNames = details.genres.mapNotNull { id -> genres.firstOrNull { it.id == id }?.name },
            posterUrl = UrlUtils.join(app.session.baseUrl, details.poster),
            // a whole show isn't a single downloadable/flaggable file
            showDownloadAction = false,
            showFlagAction = false,
            playLabel = "Episodes",
            cast = detailsCast,
            baseUrl = app.session.baseUrl,
            libraryControls = {
                LibraryControlsRow(
                    target = LibraryTarget(
                        kind = "tv",
                        id = details.key,
                        title = details.name,
                        poster = details.poster,
                        // A show has no single file, so there is no stream to remember; the show
                        // key is carried through so the Watchlist view can tell it from a film.
                        // Watched on a show means every episode in it, and takes all of them
                        // out of Continue Watching.
                        showKey = details.key
                    ),
                    onUnauthorized = onUnauthorized
                )
            },
            onActor = { person -> onOpenActor(person.id, person.name) },
            onTrailer = details.tmdbId?.takeIf { com.beeboentertainment.movie.core.TrailerLogic.canShow(it) }
                ?.let { id -> { openTrailer("tv", id) } },
            onPlay = { onOpenShow(details.key) },
            onDismiss = onDismiss
        )
    }
}

/**
 * Season / episode list for one show.
 *
 * The server groups episodes into seasons; a season whose number is null is the "Unsorted"
 * bucket for episodes with unparseable numbering, and it always sorts last.
 */
@Composable
fun TvEpisodesScreen(
    showKey: String,
    onUnauthorized: () -> Unit,
    onOpenActor: (Int, String) -> Unit = { _, _ -> }
) {
    val app = BeeboApp.instance
    val context = LocalContext.current

    var data by remember { mutableStateOf<EpisodesResponse?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    val downloads by app.downloads.items.collectAsState()
    // One map per emission instead of a linear scan inside every visible episode row.
    val downloadsById = remember(downloads) { downloads.associateBy { it.id } }
    /** The episode whose download action is awaiting confirmation. */
    var pendingDownloadFor by remember { mutableStateOf<Episode?>(null) }
    /** "Download season" / "Download show": the label and episodes awaiting confirmation. */
    var batchFor by remember { mutableStateOf<Pair<String, List<Episode>>?>(null) }
    var showMenuOpen by remember { mutableStateOf(false) }
    var showMissing by remember(showKey) { mutableStateOf(true) }
    var selectedMissing by remember(showKey) { mutableStateOf<com.beeboentertainment.movie.data.MissingEpisode?>(null) }
    selectedMissing?.let { item ->
        MissingEpisodeDialog(data?.show, item, onUnauthorized) { selectedMissing = null }
    }
    /** "Add to playlist / queue" for the show, a season or one episode: (what, its name, queue item). */
    var addToPlaylist by remember {
        mutableStateOf<Triple<com.beeboentertainment.movie.data.PlaylistItemRef, String, com.beeboentertainment.movie.core.QueueItem?>?>(null)
    }
    addToPlaylist?.let { (ref, label, queueItem) ->
        com.beeboentertainment.movie.ui.AddToPlaylistDialog(
            ref = ref,
            title = label,
            queueItem = queueItem,
            onUnauthorized = onUnauthorized,
            onDismiss = { addToPlaylist = null }
        )
    }
    val net by NetworkMonitor.state.collectAsState()
    val wifiOnly by app.downloads.settings.wifiOnly.collectAsState()
    /** Main cast for the show; empty means nothing cached and the row renders nothing. */
    var cast by remember { mutableStateOf<List<CastMember>>(emptyList()) }

    LaunchedEffect(showKey) {
        // /api/credits accepts a show key as well as an episode id for kind=tv
        cast = runCatching { app.api.credits("tv", showKey).cast }.getOrDefault(emptyList())
    }

    /*
     * Watched marks. Confirm-then-fill, like the library chips: nothing on screen changes until
     * the server has said it saved, and every watched control is disabled while a mark is in
     * flight so a second tap cannot race the first.
     */
    val markScope = rememberCoroutineScope()
    var marking by remember { mutableStateOf(false) }
    var markMessage by remember { mutableStateOf<String?>(null) }
    /** A season or whole-show mark waiting for the user to confirm it. */
    var pendingBulk by remember { mutableStateOf<PendingBulkMark?>(null) }

    fun runMark(call: suspend () -> WatchedMarkResponse) {
        marking = true
        markMessage = null
        markScope.launch {
            try {
                val response = call()
                if (!response.ok) {
                    markMessage = "Your server didn't accept that, so nothing changed."
                    return@launch
                }
                // Continue cache + resume marks first, then the ticks on this list.
                WatchedActions.mirror(app, response)
                data = data?.let {
                    WatchedMarks.applyToEpisodes(it, response.ids, response.watched, System.currentTimeMillis())
                }
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: ApiException) {
                markMessage = if (e.code == 404) WatchedMarks.OLD_SERVER_EPISODE_MESSAGE
                else "Couldn't reach your server, so nothing changed."
            } catch (e: Exception) {
                markMessage = "Couldn't reach your server, so nothing changed."
            } finally {
                marking = false
            }
        }
    }

    LaunchedEffect(showKey, reloadKey) {
        loading = true
        error = null
        try {
            data = app.api.episodes(showKey)
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            error = e.message ?: "Couldn't load episodes."
        } finally {
            loading = false
        }
    }

    // Live: the playing episode's bar and tick follow the player (LiveProgress), and the list
    // re-reads the server when it comes back on screen or a pause/stop/finish report lands.
    // Only while on screen; no interval here.
    val live by com.beeboentertainment.movie.core.LiveProgress.shared.entries.collectAsState()
    val lifecycleOwner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner, showKey) {
        var lastFetch = System.currentTimeMillis()
        suspend fun quiet() {
            if (loading) return
            lastFetch = System.currentTimeMillis()
            try {
                data = app.api.episodes(showKey)
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (_: Exception) {
            }
        }
        lifecycleOwner.lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
            kotlinx.coroutines.coroutineScope {
                launch {
                    if (com.beeboentertainment.movie.core.LibraryRefreshPolicy.shouldRefresh(System.currentTimeMillis(), lastFetch)) quiet()
                }
                launch {
                    com.beeboentertainment.movie.core.LiveProgress.shared.serverChanges
                        .drop(1).collect { quiet() }
                }
            }
        }
    }

    when {
        loading -> LoadingBox()
        error != null -> ErrorBox(error!!, onRetry = { reloadKey++ })
        data == null -> EmptyBox("Nothing here.")
        else -> {
            val r = remember(data, live) {
                com.beeboentertainment.movie.core.LiveProgressLogic.applyToEpisodes(data!!, live)
            }
            // null season == "Unsorted", pushed to the end.
            val seasons = r.seasons.sortedWith(compareBy(nullsLast<Int>()) { it.season })
            val listState = rememberLazyListState()
            val scope = rememberCoroutineScope()
            // Android TV: land the remote on the first episode once the list is in.
            val isTv = com.beeboentertainment.movie.ui.tv.LocalIsTv.current
            val firstEpisodeFocus = remember { androidx.compose.ui.focus.FocusRequester() }
            val firstEpisodeId = seasons.firstOrNull { it.episodes.isNotEmpty() }?.episodes?.first()?.id
            if (isTv && firstEpisodeId != null) {
                LaunchedEffect(firstEpisodeId) { runCatching { firstEpisodeFocus.requestFocus() } }
            }
            // Index of each season header inside the LazyColumn: item 0 is the show
            // header, then optionally the jump bar, then each season contributes its
            // own header item plus one item per episode.
            val headerIndexOf = remember(seasons, r, showMissing) {
                val map = HashMap<Int?, Int>()
                var i = 1 + if (seasons.size > 1) 1 else 0
                for (season in seasons) {
                    map[season.season] = i
                    i += 1 + season.episodes.size + if (showMissing) com.beeboentertainment.movie.core.EpisodeGaps.visible(season).size else 0
                }
                map
            }
            LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                item {
                    Column(Modifier.padding(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                r.show?.name ?: "Show",
                                fontSize = 20.sp,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.weight(1f)
                            )
                            // Show header menu: whole-show actions live here, out of the way.
                            val downloadsOk = TvFeatures.downloadsAvailable(isTv)
                            // On a TV the menu would be empty when signed out, so it is left out.
                            if (downloadsOk || app.session.isLoggedIn) Box {
                                IconButton(onClick = { showMenuOpen = true }) {
                                    Icon(Icons.Filled.MoreVert, contentDescription = "Show options")
                                }
                                DropdownMenu(expanded = showMenuOpen, onDismissRequest = { showMenuOpen = false }) {
                                    if (downloadsOk) DropdownMenuItem(
                                        text = { Text("Download whole show") },
                                        leadingIcon = { Icon(Icons.Filled.Download, contentDescription = null) },
                                        onClick = {
                                            showMenuOpen = false
                                            batchFor = (r.show?.name ?: "the whole show") to
                                                SeasonQueue.showOrder(r.seasons)
                                        }
                                    )
                                    if (app.session.isLoggedIn) DropdownMenuItem(
                                        text = { Text("＋ Add show to a playlist or the queue") },
                                        onClick = {
                                            showMenuOpen = false
                                            addToPlaylist = Triple(
                                                com.beeboentertainment.movie.data.PlaylistItemRef(type = "show", showKey = showKey),
                                                r.show?.name ?: "This show",
                                                null
                                            )
                                        }
                                    )
                                }
                            }
                        }
                        r.show?.overview?.takeIf { it.isNotBlank() }?.let {
                            Spacer(Modifier.height(6.dp))
                            Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (cast.isNotEmpty()) {
                            Spacer(Modifier.height(14.dp))
                            CastRow(
                                cast = cast,
                                baseUrl = app.session.baseUrl,
                                onActor = { person -> onOpenActor(person.id, person.name) }
                            )
                        }
                        if (app.session.isLoggedIn) {
                            val showProgress = WatchedMarks.showProgress(r)
                            Spacer(Modifier.height(8.dp))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    showProgress.label,
                                    fontSize = 12.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.weight(1f)
                                )
                                if (showProgress.total > 0) {
                                    TextButton(
                                        enabled = !marking,
                                        onClick = {
                                            pendingBulk = PendingBulkMark(
                                                season = null,
                                                wholeShow = true,
                                                what = r.show?.name ?: "this show",
                                                count = showProgress.total,
                                                watched = showProgress.nextMarkIsWatched
                                            )
                                        }
                                    ) { Text(WatchedMarks.showMenuLabel(showProgress)) }
                                }
                            }
                        }
                        androidx.compose.material3.FilterChip(
                            selected = showMissing,
                            onClick = { showMissing = !showMissing },
                            label = { Text(if (showMissing) "Missing episodes shown" else "Show missing episodes") }
                        )
                        if (showMissing) {
                            val gaps = seasons.sumOf { com.beeboentertainment.movie.core.EpisodeGaps.visible(it).size }
                            val note = when {
                                !r.missingEpisodesSupported -> "Update your computer’s Beebo app to see missing episodes here."
                                seasons.any { it.season != null && !it.missingChecked } -> "${gaps} missing episodes found. Episode information isn’t available for every season yet."
                                gaps > 0 -> "$gaps missing episodes · tap one to search or request it. Listings may include episodes that haven’t aired yet."
                                else -> "No missing episodes found in the seasons checked."
                            }
                            Text(note, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        markMessage?.let {
                            Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
                // Jump bar - only worth the space when there's more than one season.
                if (seasons.size > 1) {
                    item(key = "seasonjump") {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState())
                                .padding(horizontal = 12.dp, vertical = 4.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            seasons.forEach { season ->
                                AssistChip(
                                    onClick = {
                                        headerIndexOf[season.season]?.let { idx ->
                                            scope.launch { listState.animateScrollToItem(idx) }
                                        }
                                    },
                                    label = {
                                        Text(
                                            if (season.season != null) "S${season.season}" else "Unsorted",
                                            fontWeight = FontWeight.SemiBold
                                        )
                                    },
                                    colors = AssistChipDefaults.assistChipColors(
                                        labelColor = MaterialTheme.colorScheme.primary
                                    )
                                )
                            }
                        }
                    }
                }
                seasons.forEach { season ->
                    item(key = "s${season.season ?: -1}") {
                        SeasonHeader(
                            title = season.displayName,
                            progress = WatchedMarks.progress(season.episodes),
                            showMarks = app.session.isLoggedIn,
                            marksEnabled = !marking,
                            onMark = { progress ->
                                pendingBulk = PendingBulkMark(
                                    season = season.season,
                                    wholeShow = false,
                                    what = season.displayName,
                                    count = progress.total,
                                    watched = progress.nextMarkIsWatched
                                )
                            },
                            onDownloadSeason = {
                                batchFor = season.displayName to SeasonQueue.seasonOrder(season)
                            },
                            onAddToPlaylist = {
                                addToPlaylist = Triple(
                                    com.beeboentertainment.movie.core.PlaylistLogic.seasonRef(showKey, season.season),
                                    "${r.show?.name ?: "Show"} · ${season.displayName}",
                                    null
                                )
                            }
                        )
                    }
                    listItems(season.episodes, key = { it.id }) { ep ->
                        val record = downloadsById[ep.id]
                        val queued = record?.statusEnum == DownloadStatus.QUEUED
                        EpisodeRow(
                            episode = ep,
                            // Signed out there is no one to mark it for, so no menu at all.
                            onToggleWatched = if (app.session.isLoggedIn) {
                                { runMark { app.api.markEpisodeWatched(ep.id, !WatchedMarks.isWatched(ep)) } }
                            } else null,
                            marksEnabled = !marking,
                            downloaded = record?.statusEnum == DownloadStatus.COMPLETE,
                            waiting = queued && record != null &&
                                NetworkPolicy.decide(net, wifiOnly, record) != NetDecision.ALLOW,
                            downloading = record?.statusEnum == DownloadStatus.RUNNING || queued,
                            onPlay = {
                                context.startActivity(
                                    PlayerActivity.intentFor(
                                        context,
                                        itemId = ep.id,
                                        kind = "tv",
                                        title = ep.title,
                                        streamUrl = UrlUtils.join(app.session.baseUrl, ep.stream),
                                        localPath = app.downloads.localPath(ep.id),
                                        posterUrl = UrlUtils.join(app.session.baseUrl, r.show?.poster),
                                        // lets the player work out what episode comes next
                                        showKey = showKey
                                    )
                                )
                            },
                            // Always confirms; a tap while downloading stops it.
                            onDownload = { pendingDownloadFor = ep },
                            onAddToPlaylist = {
                                addToPlaylist = Triple(
                                    com.beeboentertainment.movie.data.PlaylistItemRef(type = "episode", id = ep.id, title = ep.title),
                                    ep.title,
                                    com.beeboentertainment.movie.core.QueueItem(
                                        kind = "tv", id = ep.id, title = ep.title, stream = ep.stream,
                                        poster = r.show?.poster, showKey = showKey
                                    )
                                )
                            },
                            modifier = if (ep.id == firstEpisodeId) {
                                Modifier.focusRequester(firstEpisodeFocus)
                            } else Modifier
                        )
                        HorizontalDivider()
                    }
                    if (showMissing) {
                        listItems(com.beeboentertainment.movie.core.EpisodeGaps.visible(season), key = { "missing-${it.season}-${it.episode}" }) { missing ->
                            TextButton(onClick = { selectedMissing = missing }, modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                                    Text(missing.title.ifBlank { "Episode ${missing.episode}" }, fontWeight = FontWeight.SemiBold)
                                    Text("Not in your library · Search or request", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
    }

    val bulk = pendingBulk
    if (bulk != null) {
        ConfirmDialog(
            title = if (bulk.watched) "Mark as watched?" else "Mark as unwatched?",
            message = WatchedMarks.bulkConfirmMessage(bulk.what, bulk.count, bulk.watched),
            confirmLabel = if (bulk.watched) "Mark watched" else "Mark unwatched",
            onConfirm = {
                runMark {
                    if (bulk.wholeShow) app.api.markShowWatched(showKey, bulk.watched)
                    else app.api.markSeasonWatched(showKey, bulk.season, bulk.watched)
                }
            },
            onDismiss = { pendingBulk = null }
        )
    }

    val pending = pendingDownloadFor
    if (pending != null) {
        val action = DownloadIndex.tapAction(downloadsById[pending.id])
        ConfirmDialog(
            title = DownloadIndex.confirmTitle(action),
            message = DownloadIndex.confirmMessage(action, pending.title),
            confirmLabel = DownloadIndex.confirmButton(action),
            onConfirm = {
                when (action) {
                    DownloadIndex.TapAction.STOP -> app.downloads.stop(pending.id)
                    DownloadIndex.TapAction.DELETE -> app.downloads.delete(pending.id)
                    DownloadIndex.TapAction.START -> {
                        UrlUtils.join(app.session.baseUrl, pending.stream)?.let { stream ->
                            app.downloads.enqueue(
                                id = pending.id,
                                kind = "tv",
                                title = pending.title,
                                streamUrl = stream,
                                posterUrl = UrlUtils.join(app.session.baseUrl, data?.show?.poster),
                                showKey = showKey,
                                showName = data?.show?.name,
                                season = pending.season,
                                episode = pending.episode
                            )
                        }
                    }
                }
            },
            onDismiss = { pendingDownloadFor = null }
        )
    }

    val batch = batchFor
    if (batch != null) {
        BatchDownloadDialog(
            showKey = showKey,
            showName = data?.show?.name,
            posterPath = data?.show?.poster,
            scopeLabel = batch.first,
            episodes = batch.second,
            onDismiss = { batchFor = null }
        )
    }
}

/**
 * "Watched \u00b7 11 Sep 2026", or "Watched 62% \u00b7 …" when they stopped partway.
 * Renders nothing at all for an episode this viewer has never opened, so an
 * untouched season stays visually quiet.
 */
@Composable
private fun WatchedLine(episode: Episode) {
    // The server's watched mark (or, from an older server, the 95% rule) decides the tick. A
    // mark made by hand may have no play date, and still gets its tick.
    val finished = WatchedMarks.isWatched(episode)
    val at = episode.watchedAt?.takeIf { it > 0L }
    if (at == null && !finished) return
    val label = if (finished) "Watched" else "Watched ${episode.watchedPercent}%"
    val line = if (at != null) "$label · ${formatWatchedDate(at)}" else label
    Spacer(Modifier.height(2.dp))
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(
            if (finished) Icons.Filled.CheckCircle else Icons.Filled.History,
            contentDescription = null,
            modifier = Modifier.size(13.dp),
            tint = if (finished) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            line,
            fontSize = 11.sp,
            color = if (finished) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/** Today / Yesterday for the recent stuff, otherwise a plain short date. */
private fun formatWatchedDate(epochMs: Long): String {
    val now = java.util.Calendar.getInstance()
    val then = java.util.Calendar.getInstance().apply { timeInMillis = epochMs }
    val sameYear = now.get(java.util.Calendar.YEAR) == then.get(java.util.Calendar.YEAR)
    val dayDiff = if (sameYear)
        now.get(java.util.Calendar.DAY_OF_YEAR) - then.get(java.util.Calendar.DAY_OF_YEAR)
    else -1
    return when {
        sameYear && dayDiff == 0 -> "today"
        sameYear && dayDiff == 1 -> "yesterday"
        sameYear -> java.text.SimpleDateFormat("d MMM", java.util.Locale.getDefault()).format(java.util.Date(epochMs))
        else -> java.text.SimpleDateFormat("d MMM yyyy", java.util.Locale.getDefault()).format(java.util.Date(epochMs))
    }
}

/** A season or whole-show watched mark waiting for confirmation. */
private data class PendingBulkMark(
    /** Ignored when [wholeShow]; null is the Unsorted season. */
    val season: Int?,
    val wholeShow: Boolean,
    val what: String,
    val count: Int,
    val watched: Boolean
)

/**
 * A season break: its own tinted band, bigger and bolder than an episode title, so it is obvious
 * at a glance while scrolling. Carries "3 of 10 watched" and the season's watched menu.
 */
@Composable
private fun SeasonHeader(
    title: String,
    progress: WatchedMarks.Progress,
    showMarks: Boolean,
    marksEnabled: Boolean,
    onMark: (WatchedMarks.Progress) -> Unit,
    onDownloadSeason: () -> Unit,
    onAddToPlaylist: (() -> Unit)? = null
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.10f))
            .padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(
            Modifier
                .weight(1f)
                .padding(top = 8.dp, bottom = 8.dp)
        ) {
            Text(
                title,
                fontSize = 20.sp,
                fontWeight = FontWeight.ExtraBold,
                color = MaterialTheme.colorScheme.primary
            )
            if (showMarks && progress.label.isNotEmpty()) {
                Text(progress.label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        // A Material button: focusable, so a remote reaches it after the episode rows' own stops.
        if (TvFeatures.downloadsAvailable(com.beeboentertainment.movie.ui.tv.LocalIsTv.current)) TextButton(onClick = onDownloadSeason) {
            Icon(Icons.Filled.Download, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(4.dp))
            Text("Download season", fontSize = 13.sp)
        }
        if (showMarks && progress.total > 0) {
            Box {
                IconButton(onClick = { menuOpen = true }, enabled = marksEnabled) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "$title options")
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text(WatchedMarks.seasonMenuLabel(progress)) },
                        onClick = { menuOpen = false; onMark(progress) }
                    )
                    if (onAddToPlaylist != null) DropdownMenuItem(
                        text = { Text("＋ Add season to a playlist or the queue") },
                        onClick = { menuOpen = false; onAddToPlaylist() }
                    )
                }
            }
        }
    }
}

/**
 * One episode. Tap plays; long-press, or the ⋮ button (reachable with a remote, which cannot
 * long-press comfortably), opens "Mark watched / unwatched". [onToggleWatched] null means no
 * menu at all - signed out there is nobody to mark it for.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun EpisodeRow(
    episode: Episode,
    downloaded: Boolean,
    waiting: Boolean,
    downloading: Boolean,
    onPlay: () -> Unit,
    onDownload: () -> Unit,
    onToggleWatched: (() -> Unit)? = null,
    marksEnabled: Boolean = true,
    onAddToPlaylist: (() -> Unit)? = null,
    modifier: Modifier = Modifier
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = onPlay,
                onLongClick = if (onToggleWatched != null && marksEnabled) {
                    { menuOpen = true }
                } else null
            )
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Filled.PlayArrow, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(episode.title, fontSize = 14.sp)
            val numbering = when {
                episode.season != null && episode.episode != null ->
                    "S${episode.season}E${episode.episode}"
                episode.episode != null -> "Episode ${episode.episode}"
                else -> "Unsorted"
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(numbering, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                episode.quality?.let { QualityChip(it) }
            }
            WatchedLine(episode)
        }
        if (TvFeatures.downloadsAvailable(com.beeboentertainment.movie.ui.tv.LocalIsTv.current)) IconButton(onClick = onDownload) {
            when {
                waiting -> Icon(Icons.Filled.HourglassEmpty, contentDescription = "Waiting for Wi-Fi")
                downloading -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                downloaded -> Icon(Icons.Filled.DownloadDone, contentDescription = "Downloaded")
                else -> Icon(Icons.Filled.Download, contentDescription = "Download")
            }
        }
        if (onToggleWatched != null) {
            Box {
                IconButton(onClick = { menuOpen = true }, enabled = marksEnabled) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "Episode options")
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text(WatchedMarks.episodeMenuLabel(WatchedMarks.isWatched(episode))) },
                        onClick = { menuOpen = false; onToggleWatched() }
                    )
                    if (onAddToPlaylist != null) DropdownMenuItem(
                        text = { Text("＋ Add to a playlist or the queue") },
                        onClick = { menuOpen = false; onAddToPlaylist() }
                    )
                }
            }
        }
    }
}
