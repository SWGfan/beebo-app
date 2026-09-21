package com.beeboentertainment.auto.media

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaConstants
import com.beeboentertainment.auto.data.ApiClient
import com.beeboentertainment.auto.data.EpisodeItem
import com.beeboentertainment.auto.data.Genre
import com.beeboentertainment.auto.data.HistoryItem
import com.beeboentertainment.auto.data.MovieItem
import com.beeboentertainment.auto.data.Prefs
import com.beeboentertainment.auto.data.ShowItem
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import android.os.Bundle
import android.os.SystemClock
import java.util.concurrent.ConcurrentHashMap

/**
 * Builds the browse tree the car sees, and caches enough of the library to
 * answer without a round trip per tap.
 *
 * Shape of the tree (root children are all browsable and there are at most
 * four of them, because Android Auto asks for at most four and drops the rest):
 *
 *   Continue Watching -> playable
 *   Movies            -> Recently Added | A-Z -> letter -> playable | Genres -> genre -> playable
 *   TV Shows          -> show -> season -> playable
 *   Surprise Me       -> playable
 *
 * Nothing here swallows a failure. A browse that cannot be answered has to
 * reach the car as words on the screen, and only the service knows how to say
 * them, so every loader throws and PlaybackService classifies.
 *
 * Each cached list has its own mutex rather than sharing one. The lock is held
 * across the fetch on purpose — that is what makes concurrent taps on the same
 * node share a single request instead of stampeding — but a slow /api/tvshows
 * must never be able to hold up a movie lookup, which is what one global lock
 * used to do for up to the full 60-second read timeout.
 */
class Catalog(context: Context) {

    private val api = ApiClient(context)
    private val prefs = Prefs.get(context)

    /** The Music part of the tree (MusicBrowse.kt): artists, albums, songs and playlists. */
    private val music = MusicBrowse(api)

    private val moviesLock = Mutex()
    private val recentLock = Mutex()
    private val showsLock = Mutex()
    private val surpriseLock = Mutex()
    private val episodeLocks = ConcurrentHashMap<String, Mutex>()

    @Volatile private var movies: List<MovieItem> = emptyList()
    @Volatile private var movieGenres: List<Genre> = emptyList()
    @Volatile private var moviesFetchedAt = 0L

    @Volatile private var recent: List<MovieItem> = emptyList()
    @Volatile private var recentFetchedAt = 0L

    @Volatile private var shows: List<ShowItem> = emptyList()
    @Volatile private var showsFetchedAt = 0L

    private val episodesByShow = ConcurrentHashMap<String, List<EpisodeItem>>()
    private val episodesFetchedAt = ConcurrentHashMap<String, Long>()

    /**
     * Everything a play request needs about an id we have already listed.
     *
     * The title and poster live here, not just the stream path, because
     * Continue Watching, Surprise Me and search all hand the car ids that are
     * in no other cache — and without them the now-playing screen says
     * "Beebo Entertainment" with no artwork, and a play-from-search re-downloads the
     * whole library looking for a path it was already told.
     */
    private class Known(
        val streamPath: String,
        val fetchedAt: Long,
        val title: String,
        val subtitle: String?,
        val posterPath: String?,
    )

    private val known = ConcurrentHashMap<String, Known>()

    @Volatile private var surprise: List<MediaItem> = emptyList()
    @Volatile private var surpriseFetchedAt = 0L
    @Volatile private var surpriseFailedAt = 0L

    @Volatile private var searchResults: List<MediaItem> = emptyList()
    @Volatile private var searchQuery: String? = null

    /** How many root children the host said it will show. */
    @Volatile var rootLimit: Int = DEFAULT_ROOT_LIMIT

    // ------------------------------------------------------------------ tree

    fun rootItem(id: String): MediaItem = browsable(id, "Beebo Entertainment")

    /**
     * Music sits second, ahead of the video tabs: it is what a car is mostly for, and a host that
     * only shows four tabs must not be the one to drop it. Surprise Me is the one that falls off
     * there, so it is offered again inside Movies (see children).
     */
    fun rootTabs(limit: Int): List<MediaItem> = listOf(
        browsable(
            MediaIds.TAB_CONTINUE, "Continue Watching",
            style = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
        ),
        music.tab(),
        browsable(
            MediaIds.TAB_MOVIES, "Movies",
            style = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
        ),
        browsable(
            MediaIds.TAB_TV, "TV Shows",
            style = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM,
        ),
        browsable(
            MediaIds.TAB_PLAYLISTS, "Playlists",
            style = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
        ),
        browsable(
            MediaIds.TAB_SURPRISE, "Surprise Me",
            style = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
        ),
    ).take(limit.coerceAtLeast(1))

