package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import coil.compose.AsyncImage
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.ContinueFormat
import com.beeboentertainment.movie.core.ContinueGrouping
import com.beeboentertainment.movie.core.HistoryClear
import com.beeboentertainment.movie.core.HomeLayout
import com.beeboentertainment.movie.core.HomeSection
import com.beeboentertainment.movie.core.LibrarySection
import com.beeboentertainment.movie.ui.CollectionsShelf
import com.beeboentertainment.movie.ui.ShelfRow
import com.beeboentertainment.movie.ui.rememberHomeCollections
import androidx.compose.ui.focus.focusRequester
import com.beeboentertainment.movie.core.IdCodec
import com.beeboentertainment.movie.core.LibraryClearKind
import com.beeboentertainment.movie.core.LibraryClearModel
import com.beeboentertainment.movie.core.LibraryRefreshPolicy
import com.beeboentertainment.movie.core.LiveProgress
import com.beeboentertainment.movie.core.LiveProgressLogic
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.core.WatchedMarks
import com.beeboentertainment.movie.ui.WatchedActions
import com.beeboentertainment.movie.data.ApiException
import com.beeboentertainment.movie.data.ContinueCache
import com.beeboentertainment.movie.data.ContinueItem
import com.beeboentertainment.movie.data.LibraryClearCounts
import com.beeboentertainment.movie.data.ShelfItem
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.data.WatchlistEntry
import com.beeboentertainment.movie.player.PlayerActivity
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.HomeShelves
import com.beeboentertainment.movie.ui.HomeShelvesData
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.rememberHomeShelves
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

/**
 * The personal-library tab — the app's twin of the website's /continue page, widened.
 *
 * FOUR views over one row shape, chosen with chips rather than new destinations:
 *   GET /api/continue   one row per show or film, the default and the screen this tab has always been
 *   GET /api/watchlist  "watch later", the only list the user builds by hand
 *   GET /api/favorites  the favourite flag, which the server hands back already decorated into
 *                       the very same row shape as /api/continue
 *   GET /api/history    everything, finished included
 *
 * Below the lists sit the "Recently added" and "Because you watched" shelves (they mix films and
 * shows, so they live here rather than on the Movies tab), loaded after the list has painted.
 *
 * LIVE: while anything plays (full screen, picture-in-picture or in the background) the rows
 * follow the player through [LiveProgress] - bar and minutes left move, a finished episode leaves
 * and its show moves on - and the list re-reads the server when it comes back on screen, when a
 * pause/stop/finish report reaches the server, and on [LibraryRefreshPolicy]'s interval while it
 * is visible. Nothing polls while the Library is off screen.
 *
 * "Clear…" offers the separate actions (watch history, favourites, watchlist, watched marks),
 * each confirmed with how much it removes; per-row removal still maps to POST /api/history/clear.
 */
