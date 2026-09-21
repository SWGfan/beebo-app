package com.beeboentertainment.movie.data

import java.util.concurrent.ConcurrentHashMap

/**
 * Tiny in-memory cache of the last successful catalog responses, keyed by genre filter.
 *
 * Why: the Movies and TV screens are plain composables whose state is thrown away when you leave
 * the tab, so every visit used to re-fetch from the server and show a spinner first. With this,
 * the screen paints the last list instantly and refreshes in the background — tabs feel instant.
 *
 * Process-lifetime only: it clears itself on cold start (it's just memory) and on sign-out
 * ([clear]), so it never leaks one account's catalog into another's session.
 */
object CatalogCache {
    /**
     * How long a cached response counts as fresh. The Movies and TV tabs skip the network
     * entirely while the last response is younger than this, so bouncing between tabs does
     * not re-download and re-parse the whole library each time. An explicit Retry, and
     * anything older than this, still goes to the server.
     */
    const val FRESH_MS = 2 * 60 * 1000L

    private val movies = ConcurrentHashMap<Int, MoviesResponse>()
    private val moviesAt = ConcurrentHashMap<Int, Long>()
    private val tv = ConcurrentHashMap<Int, TvShowsResponse>()
    private val tvAt = ConcurrentHashMap<Int, Long>()

    private fun key(genre: Int?) = genre ?: 0

    private fun fresh(at: Long?): Boolean =
        at != null && System.currentTimeMillis() - at < FRESH_MS

    fun movies(genre: Int?): MoviesResponse? = movies[key(genre)]
    fun putMovies(genre: Int?, r: MoviesResponse) {
        if (r.ok) { movies[key(genre)] = r; moviesAt[key(genre)] = System.currentTimeMillis() }
    }
    /** True when there is a cached movie list for this genre younger than [FRESH_MS]. */
    fun moviesFresh(genre: Int?): Boolean = movies.containsKey(key(genre)) && fresh(moviesAt[key(genre)])

    fun tvShows(genre: Int?): TvShowsResponse? = tv[key(genre)]
    fun putTvShows(genre: Int?, r: TvShowsResponse) {
        if (r.ok) { tv[key(genre)] = r; tvAt[key(genre)] = System.currentTimeMillis() }
    }
    /** True when there is a cached TV list for this genre younger than [FRESH_MS]. */
    fun tvShowsFresh(genre: Int?): Boolean = tv.containsKey(key(genre)) && fresh(tvAt[key(genre)])

    fun clear() {
        movies.clear()
        moviesAt.clear()
        tv.clear()
        tvAt.clear()
    }
}

/**
 * Disk-persisted cache of the Continue Watching list — the app's landing screen. Persisting it means
 * a cold start paints your "jump back in" row instantly from last time, then refreshes, instead of
 * showing a spinner while the first network call runs.
 */
object ContinueCache {
    private const val KEY = "continue_cache_v1"

    @Volatile private var mem: ContinueResponse? = null

    fun get(prefs: android.content.SharedPreferences): ContinueResponse? {
        mem?.let { return it }
        val raw = prefs.getString(KEY, null) ?: return null
        return runCatching { ApiClient.JSON.decodeFromString(ContinueResponse.serializer(), raw) }
            .getOrNull()?.also { mem = it }
    }

    fun put(prefs: android.content.SharedPreferences, r: ContinueResponse) {
        if (!r.ok) return
        mem = r
        runCatching {
            prefs.edit()
                .putString(KEY, ApiClient.JSON.encodeToString(ContinueResponse.serializer(), r))
                .apply()
        }
    }

    /**
     * Drop one row from the cached list.
     *
     * Marking something watched deletes its history row on the server, so the next /api/continue
     * legitimately will not include it - but until that call happens this persisted cache is what
     * the Library tab paints from on a cold start, and a row that is gone on the server yet still
     * on screen is worse than never offering the button. Correcting the cache in the same breath
     * as the successful POST is what keeps the two honest.
     *
     * A no-op when the id is not in the cache, so callers never have to check first.
     */
    fun removeItem(prefs: android.content.SharedPreferences, id: String) {
        if (id.isBlank()) return
        val current = get(prefs) ?: return
        val kept = current.items.filter { it.id != id }
        if (kept.size == current.items.size) return
        put(prefs, current.copy(items = kept))
    }

    fun clear(prefs: android.content.SharedPreferences) {
        mem = null
        runCatching { prefs.edit().remove(KEY).apply() }
    }
}

/**
 * In-memory cache of the two home discovery shelves, for the same reason [CatalogCache] exists:
 * the Movies tab paints its grid instantly from cache, and a shelf that popped in a second later
 * would shove that grid down under the reader's thumb just as they went to tap something.
 *
 * Process-lifetime only, and cleared on sign-out alongside the catalog, so one account's
 * "because you watched" never greets the next person to sign in on this phone.
 */
object ShelfCache {
    @Volatile private var recentlyAdded: ShelfResponse? = null
    @Volatile private var recommended: ShelfResponse? = null
    /** When both shelves were last fetched; 0 until they have been. */
    @Volatile private var fetchedAt = 0L

    fun recentlyAdded(): ShelfResponse? = recentlyAdded
    fun putRecentlyAdded(r: ShelfResponse) { if (r.ok) recentlyAdded = r }

    fun recommended(): ShelfResponse? = recommended
    fun putRecommended(r: ShelfResponse) { if (r.ok) recommended = r }

    /** Called once both shelf requests have completed, so the pair ages together. */
    fun markFetched() { fetchedAt = System.currentTimeMillis() }

    /** True while the last shelf fetch is younger than [CatalogCache.FRESH_MS]. */
    fun fresh(): Boolean = fetchedAt != 0L && System.currentTimeMillis() - fetchedAt < CatalogCache.FRESH_MS

    fun clear() {
        recentlyAdded = null
        recommended = null
        fetchedAt = 0L
    }
}