    /** Surprise Me moves inside Playlists when the host shows only four root tabs. */
    private fun surpriseAtRoot(): Boolean = rootLimit >= ROOT_TABS_WITH_SURPRISE

    suspend fun children(parentId: String): List<MediaItem> = when {
        parentId == MediaIds.ROOT_AUTO || parentId == MediaIds.ROOT_APP ->
            rootTabs(rootLimit)

        parentId == MediaIds.ROOT_RECENT -> continueItems().take(1)

        parentId == MediaIds.TAB_CONTINUE -> continueItems()

        parentId == MediaIds.TAB_MOVIES -> listOfNotNull(
            browsable(MediaIds.MOVIES_RECENT, "Recently Added"),
            browsable(MediaIds.MOVIES_AZ, "All Movies A-Z"),
            browsable(MediaIds.MOVIES_GENRES, "Genres"),
            // Music took a root tab, so on a host that shows only four, Playlists and Surprise Me
            // fall off the root. Both stay one tap away from here.
            if (rootLimit < ROOT_TABS_WITH_PLAYLISTS) browsable(MediaIds.TAB_PLAYLISTS, "Playlists") else null,
            if (rootLimit < ROOT_TABS_WITH_PLAYLISTS) browsable(MediaIds.TAB_SURPRISE, "Surprise Me") else null,
        )

        parentId == MediaIds.MOVIES_RECENT -> {
            // The server flags isNew over a seven-day window, so in the normal
            // state nothing is new. Falling back to the whole library there
            // turned this into a second, worse A-Z list.
            val newest = loadRecent().filter { it.isNew }.take(MAX_FLAT)
            if (newest.isEmpty()) listOf(notice("Nothing added in the last week"))
            else newest.map { movieItem(it) }
        }

        parentId == MediaIds.MOVIES_AZ -> {
            loadMovies()
            lettersOf(movies.map { it.title }).map { letter ->
                browsable(MediaIds.moviesLetter(letter), letter)
            }
        }

        parentId == MediaIds.MOVIES_GENRES -> {
            loadMovies()
            movieGenres.sortedBy { it.name }
                .map { browsable(MediaIds.moviesGenre(it.id), "${it.name} (${it.count})") }
        }

        MediaIds.parseLetter(parentId) != null -> {
            loadMovies()
            val letter = MediaIds.parseLetter(parentId)!!
            movies.filter { bucketOf(it.title) == letter }
                .sortedBy { it.title.lowercase() }
                .take(MAX_FLAT)
                .map { movieItem(it) }
        }

        MediaIds.parseGenre(parentId) != null -> {
            loadMovies()
            val gid = MediaIds.parseGenre(parentId)!!
            movies.filter { gid in it.genres }
                .sortedBy { it.title.lowercase() }
                .take(MAX_FLAT)
                .map { movieItem(it) }
        }

        parentId == MediaIds.TAB_TV -> {
            loadShows()
            val sorted = shows.sortedBy { it.name.lowercase() }
            if (sorted.size > MAX_FLAT) {
                lettersOf(sorted.map { it.name }).map { letter ->
                    browsable(MediaIds.tvLetter(letter), letter)
                }
            } else {
                sorted.map { showFolder(it) }
            }
        }

        MediaIds.parseTvLetter(parentId) != null -> {
            loadShows()
            val letter = MediaIds.parseTvLetter(parentId)!!
            shows.filter { bucketOf(it.name) == letter }
                .sortedBy { it.name.lowercase() }
                .take(MAX_FLAT)
                .map { showFolder(it) }
        }

        MediaIds.parseShow(parentId) != null -> {
            val key = MediaIds.parseShow(parentId)!!
            val eps = loadEpisodes(key)
            val seasons = eps.map { it.season }.distinct()
            if (seasons.size <= 1) {
                eps.take(MAX_FLAT).map { episodeItem(it) }
            } else {
                seasons.sortedWith(compareBy(nullsLast()) { it })
                    .map { s ->
                        browsable(
                            MediaIds.season(key, s),
                            if (s == null) "Other" else "Season $s",
                        )
                    }
            }
        }

        MediaIds.parseSeason(parentId) != null -> {
            val (key, season) = MediaIds.parseSeason(parentId)!!
            loadEpisodes(key).filter { it.season == season }
                .take(MAX_FLAT)
                .map { episodeItem(it) }
        }

        MusicIds.isMusic(parentId) -> music.children(parentId) { notice(it) }

        parentId == MediaIds.TAB_SURPRISE -> surpriseItems()

        parentId == MediaIds.TAB_PLAYLISTS -> {
            val surpriseRow = if (surpriseAtRoot()) emptyList()
            else listOf(browsable(MediaIds.TAB_SURPRISE, "Surprise Me"))
            val lists = api.playlists().playlists
            surpriseRow + if (lists.isEmpty()) {
                listOf(notice("No playlists yet - make one in the Beebo app"))
            } else {
                lists.take(MAX_FLAT).map { p ->
                    browsable(
                        MediaIds.playlist(p.id),
                        (if (p.smart) "✨ " else "") + p.name,
                        subtitle = p.itemCount?.let { "$it item${if (it == 1) "" else "s"}" },
                    )
                }
            }
        }

        MediaIds.parsePlaylist(parentId) != null -> playlistRows(MediaIds.parsePlaylist(parentId)!!)

        else -> emptyList()
    }