@Composable
fun ContinueScreen(
    onUnauthorized: () -> Unit,
    /** A watchlisted or favourited TV row is a whole show, and a show opens rather than plays. */
    onOpenShow: (String) -> Unit = {},
    /**
     * HOME: Continue watching first, then Up next and the shelves (loaded after Continue), with
     * "Surprise me". LIBRARY: Watchlist, Favourites, History and Downloads, with "Clear…".
     */
    mode: ContinueMode = ContinueMode.HOME,
    librarySection: LibrarySection = LibrarySection.WATCHLIST,
    onSectionChange: (LibrarySection) -> Unit = {},
    onSurpriseMe: () -> Unit = {},
    onOpenCollection: (Int, String) -> Unit = { _, _ -> },
    onOpenCollections: () -> Unit = {}
) {
    val app = BeeboApp.instance
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val isTv = com.beeboentertainment.movie.ui.tv.LocalIsTv.current

    val view = if (mode == ContinueMode.HOME) LibraryView.CONTINUE else when (librarySection) {
        LibrarySection.WATCHLIST -> LibraryView.WATCHLIST
        LibrarySection.FAVOURITES -> LibraryView.FAVOURITES
        LibrarySection.PLAYLISTS -> LibraryView.PLAYLISTS
        LibrarySection.HISTORY -> LibraryView.HISTORY
        LibrarySection.DOWNLOADS -> LibraryView.DOWNLOADS
    }
    var rows by remember { mutableStateOf<List<ContinueItem>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    /** When the list last went to the server; [LibraryRefreshPolicy.MIN_GAP_MS] apart. */
    val lastFetchAt = remember { longArrayOf(0L) }

    /** Pending destructive action, held until the user confirms it. */
    var pendingClear by remember { mutableStateOf<PendingClear?>(null) }

    /**
     * Feedback from a one-tap list action, shown as a line above the list.
     *
     * Deliberately NOT `error`: that one replaces the whole list with a retry screen, which is
     * right when the list itself could not be loaded and far too heavy when a single toggle
     * failed and everything already on screen is still perfectly valid.
     */
    var actionMessage by remember { mutableStateOf<String?>(null) }

    val live by LiveProgress.shared.entries.collectAsState()
    // Home's shelves wait until Continue has painted, so Home appears fast.
    val shelvesMayLoad = mode == ContinueMode.HOME && HomeLayout.shelvesMayLoad(loading)
    val shelves = rememberHomeShelves(enabled = shelvesMayLoad)
    val collections = rememberHomeCollections(enabled = shelvesMayLoad)

    suspend fun fetch(v: LibraryView): List<ContinueItem> {
        lastFetchAt[0] = System.currentTimeMillis()
        return when (v) {
            // Downloads live on the phone; the Library draws DownloadsScreen for them.
            // Playlists have their own screen and their own requests.
            LibraryView.DOWNLOADS, LibraryView.PLAYLISTS -> emptyList()
            LibraryView.CONTINUE ->
                app.api.continueWatching().also { ContinueCache.put(app.session.plain, it) }.items
            LibraryView.WATCHLIST -> app.api.watchlist().items.map { it.asRow() }
            // The server runs favourites through its own Continue-row decorator, so they
            // arrive in exactly this shape already - with the progress fields always zero.
            LibraryView.FAVOURITES -> app.api.favorites().items
            LibraryView.HISTORY -> app.api.history().items
        }
    }

    LaunchedEffect(view, reloadKey) {
        // Continue view: paint last session's list straight away and refresh behind it, so the
        // landing screen never opens on a spinner. (The same cache is what Badges and the Trip
        // Recap read their watch activity from.) The other three views have no cache, so they
        // show the spinner as before - and either way `rows` is reset here, so switching views
        // never leaves the previous list on screen under the wrong heading.
        rows = if (view == LibraryView.CONTINUE)
            ContinueCache.get(app.session.plain)?.items.orEmpty() else emptyList()
        loading = rows.isEmpty()
        error = null
        actionMessage = null
        try {
            rows = fetch(view)
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            error = e.message ?: "Couldn't load your library."
        } finally {
            loading = false
        }
    }

    /** A quiet re-read: no spinner, and a failure keeps what is on screen. */
    suspend fun refreshQuietly(force: Boolean) {
        if (loading) return
        if (!force && !LibraryRefreshPolicy.shouldRefresh(System.currentTimeMillis(), lastFetchAt[0])) return
        val v = view
        try {
            val fresh = fetch(v)
            if (view == v) rows = fresh
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (_: Exception) {
            // Keep the list; the next trigger tries again.
        }
    }

    // Only while the Library is on screen (STARTED covers sitting under a picture-in-picture
    // player): catch up on return, follow the server's reports, and a slow interval.
    val lifecycleOwner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner, view) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            coroutineScope {
                launch { refreshQuietly(force = false) }
                launch { LiveProgress.shared.serverChanges.drop(1).collect { refreshQuietly(force = true) } }
                launch {
                    while (true) {
                        val interval = LibraryRefreshPolicy.intervalMs(
                            visible = true,
                            playbackActive = LiveProgress.shared.isPlaybackActive(System.currentTimeMillis())
                        ) ?: break
                        delay(interval)
                        refreshQuietly(force = false)
                    }
                }
            }
        }
    }

    /** What is drawn: the server's rows with the player's progress on top. */
    val shown = remember(rows, live, view) {
        val now = System.currentTimeMillis()
        when (view) {
            LibraryView.CONTINUE -> LiveProgressLogic.applyToContinue(ContinueGrouping.group(rows), live, now)
            LibraryView.HISTORY -> LiveProgressLogic.applyToHistory(rows, live)
            else -> rows
        }
    }

    fun runClear(request: PendingClear) {
        scope.launch {
            try {
                app.api.clearHistory(
                    scope = request.scope,
                    fileName = request.fileName,
                    title = request.title
                )
                // Also drop the local resume mark so the item doesn't come back from the phone.
                request.itemId?.let {
                    app.resume.clear(it)
                    LiveProgress.shared.forget(listOf(it))
                }
                if (request.scope == HistoryClear.SCOPE_ALL) app.resume.clearAll()
                reloadKey++
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                error = e.message ?: "Couldn't update your history."
            }
        }
    }

    /* ------------------------- Clear… (the separate actions) ------------------------- */

    val clearModel = remember {
        LibraryClearModel(object : LibraryClearModel.Api {
            override suspend fun counts(): LibraryClearCounts? = try {
                app.api.libraryClearCounts().counts
            } catch (e: ApiException) {
                if (e.code == 404) null else throw e
            }

            override suspend fun clear(kind: LibraryClearKind): Pair<Int, LibraryClearCounts?> {
                val r = app.api.clearLibrary(kind.wire)
                if (!r.ok) throw IllegalStateException(r.error ?: "not ok")
                return r.removed to r.counts
            }

            override suspend fun clearHistoryLegacy() {
                app.api.clearHistory(scope = HistoryClear.SCOPE_ALL)
            }
        })
    }
    val clearState by clearModel.state.collectAsState()
    var clearMenuOpen by remember { mutableStateOf(false) }

    fun confirmLibraryClear() {
        scope.launch {
            val cleared = try {
                clearModel.confirm()
            } catch (e: UnauthorizedException) {
                onUnauthorized()
                null
            } ?: return@launch
            when (cleared) {
                LibraryClearKind.HISTORY -> {
                    app.resume.clearAll()
                    ContinueCache.clear(app.session.plain)
                    LiveProgress.shared.clear()
                }
                LibraryClearKind.WATCHED -> LiveProgress.shared.clear()
                else -> Unit
            }
            reloadKey++
        }
    }

    /**
     * What a row opens.
     *
     * In Continue and History a "tv" row is an EPISODE — history is keyed on episode files — so
     * it plays. In the watchlist and favourites a "tv" row is a whole SHOW whose id is a show
     * key: there is no file behind it, and the stream URL the server builds from a show key
     * points at nothing, so it opens the show's episode list instead.
     */
    fun openRow(item: ContinueItem) {
        val isShowRow = item.kind == "tv" &&
            (view == LibraryView.WATCHLIST || view == LibraryView.FAVOURITES)
        if (isShowRow) {
            onOpenShow(item.id)
            return
        }
        context.startActivity(
            PlayerActivity.intentFor(
                context,
                itemId = item.id,
                kind = item.kind,
                title = item.title,
                streamUrl = UrlUtils.join(app.session.baseUrl, item.stream),
                localPath = app.downloads.localPath(item.id),
                posterUrl = UrlUtils.join(app.session.baseUrl, item.poster),
                // Jump straight to the saved position, like the website's ?t=
                resumePositionMs = (item.currentTime * 1000.0).toLong()
            )
        )
    }

    /** A discovery shelf tile: a film plays, a show opens its episode list. */
    fun openShelfItem(item: ShelfItem) {
        if (HomeShelvesData.opensShow(item)) {
            onOpenShow(HomeShelvesData.showKeyOf(item))
            return
        }
        context.startActivity(
            PlayerActivity.intentFor(
                context,
                itemId = item.id,
                kind = "movie",
                title = item.title,
                streamUrl = UrlUtils.join(app.session.baseUrl, item.stream),
                localPath = app.downloads.localPath(item.id),
                posterUrl = UrlUtils.join(app.session.baseUrl, item.poster)
            )
        )
    }

    /**
     * "I've finished this" / "I haven't actually seen this".
     *
     * Every id in the Continue and History lists is a film or episode file, so this is a
     * single-item mark. Watched takes the item out of Continue Watching and clears its resume
     * point on the server; WatchedActions mirrors that into the persisted ContinueCache (what this
     * tab paints from on a cold start) and the phone's own resume mark. The server KEEPS the
     * history row, so in All history the row stays and only its tick changes. Unwatched restores
     * nothing anywhere.
     */
    fun setRowWatched(item: ContinueItem, watched: Boolean) {
        scope.launch {
            try {
                val kind = if (item.kind == "tv") "tv" else "movie"
                val response = WatchedActions.markFile(app, kind, item.id, watched)
                if (!response.ok) {
                    actionMessage = "Your server didn't accept that, so nothing changed."
                    return@launch
                }
                val ids = response.ids.ifEmpty { listOf(item.id) }
                LiveProgress.shared.forget(ids)
                // Confirmed first, changed second: nothing moves until the server has taken it.
                rows = if (view == LibraryView.HISTORY) WatchedMarks.historyAfter(rows, ids, watched)
                else WatchedMarks.continueAfter(rows, ids, watched)
                // A marked episode's show moves on to its next episode: that is the server's answer.
                if (view == LibraryView.CONTINUE && watched) refreshQuietly(force = true)
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                actionMessage = "Couldn't reach your server, so nothing changed."
            }
        }
    }

    /**
     * Take a row off the watchlist, or clear its favourite flag — whichever list it is in. A
     * list you cannot remove from is a trap, and these two rows are not reachable from the
     * details overlay where the chips live.
     */
    fun dropFromList(item: ContinueItem) {
        scope.launch {
            try {
                val kind = if (item.kind == "tv") "tv" else "movie"
                val ok = if (view == LibraryView.WATCHLIST)
                    app.api.removeFromWatchlist(item.id, kind).ok
                else app.api.setFavorite(kind, item.id, favorite = false).ok
                if (!ok) {
                    actionMessage = "Your server didn't accept that, so nothing changed."
                    return@launch
                }
                rows = rows.filterNot { it.id == item.id }
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                actionMessage = "Couldn't reach your server, so nothing changed."
            }
        }
    }

    /** One Continue / History / list row with the actions that make sense in the current view. */
    val drawRow: @Composable (ContinueItem, Modifier) -> Unit = { row, rowModifier ->
        val historyView = view == LibraryView.CONTINUE || view == LibraryView.HISTORY
        ContinueRow(
            item = row,
            posterUrl = UrlUtils.join(app.session.baseUrl, row.poster),
            showProgress = historyView,
            modifier = rowModifier,
            onOpen = { openRow(row) },
            onMarkWatched = if (historyView && !row.watched) { { setRowWatched(row, true) } } else null,
            onMarkUnwatched = if (view == LibraryView.HISTORY && row.watched) {
                { setRowWatched(row, false) }
            } else null,
            onRemoveOne = if (historyView && !(row.upNext && row.currentTime <= 0.0)) {
                {
                    pendingClear = PendingClear(
                        scope = HistoryClear.SCOPE_ONE,
                        fileName = IdCodec.fileNameFor(row.id),
                        title = row.title,
                        itemId = row.id
                    )
                }
            } else null,
            onRemoveShow = if (historyView) {
                {
                    pendingClear = PendingClear(
                        scope = HistoryClear.SCOPE_SHOW,
                        title = HistoryClear.showTitleOf(row.title)
                    )
                }
            } else null,
            onDropFromList = if (historyView) null else { { dropFromList(row) } },
            dropFromListLabel = if (view == LibraryView.WATCHLIST)
                "Remove from watchlist" else "Remove from favourites"
        )
    }

    if (mode == ContinueMode.HOME) {
        HomeContent(
            rows = shown,
            loading = loading,
            error = error,
            actionMessage = actionMessage,
            shelves = shelves,
            collections = collections,
            isTv = isTv,
            drawRow = drawRow,
            onRetry = { reloadKey++ },
            onSurpriseMe = onSurpriseMe,
            onOpenShelfItem = { openShelfItem(it) },
            onOpenCollection = onOpenCollection,
            onOpenCollections = onOpenCollections
        )
    } else Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // Chips, not a seventh bottom tab and not a new destination: the watchlist and the
            // favourites are the same "my own lists over the library" idea this screen already
            // carries, they arrive in the row shape it already draws, and the chip row is an
            // affordance that is already here. Scrollable, because four chips plus "Clear…"
            // do not fit across a phone.
            Row(
                Modifier
                    .weight(1f)
                    .horizontalScroll(rememberScrollState()),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                LibrarySection.visibleOn(isTv).forEach { option ->
                    FilterChip(
                        selected = librarySection == option,
                        onClick = { onSectionChange(option) },
                        label = { Text(option.label) }
                    )
                }
            }
            // One entry point for the separate clear actions, whichever list is showing.
            TextButton(onClick = {
                clearMenuOpen = true
                scope.launch { clearModel.load() }
            }) { Text("Clear…") }
        }

        actionMessage?.let {
            Text(
                it,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp)
            )
        }

        when {
            // Downloads kept on this phone: the same screen that used to sit under Other.
            view == LibraryView.DOWNLOADS -> Box(Modifier.fillMaxSize()) { DownloadsScreen() }
            view == LibraryView.PLAYLISTS -> Box(Modifier.fillMaxSize()) {
                PlaylistsScreen(onUnauthorized = onUnauthorized)
            }
            loading -> LoadingBox()
            error != null -> ErrorBox(error!!, onRetry = { reloadKey++ })
            shown.isEmpty() -> EmptyBox(emptyMessage(view))
            else -> LazyColumn(Modifier.fillMaxSize()) {
                // Keyed on identity only: the live progress changes these rows every few seconds,
                // and a key that changed with them would throw away a TV remote's focus.
                items(shown, key = { it.kind + ":" + it.id }) { row -> drawRow(row, Modifier) }
            }
        }
    }

    val confirm = pendingClear
    if (confirm != null) {
        AlertDialog(
            onDismissRequest = { pendingClear = null },
            title = { Text("Remove from history?") },
            text = { Text(HistoryClear.confirmationFor(confirm.scope, confirm.title)) },
            confirmButton = {
                TextButton(onClick = {
                    pendingClear = null
                    runClear(confirm)
                }) { Text("Remove") }
            },
            dismissButton = {
                TextButton(onClick = { pendingClear = null }) { Text("Cancel") }
            }
        )
    }

    if (clearMenuOpen && clearState.pending == null) {
        AlertDialog(
            onDismissRequest = { clearMenuOpen = false },
            title = { Text("Clear my library") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (clearState.loading) Text("Counting…", fontSize = 13.sp)
                    clearState.actions.forEach { action ->
                        OutlinedButton(
                            onClick = { clearModel.ask(action.kind) },
                            enabled = action.enabled && !clearState.loading,
                            modifier = Modifier.fillMaxWidth()
                        ) { Text(action.label) }
                    }
                    if (clearState.legacyServer) {
                        Text(
                            "Update Beebo on your computer to clear favourites, the watchlist or watched marks separately.",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    clearState.message?.let {
                        Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            },
            confirmButton = { TextButton(onClick = { clearMenuOpen = false }) { Text("Done") } }
        )
    }

    val clearConfirm = clearState.confirmMessage
    if (clearMenuOpen && clearState.pending != null && clearConfirm != null) {
        AlertDialog(
            onDismissRequest = { clearModel.cancel() },
            title = { Text(clearState.pending!!.label + "?") },
            text = { Text(clearConfirm) },
            confirmButton = { TextButton(onClick = { confirmLibraryClear() }) { Text("Clear") } },
            dismissButton = { TextButton(onClick = { clearModel.cancel() }) { Text("Cancel") } }
        )
    }
}

private fun emptyMessage(view: LibraryView): String = when (view) {
    LibraryView.CONTINUE ->
        "Nothing part-watched right now.\nStart something and it'll show up here."
    LibraryView.WATCHLIST ->
        "Your watchlist is empty.\nOpen a title's details and tap Watchlist."
    LibraryView.FAVOURITES ->
        "No favourites yet.\nOpen a title's details and tap Favourite."
    LibraryView.HISTORY -> "You haven't watched anything yet."
    LibraryView.DOWNLOADS, LibraryView.PLAYLISTS -> ""
}

/** Which of the two tabs [ContinueScreen] is drawing. */
enum class ContinueMode { HOME, LIBRARY }

/**
 * Home: Continue watching first, then Up next, Recently added, Because you watched and
 * Collections (see [HomeLayout]), with "Surprise me" at the top. On a TV the first Continue row
 * takes focus once, so the first select resumes what you were watching.
 */
@Composable
private fun HomeContent(
    rows: List<ContinueItem>,
    loading: Boolean,
    error: String?,
    actionMessage: String?,
    shelves: HomeShelvesData,
    collections: List<com.beeboentertainment.movie.data.CollectionSummary>,
    isTv: Boolean,
    drawRow: @Composable (ContinueItem, Modifier) -> Unit,
    onRetry: () -> Unit,
    onSurpriseMe: () -> Unit,
    onOpenShelfItem: (ShelfItem) -> Unit,
    onOpenCollection: (Int, String) -> Unit,
    onOpenCollections: () -> Unit
) {
    val app = BeeboApp.instance
    val (continuing, upNext) = remember(rows) { HomeLayout.split(rows) }
    val sections = HomeLayout.visibleSections(
        continueCount = continuing.size,
        upNextCount = upNext.size,
        recentCount = shelves.recent.size,
        recommendedCount = shelves.recommended.size,
        collectionsCount = collections.size
    )
    val firstFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    val firstKey = (continuing + upNext).firstOrNull()?.let { it.kind + ":" + it.id }
    var focusedOnce by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(firstKey) {
        if (isTv && !focusedOnce && firstKey != null) {
            // One frame later than the rail's own first focus, so Continue wins.
            androidx.compose.runtime.withFrameNanos { }
            delay(50)
            if (runCatching { firstFocus.requestFocus() }.isSuccess) focusedOnce = true
        }
    }

    fun headingItem(scope: androidx.compose.foundation.lazy.LazyListScope, section: HomeSection) {
        scope.item(key = "heading-" + section.name) {
            Text(
                section.heading,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(start = 12.dp, top = 12.dp, bottom = 4.dp)
            )
        }
    }

    LazyColumn(Modifier.fillMaxSize()) {
        item(key = "surprise") {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "Welcome back",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f)
                )
                OutlinedButton(onClick = onSurpriseMe) { Text("🎲 Surprise me") }
            }
        }
        actionMessage?.let { message ->
            item(key = "message") {
                Text(
                    message,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp)
                )
            }
        }
        when {
            loading && rows.isEmpty() -> item(key = "loading") {
                Box(Modifier.fillMaxWidth().height(160.dp)) { LoadingBox() }
            }
            error != null && rows.isEmpty() -> item(key = "error") {
                Box(Modifier.fillMaxWidth().height(220.dp)) { ErrorBox(error, onRetry = onRetry) }
            }
            continuing.isEmpty() && upNext.isEmpty() -> item(key = "empty") {
                Text(
                    "Nothing part-watched right now. Start something and it'll show up here.",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 16.dp)
                )
            }
        }
        sections.forEach { section ->
            when (section) {
                HomeSection.CONTINUE -> {
                    headingItem(this, section)
                    items(continuing, key = { it.kind + ":" + it.id }) { row ->
                        val key = row.kind + ":" + row.id
                        drawRow(row, if (key == firstKey) Modifier.focusRequester(firstFocus) else Modifier)
                    }
                }
                HomeSection.UP_NEXT -> {
                    headingItem(this, section)
                    items(upNext, key = { it.kind + ":" + it.id }) { row ->
                        val key = row.kind + ":" + row.id
                        drawRow(row, if (key == firstKey) Modifier.focusRequester(firstFocus) else Modifier)
                    }
                }
                HomeSection.RECENTLY_ADDED -> item(key = "shelf-recent") {
                    ShelfRow(HomeShelvesData.RECENT_HEADING, shelves.recent, app.session.baseUrl, onOpenShelfItem)
                }
                HomeSection.BECAUSE_YOU_WATCHED -> item(key = "shelf-recommended") {
                    ShelfRow(shelves.recommendedHeading, shelves.recommended, app.session.baseUrl, onOpenShelfItem)
                }
                HomeSection.COLLECTIONS -> item(key = "shelf-collections") {
                    CollectionsShelf(
                        items = collections,
                        baseUrl = app.session.baseUrl,
                        onOpen = onOpenCollection,
                        onSeeAll = onOpenCollections
                    )
                }
            }
        }
        item(key = "bottom-space") { Spacer(Modifier.height(16.dp)) }
    }
}