    // --------------------------------------------------------------- playlists

    /**
     * A playlist folder: Play all, Shuffle, Resume, then its items. Every row is playable and
     * expands (see [resolvePlaylist]) into the rest of the playlist.
     */
    private suspend fun playlistRows(playlistId: String): List<MediaItem> {
        val order = api.playPlaylist(playlistId)
        val resumable = runCatching { api.playPlaylist(playlistId, resume = true) }.getOrNull()
        if (order.items.isEmpty()) return listOf(notice("Nothing playable in this playlist yet"))
        val rows = ArrayList<MediaItem>()
        rows += playable(PlaylistStart(playlistId, PlaylistStart.Mode.ORDER).mediaId(), "▶ Play all", "${order.items.size} items", null)
        rows += playable(PlaylistStart(playlistId, PlaylistStart.Mode.SHUFFLE).mediaId(), "🔀 Shuffle", null, null)
        if (resumable != null && resumable.startIndex > 0) {
            rows += playable(
                PlaylistStart(playlistId, PlaylistStart.Mode.RESUME).mediaId(),
                "⏯ Resume",
                resumable.items.getOrNull(resumable.startIndex)?.title,
                null,
            )
        }
        order.items.take(MAX_FLAT).forEachIndexed { index, e ->
            rows += playable(
                PlaylistStart(playlistId, PlaylistStart.Mode.FROM, index).mediaId(),
                e.title,
                listOfNotNull(e.year?.toString(), e.quality).joinToString(" · ").ifBlank { null },
                e.poster,
            )
        }
        return rows
    }

    /** Where each expanded playlist item came from, for playlist progress. */
    data class PlaylistOrigin(val playlistId: String, val entryId: String, val index: Int, val shuffle: Boolean, val seed: Long)

    private val playlistOrigins = ConcurrentHashMap<String, PlaylistOrigin>()

    fun playlistOriginOf(mediaId: String?): PlaylistOrigin? = mediaId?.let { playlistOrigins[it] }

    /**
     * A `plstart/...` row as the MediaItems the player queues, with fresh stream tokens. Null
     * for any other id; an empty list when the playlist has nothing playable.
     */
    suspend fun resolvePlaylist(mediaId: String): List<MediaItem>? {
        val start = PlaylistStart.parse(mediaId) ?: return null
        val response = api.playPlaylist(start.playlistId, shuffle = start.shuffle, resume = start.resume)
        val offset = when (start.mode) {
            PlaylistStart.Mode.FROM -> start.fromIndex
            PlaylistStart.Mode.RESUME -> response.startIndex
            else -> 0
        }
        return start.order(response).mapIndexedNotNull { i, e ->
            val itemId = if (e.kind == "tv") MediaIds.episode(e.id) else MediaIds.movie(e.id)
            remember(itemId, e.stream.orEmpty(), e.title, e.year?.toString(), e.poster)
            playlistOrigins[itemId] = PlaylistOrigin(start.playlistId, e.entryId, offset + i, response.shuffle, response.seed)
            resolvePlayable(itemId)
        }
    }

    /**
     * The browsable item for an id this tree recognises, or null.
     *
     * onGetItem needs the distinction: inventing a folder for any id at all
     * made every string in the universe subscribable, because the default
     * onSubscribe asks onGetItem and accepts whatever comes back browsable.
     */
    fun browsableItemFor(mediaId: String): MediaItem? = when {
        mediaId == MediaIds.ROOT_AUTO || mediaId == MediaIds.ROOT_APP ||
            mediaId == MediaIds.ROOT_RECENT -> rootItem(mediaId)

        mediaId == MediaIds.NOTICE -> notice("Beebo Entertainment Auto")

        mediaId == MediaIds.TAB_CONTINUE -> browsable(mediaId, "Continue Watching")
        mediaId == MediaIds.TAB_MOVIES -> browsable(mediaId, "Movies")
        mediaId == MediaIds.TAB_TV -> browsable(mediaId, "TV Shows")
        mediaId == MediaIds.TAB_SURPRISE -> browsable(mediaId, "Surprise Me")
        mediaId == MediaIds.TAB_PLAYLISTS -> browsable(mediaId, "Playlists")
        MediaIds.parsePlaylist(mediaId) != null -> browsable(mediaId, "Playlist")
        mediaId == MediaIds.MOVIES_RECENT -> browsable(mediaId, "Recently Added")
        mediaId == MediaIds.MOVIES_AZ -> browsable(mediaId, "All Movies A-Z")
        mediaId == MediaIds.MOVIES_GENRES -> browsable(mediaId, "Genres")

        MediaIds.parseLetter(mediaId) != null ->
            browsable(mediaId, MediaIds.parseLetter(mediaId)!!)

        MediaIds.parseTvLetter(mediaId) != null ->
            browsable(mediaId, MediaIds.parseTvLetter(mediaId)!!)

        MediaIds.parseGenre(mediaId) != null -> {
            val gid = MediaIds.parseGenre(mediaId)!!
            browsable(mediaId, movieGenres.firstOrNull { it.id == gid }?.name ?: "Genre")
        }

        MediaIds.parseShow(mediaId) != null -> {
            val key = MediaIds.parseShow(mediaId)!!
            shows.firstOrNull { it.key == key }?.let { showFolder(it) }
                ?: browsable(mediaId, "TV show")
        }

        MediaIds.parseSeason(mediaId) != null -> {
            val season = MediaIds.parseSeason(mediaId)!!.second
            browsable(mediaId, if (season == null) "Other" else "Season $season")
        }

        else -> null
    }

    /** Music's own browsable ids (artists, albums, one artist, one album). */
    suspend fun musicItemFor(mediaId: String): MediaItem? =
        if (MusicIds.isMusic(mediaId)) music.itemFor(mediaId) else null

    /**
     * A row whose only job is to say something to the user.
     *
     * It has to be browsable. Android Auto's legacy bridge turns
     * (isBrowsable, isPlayable) into a flags int, and an item with neither is
     * flags == 0: unclickable, and dropped outright wherever the host asked for
     * browsable children only — which is exactly what it asks for at the root,
     * the one place a "you are not signed in" row has to appear.
     */
    fun notice(text: String): MediaItem = browsable(MediaIds.NOTICE, text)

    // ----------------------------------------------------------------- search