/** A destructive history action awaiting confirmation. */
private data class PendingClear(
    val scope: String,
    val fileName: String? = null,
    val title: String? = null,
    val itemId: String? = null
)

/**
 * The four lists this tab can show. All four come back in the same row shape, which is exactly
 * why they can share one screen instead of each needing a destination of its own.
 */
private enum class LibraryView(val label: String) {
    CONTINUE("▶ Continue"),
    WATCHLIST("☆ Watchlist"),
    FAVOURITES("★ Favourites"),
    PLAYLISTS("🎵 Playlists"),
    HISTORY("All history"),
    DOWNLOADS("Downloads")
}

/**
 * A watchlist entry drawn as a Continue row.
 *
 * The server stores a watchlist entry exactly as the client posted it, so the title, poster and
 * stream here are the ones the catalogue gave us at the moment it was added. Progress stays at
 * zero — nothing on a watchlist has been started — which is why these rows are drawn without a
 * progress bar at all. The server accepts "show" as a synonym for "tv", so both fold to "tv".
 */
private fun WatchlistEntry.asRow(): ContinueItem = ContinueItem(
    id = id,
    kind = if (kind == "tv" || kind == "show") "tv" else "movie",
    title = title,
    poster = poster,
    stream = stream
)

@Composable
private fun ContinueRow(
    item: ContinueItem,
    posterUrl: String?,
    /** False for the watchlist and favourites, whose progress fields are always zero. */
    showProgress: Boolean,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
    /** Every menu action is ABSENT — not disabled — in a view where it would make no sense. */
    onMarkWatched: (() -> Unit)? = null,
    onMarkUnwatched: (() -> Unit)? = null,
    onRemoveOne: (() -> Unit)? = null,
    onRemoveShow: (() -> Unit)? = null,
    onDropFromList: (() -> Unit)? = null,
    dropFromListLabel: String = ""
) {
    var menuOpen by remember { mutableStateOf(false) }
    val percent = ContinueFormat.percent(item.percent, item.currentTime, item.duration)

    Card(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp)
            .clickable(onClick = onOpen)
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier
                    .width(46.dp)
                    .height(69.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center
            ) {
                if (posterUrl != null) {
                    AsyncImage(
                        model = posterUrl,
                        contentDescription = item.title,
                        modifier = Modifier.fillMaxSize()
                    )
                } else {
                    // The server returns null when it has no cached poster - normal, not an error.
                    Icon(
                        Icons.Filled.Movie,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Spacer(Modifier.width(10.dp))

            Column(Modifier.weight(1f)) {
                Text(
                    item.title,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                if (showProgress && item.upNext && item.currentTime <= 0.0) {
                    // The show's next episode, not started yet: no empty bar.
                    Spacer(Modifier.height(4.dp))
                    Text("Up next", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                } else if (showProgress) {
                    Spacer(Modifier.height(5.dp))
                    LinearProgressIndicator(
                        progress = { ContinueFormat.fraction(percent) },
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        // A watched row says so rather than "97% · 1 min left".
                        if (item.watched) "✓ Watched"
                        else ContinueFormat.subtitle(item.percent, item.currentTime, item.duration),
                        fontSize = 12.sp,
                        color = if (item.watched) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            IconButton(onClick = onOpen) {
                Icon(
                    Icons.Filled.PlayArrow,
                    contentDescription = if (showProgress && !(item.upNext && item.currentTime <= 0.0)) "Resume" else if (showProgress) "Play" else "Open",
                    tint = MaterialTheme.colorScheme.primary
                )
            }

            // No menu button at all when the current view has nothing to put behind it.
            val hasMenu = onMarkWatched != null || onMarkUnwatched != null || onRemoveOne != null ||
                onRemoveShow != null || onDropFromList != null
            if (hasMenu) {
                Box {
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "More")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        onMarkWatched?.let { action ->
                            DropdownMenuItem(
                                text = { Text("Mark as watched") },
                                onClick = { menuOpen = false; action() }
                            )
                        }
                        onMarkUnwatched?.let { action ->
                            DropdownMenuItem(
                                text = { Text("Mark as unwatched") },
                                onClick = { menuOpen = false; action() }
                            )
                        }
                        onDropFromList?.let { action ->
                            DropdownMenuItem(
                                text = { Text(dropFromListLabel) },
                                onClick = { menuOpen = false; action() }
                            )
                        }
                        onRemoveOne?.let { action ->
                            DropdownMenuItem(
                                text = { Text("Remove this") },
                                onClick = { menuOpen = false; action() }
                            )
                        }
                        onRemoveShow?.let { action ->
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        if (item.kind == "tv")
                                            "Remove all for \"${HistoryClear.showTitleOf(item.title)}\""
                                        else "Remove all for this movie"
                                    )
                                },
                                onClick = { menuOpen = false; action() }
                            )
                        }
                    }
                }
            }
        }
    }
}