    /**
     * Search results, cached against the query string.
     *
     * The car asks twice for every search — once for a count, once for the
     * rows — and /api/tvshows can do forty first-time TMDB lookups with poster
     * downloads. Running it twice is both slow and wrong: the count the host
     * was told could disagree with the list it was later handed.
     */
    suspend fun search(query: String): List<MediaItem> {
        val q = query.trim()
        if (q.isBlank() || !prefs.isConfigured) return emptyList()
        if (searchQuery == q) return searchResults

        val movieHits = runCatching { api.movies(q = q) }.getOrNull()
        val showHits = runCatching { api.tvShows(q = q) }.getOrNull()
        if (movieHits == null && showHits == null) return emptyList()

        val rows = movieHits?.items.orEmpty().take(SEARCH_MOVIES).map { m ->
            remember(MediaIds.movie(m.id), m.stream, m.title, m.year?.toString(), m.poster)
            movieItem(m)
        } + showHits?.items.orEmpty().take(SEARCH_SHOWS).map { showFolder(it) }

        // Nothing by exact words: spoken searches are often a letter off ("freinds"), so fall
        // back to the voice matcher over the lists the car already has.
        if (rows.isEmpty()) {
            val spoken = VoiceSearch.parse(q)
            val fuzzy = movies.map { it to VoiceSearch.similarity(spoken.title, it.title) }
                .filter { it.second >= VoiceSearch.MIN_SCORE }.sortedByDescending { it.second }
                .take(SEARCH_MOVIES).map { (m, _) -> movieItem(m) } +
                shows.map { it to VoiceSearch.similarity(spoken.title, it.name) }
                    .filter { it.second >= VoiceSearch.MIN_SCORE }.sortedByDescending { it.second }
                    .take(SEARCH_SHOWS).map { (s, _) -> showFolder(s) }
            searchResults = fuzzy
            searchQuery = q
            return fuzzy
        }

        searchResults = rows
        searchQuery = q
        return rows
    }

    // ------------------------------------------------------------ voice search

    /**
     * "Hey Google, play Friends season 2 episode 3 on Beebo" in the car: the spoken words
     * become one playable item, or null when nothing in the library is close enough (a guess
     * must not start the wrong film while someone is driving). A show with no episode named
     * carries on from its newest Continue Watching episode, else its first episode.
     * An empty query ("play Beebo") resumes the newest Continue Watching item.
     */
    suspend fun resolveVoice(spoken: String): MediaItem? {
        if (!prefs.isConfigured) return null
        val q = VoiceSearch.parse(spoken)
        if (q.resume) {
            val h = runCatching { api.continueWatching().items.firstOrNull() }.getOrNull() ?: return null
            val mediaId = if (h.kind == "tv") MediaIds.episode(h.id) else MediaIds.movie(h.id)
            remember(mediaId, h.stream, h.title, null, h.poster)
            return resolvePlayable(mediaId)
        }
        runCatching { loadMovies() }
        runCatching { loadShows() }
        val candidates = movies.map { VoiceSearch.Candidate(it.id, it.title, VoiceSearch.Focus.MOVIE, it.year) } +
            shows.map { VoiceSearch.Candidate(it.key, it.name, VoiceSearch.Focus.SHOW, it.year) }
        val match = VoiceSearch.bestMatch(q, candidates) ?: return null
        if (match.candidate.kind == VoiceSearch.Focus.MOVIE) return resolvePlayable(MediaIds.movie(match.candidate.id))
        val episodes = runCatching { loadEpisodes(match.candidate.id) }.getOrNull().orEmpty()
        val ordered = episodes.map { VoiceSearch.EpisodeRef(it.id, it.season, it.episode) }
        val pick = if (q.season != null) VoiceSearch.pickEpisode(ordered, q.season, q.episode)
        else {
            val ids = episodes.map { it.id }.toSet()
            val inProgress = runCatching { api.continueWatching().items }.getOrNull().orEmpty()
                .firstOrNull { it.kind == "tv" && it.id in ids }
            inProgress?.let { h -> ordered.firstOrNull { it.id == h.id } } ?: VoiceSearch.pickEpisode(ordered, null, null)
        }
        return pick?.let { resolvePlayable(MediaIds.episode(it.id)) }
    }

    // ----------------------------------------------------------------- loaders

    private suspend fun loadMovies(force: Boolean = false) {
        val startedAt = SystemClock.elapsedRealtime()
        if (!force && movies.isNotEmpty() && fresh(moviesFetchedAt)) return
        moviesLock.withLock {
            // Someone else's fetch landed while this call was queued behind it.
            if (movies.isNotEmpty() && usable(moviesFetchedAt, force, startedAt)) return
            val r = api.movies(sort = "title")
            r.items.forEach {
                remember(MediaIds.movie(it.id), it.stream, it.title, it.year?.toString(), it.poster)
            }
            movies = r.items
            movieGenres = r.genres
            moviesFetchedAt = SystemClock.elapsedRealtime()
        }
    }

    private suspend fun loadRecent(): List<MovieItem> {
        val startedAt = SystemClock.elapsedRealtime()
        if (recent.isNotEmpty() && fresh(recentFetchedAt)) return recent
        recentLock.withLock {
            if (recent.isNotEmpty() && usable(recentFetchedAt, false, startedAt)) return recent
            val r = api.movies(sort = "new")
            r.items.forEach {
                remember(MediaIds.movie(it.id), it.stream, it.title, it.year?.toString(), it.poster)
            }
            recent = r.items
            recentFetchedAt = SystemClock.elapsedRealtime()
            return r.items
        }
    }

    private suspend fun loadShows(force: Boolean = false) {
        val startedAt = SystemClock.elapsedRealtime()
        if (!force && shows.isNotEmpty() && fresh(showsFetchedAt)) return
        showsLock.withLock {
            if (shows.isNotEmpty() && usable(showsFetchedAt, force, startedAt)) return
            shows = api.tvShows().items
            showsFetchedAt = SystemClock.elapsedRealtime()
        }
    }

    private suspend fun loadEpisodes(showKey: String, force: Boolean = false): List<EpisodeItem> {
        val startedAt = SystemClock.elapsedRealtime()
        val cached = episodesByShow[showKey]
        if (!force && cached != null && fresh(episodesFetchedAt[showKey] ?: 0L)) return cached
        episodeLocks.computeIfAbsent(showKey) { Mutex() }.withLock {
            val now = episodesByShow[showKey]
            if (now != null && usable(episodesFetchedAt[showKey] ?: 0L, force, startedAt)) return now
            val r = api.episodes(showKey)
            val flat = r.seasons.flatMap { it.episodes }
            flat.forEach {
                remember(MediaIds.episode(it.id), it.stream, it.title, null, r.show.poster)
            }
            episodesByShow[showKey] = flat
            episodesFetchedAt[showKey] = SystemClock.elapsedRealtime()
            return flat
        }
    }

    private suspend fun continueItems(): List<MediaItem> {
        val r = api.continueWatching()
        return r.items.take(MAX_FLAT).map { h ->
            val mediaId = if (h.kind == "tv") MediaIds.episode(h.id) else MediaIds.movie(h.id)
            remember(mediaId, h.stream, h.title, null, h.poster)
            playable(
                mediaId = mediaId,
                title = h.title,
                subtitle = progressLabel(h),
                posterPath = h.poster,
                extras = Bundle().apply {
                    putInt(
                        MediaConstants.EXTRAS_KEY_COMPLETION_STATUS,
                        MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED,
                    )
                    if (h.duration > 0) {
                        putDouble(
                            MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE,
                            (h.currentTime / h.duration).coerceIn(0.0, 1.0),
                        )
                    }
                },
            )
        }
    }

    /**
     * Every /api/surf is a full movie-and-TV directory scan server-side, and
     * they have to run in series because each one needs the previous seed. Ten
     * is as long as anyone will watch a spinner.
     */
    private suspend fun surpriseItems(): List<MediaItem> {
        if (surprise.isNotEmpty() && fresh(surpriseFetchedAt, SURPRISE_TTL_MS)) return surprise
        surpriseLock.withLock {
            if (surprise.isNotEmpty() && fresh(surpriseFetchedAt, SURPRISE_TTL_MS)) return surprise
            if (fresh(surpriseFailedAt, SURPRISE_RETRY_MS)) return emptyList()

            val out = ArrayList<MediaItem>(SURPRISE_COUNT)
            var seed: Long? = null
            for (i in 0 until SURPRISE_COUNT) {
                // The first round trip is allowed to throw so the car gets a
                // real message; after that a failure just shortens the list.
                val r = if (i == 0) api.surf(kind = "both", seed = seed, index = i)
                else runCatching { api.surf(kind = "both", seed = seed, index = i) }
                    .getOrNull() ?: break
                seed = r.seed
                val item = r.item ?: break
                val mediaId =
                    if (item.kind == "tv") MediaIds.episode(item.id) else MediaIds.movie(item.id)
                remember(mediaId, item.stream, item.title, null, item.poster)
                out += playable(mediaId, item.title, null, item.poster)
                if (r.total <= i + 1) break
            }

            if (out.isEmpty()) {
                // Caching an empty result for half an hour meant one bad round
                // trip made the tab useless until the service was restarted.
                surpriseFailedAt = SystemClock.elapsedRealtime()
                return emptyList()
            }
            surprise = out
            surpriseFetchedAt = SystemClock.elapsedRealtime()
            return out
        }
    }

    // --------------------------------------------------------------- playback

    /**
     * Turns a browse mediaId into something ExoPlayer can open.
     *
     * The `mt` token baked into a stream path is only good for 12 hours, so a
     * path older than [STREAM_TTL_MS] is refetched before use rather than
     * handed to the player to fail on. A stale token does not 401 — it
     * redirects to the HTML login page, which the player would try to parse as
     * media, so this is worth being careful about.
     */
    suspend fun resolvePlayable(mediaId: String): MediaItem? {
        if (MusicIds.isMusic(mediaId)) return music.resolvePlayable(mediaId)
        val (kind, serverId) = MediaIds.parsePlayable(mediaId) ?: return null

        var path = freshStreamPath(mediaId)
        if (path == null) {
            when (kind) {
                "tv" -> {
                    // Ask the server which show this episode belongs to rather
                    // than walking the whole library — ids are opaque, so this
                    // endpoint is the only honest way to find the right show.
                    val showKey = runCatching { api.episodeContext(serverId) }
                        .getOrNull()?.takeIf { it.ok }?.showKey
                    if (showKey != null) {
                        loadEpisodes(showKey, force = true)
                        path = freshStreamPath(mediaId)
                    }
                }
                else -> {
                    loadMovies(force = true)
                    path = freshStreamPath(mediaId)
                }
            }
        }
        val streamPath = path ?: return null
        val url = api.absolute(streamPath) ?: return null

        val meta = knownMetadata(mediaId, kind, serverId)
        return MediaItem.Builder()
            .setMediaId(mediaId)
            .setUri(url)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(meta.first)
                    .setArtist(meta.second)
                    .setArtworkUri(ArtworkUris.forServerPath(meta.third))
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                    .build()
            )
            .build()
    }

    /** (title, subtitle, posterPath) for an id we have already seen in a list. */
    private fun knownMetadata(
        mediaId: String,
        kind: String,
        serverId: String,
    ): Triple<String, String?, String?> {
        known[mediaId]?.let { return Triple(it.title, it.subtitle, it.posterPath) }
        if (kind == "movie") {
            movies.firstOrNull { it.id == serverId }?.let {
                return Triple(it.title, it.year?.toString(), it.poster)
            }
        } else {
            episodesByShow.values.forEach { list ->
                list.firstOrNull { it.id == serverId }?.let { ep ->
                    return Triple(ep.title, null, null)
                }
            }
        }
        return Triple("Beebo Entertainment", null, null)
    }

    /**
     * What tapping a music row plays: the song plus the rest of its album, a whole album or
     * artist, or the library shuffled. Null for anything that is not music, which the caller
     * plays one item at a time as before.
     */
    suspend fun musicQueueFor(mediaId: String): Pair<List<MediaItem>, Int>? =
        if (MusicIds.isMusic(mediaId)) music.queueFor(mediaId) else null

    fun kindOf(mediaId: String): String =
        MediaIds.parsePlayable(mediaId)?.first ?: "movie"

    fun serverIdOf(mediaId: String): String? = MediaIds.parsePlayable(mediaId)?.second

    // ---------------------------------------------------------------- helpers

    private fun remember(
        mediaId: String,
        streamPath: String,
        title: String,
        subtitle: String?,
        posterPath: String?,
    ) {
        if (streamPath.isBlank()) return
        known[mediaId] = Known(
            streamPath = streamPath,
            fetchedAt = SystemClock.elapsedRealtime(),
            title = title,
            subtitle = subtitle,
            posterPath = posterPath,
        )
    }

    private fun freshStreamPath(mediaId: String): String? {
        val k = known[mediaId] ?: return null
        if (SystemClock.elapsedRealtime() - k.fetchedAt > STREAM_TTL_MS) return null
        return k.streamPath
    }

    private fun fresh(at: Long, ttl: Long = LIST_TTL_MS): Boolean =
        at != 0L && SystemClock.elapsedRealtime() - at < ttl

    /** True when a cache entry answers this call, forced refresh included. */
    private fun usable(at: Long, force: Boolean, startedAt: Long): Boolean =
        if (force) at >= startedAt else fresh(at)

    private fun movieItem(m: MovieItem): MediaItem = playable(
        mediaId = MediaIds.movie(m.id),
        title = m.title,
        subtitle = listOfNotNull(m.year?.toString(), qualityLabel(m.quality))
            .joinToString(" · ").ifBlank { null },
        posterPath = m.poster,
    )

    private fun episodeItem(e: EpisodeItem): MediaItem = playable(
        mediaId = MediaIds.episode(e.id),
        title = e.title,
        subtitle = qualityLabel(e.quality),
        posterPath = null,
    )

    private fun showFolder(s: ShowItem): MediaItem = browsable(
        id = MediaIds.show(s.key),
        title = s.name,
        subtitle = "${s.episodeCount} episode${if (s.episodeCount == 1) "" else "s"}",
        posterPath = s.poster,
        style = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
    )

    private fun browsable(
        id: String,
        title: String,
        subtitle: String? = null,
        posterPath: String? = null,
        style: Int? = null,
    ): MediaItem {
        val extras = Bundle().apply {
            style?.let { putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, it) }
            putInt(
                MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE,
                MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
            )
        }
        return MediaItem.Builder()
            .setMediaId(id)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setArtworkUri(ArtworkUris.forServerPath(posterPath))
                    .setIsBrowsable(true)
                    .setIsPlayable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                    .setExtras(extras)
                    .build()
            )
            .build()
    }

    private fun playable(
        mediaId: String,
        title: String,
        subtitle: String?,
        posterPath: String?,
        extras: Bundle? = null,
    ): MediaItem = MediaItem.Builder()
        .setMediaId(mediaId)
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(title)
                // Deliberately NOT setDisplayTitle: when displayTitle is set the
                // legacy bridge Android Auto uses ignores artist entirely.
                .setArtist(subtitle)
                .setArtworkUri(ArtworkUris.forServerPath(posterPath))
                .setIsBrowsable(false)
                .setIsPlayable(true)
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                .apply { extras?.let { setExtras(it) } }
                .build()
        )
        .build()

    private fun progressLabel(h: HistoryItem): String? {
        if (h.duration <= 0) return null
        val left = ((h.duration - h.currentTime) / 60.0).toInt()
        return if (left > 0) "$left min left · ${h.percent}%" else "${h.percent}%"
    }

    /** The server sends the tier key; the badge label is the client's job. */
    private fun qualityLabel(tier: String?): String? = when (tier) {
        "2160p" -> "4K"
        "1080p" -> "1080p"
        "720p" -> "720p"
        "480p" -> "SD"
        else -> null
    }

    private fun bucketOf(title: String): String {
        val c = title.trim().firstOrNull()?.uppercaseChar() ?: return "#"
        return if (c in 'A'..'Z') c.toString() else "#"
    }

    private fun lettersOf(titles: List<String>): List<String> =
        titles.map { bucketOf(it) }.distinct().sortedWith(
            compareBy({ it == "#" }, { it })
        )

    companion object {
        private const val LIST_TTL_MS = 10 * 60 * 1000L
        private const val STREAM_TTL_MS = 60 * 60 * 1000L   // mt token lives 12h
        private const val SURPRISE_TTL_MS = 30 * 60 * 1000L
        private const val SURPRISE_RETRY_MS = 30 * 1000L
        private const val SURPRISE_COUNT = 10
        private const val SEARCH_MOVIES = 50
        private const val SEARCH_SHOWS = 25

        /**
         * A MediaItem parcels at roughly 500-800 bytes once the UTF-16 strings,
         * the content:// artwork URI and the injected extras are counted, and
         * the whole result crosses in one ~1MB binder transaction. 200 leaves
         * real headroom; 500 did not.
         */
        private const val MAX_FLAT = 200
        const val DEFAULT_ROOT_LIMIT = 4
        /** Every root tab: Continue, Music, Movies, TV Shows, Playlists, Surprise Me. */
        const val ROOT_TABS = 6
        /** Surprise Me is last, so it sits at the root only on a host that shows them all. */
        const val ROOT_TABS_WITH_SURPRISE = 6
        /** Below this, Playlists doesn't fit at the root either and moves inside Movies. */
        const val ROOT_TABS_WITH_PLAYLISTS = 5
    }
}
