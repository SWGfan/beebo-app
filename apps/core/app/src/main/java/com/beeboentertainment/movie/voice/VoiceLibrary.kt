package com.beeboentertainment.movie.voice

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.core.VoiceSearch
import com.beeboentertainment.movie.data.Movie
import com.beeboentertainment.movie.data.TvShow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The library side of voice search: fetches the film and show lists from the home computer
 * (cached for a few minutes, since Assistant, TV search and the car can ask several times a
 * second while someone is still speaking) and turns a [VoiceSearch.Query] into something the
 * player can start.
 */
object VoiceLibrary {

    data class PlayTarget(
        val itemId: String,
        val kind: String,
        val title: String,
        val streamUrl: String,
        val posterUrl: String?,
        val showKey: String? = null
    )

    private const val TTL_MS = 5 * 60 * 1000L
    private val lock = Mutex()
    @Volatile private var movies: List<Movie> = emptyList()
    @Volatile private var shows: List<TvShow> = emptyList()
    @Volatile private var fetchedAt = 0L

    private suspend fun lists(): Pair<List<Movie>, List<TvShow>> = lock.withLock {
        val now = System.currentTimeMillis()
        if (fetchedAt == 0L || now - fetchedAt > TTL_MS) {
            val api = BeeboApp.instance.api
            val m = runCatching { api.movies(sort = "title").items }.getOrNull()
            val s = runCatching { api.tvShows().items }.getOrNull()
            if (m != null) movies = m
            if (s != null) shows = s
            if (m != null || s != null) fetchedAt = now
        }
        movies to shows
    }

    fun candidates(movies: List<Movie>, shows: List<TvShow>): List<VoiceSearch.Candidate> =
        movies.map { VoiceSearch.Candidate(it.id, it.title, VoiceSearch.Focus.MOVIE, it.year) } +
            shows.map { VoiceSearch.Candidate(it.key, it.name, VoiceSearch.Focus.SHOW, it.year) }

    /** Titles for TV global search and the car's search list, best first. */
    suspend fun search(text: String, limit: Int = 10): List<Pair<VoiceSearch.Candidate, Movie?>> {
        val q = VoiceSearch.parse(text)
        if (q.title.isBlank()) return emptyList()
        val (m, s) = lists()
        val byId = m.associateBy { it.id }
        return candidates(m, s)
            .filter { runCatching { VoiceSearch.contentFilter(it) }.getOrDefault(false) }
            .map { it to VoiceSearch.similarity(q.title, it.title) }
            .filter { it.second >= 0.5 }
            .sortedByDescending { it.second }
            .take(limit)
            .map { it.first to byId[it.first.id] }
    }

    fun showPoster(key: String): String? = shows.firstOrNull { it.key == key }?.poster

    /** The library title a spoken request means, or null. */
    suspend fun match(query: VoiceSearch.Query): VoiceSearch.Candidate? {
        if (!BeeboApp.instance.session.isLoggedIn) return null
        val (m, s) = lists()
        return VoiceSearch.bestMatch(query, candidates(m, s))?.candidate
    }

    /** What to play for a spoken request, or null (not signed in, nothing close enough). */
    suspend fun resolve(query: VoiceSearch.Query): PlayTarget? {
        val app = BeeboApp.instance
        if (!app.session.isLoggedIn) return null
        if (query.resume) return resumeLatest()
        val (m, s) = lists()
        val match = VoiceSearch.bestMatch(query, candidates(m, s)) ?: return null
        return when (match.candidate.kind) {
            VoiceSearch.Focus.SHOW -> episodeOf(match.candidate.id, match.candidate.title, query.season, query.episode)
            else -> m.firstOrNull { it.id == match.candidate.id }?.let { movie ->
                val url = UrlUtils.join(app.session.baseUrl, movie.stream) ?: return null
                PlayTarget(movie.id, "movie", movie.title, url, UrlUtils.join(app.session.baseUrl, movie.poster))
            }
        }
    }

    /** A title picked from TV search or the Watch Next row: kind + server id (a show key for a show). */
    suspend fun resolveId(kind: String, id: String): PlayTarget? {
        val app = BeeboApp.instance
        if (!app.session.isLoggedIn || id.isBlank()) return null
        return when (kind) {
            "show" -> episodeOf(id, shows.firstOrNull { it.key == id }?.name ?: "", null, null)
            "tv" -> {
                // An episode id: ask the server which show it is in, then take that exact file.
                val showKey = runCatching { app.api.episodeContext(id) }.getOrNull()?.takeIf { it.ok }?.showKey ?: return null
                val eps = runCatching { app.api.episodes(showKey) }.getOrNull() ?: return null
                val ep = eps.seasons.flatMap { it.episodes }.firstOrNull { it.id == id } ?: return null
                val url = UrlUtils.join(app.session.baseUrl, ep.stream) ?: return null
                PlayTarget(ep.id, "tv", ep.title, url, UrlUtils.join(app.session.baseUrl, eps.show?.poster), showKey)
            }
            else -> {
                val (m, _) = lists()
                val movie = m.firstOrNull { it.id == id } ?: return null
                val url = UrlUtils.join(app.session.baseUrl, movie.stream) ?: return null
                PlayTarget(movie.id, "movie", movie.title, url, UrlUtils.join(app.session.baseUrl, movie.poster))
            }
        }
    }

    private suspend fun episodeOf(showKey: String, showName: String, season: Int?, episode: Int?): PlayTarget? {
        val app = BeeboApp.instance
        val eps = runCatching { app.api.episodes(showKey) }.getOrNull() ?: return null
        val flat = eps.seasons.flatMap { it.episodes }
        val refs = flat.map { VoiceSearch.EpisodeRef(it.id, it.season, it.episode, it.watchedPercent, it.watchedAt) }
        val pick = VoiceSearch.pickEpisode(refs, season, episode) ?: return null
        val ep = flat.first { it.id == pick.id }
        val url = UrlUtils.join(app.session.baseUrl, ep.stream) ?: return null
        val title = listOfNotNull(
            (eps.show?.name ?: showName).takeIf { it.isNotBlank() },
            if (ep.season != null && ep.episode != null) "S${ep.season}E${ep.episode}" else null
        ).joinToString(" — ").ifBlank { ep.title }
        return PlayTarget(ep.id, "tv", title, url, UrlUtils.join(app.session.baseUrl, eps.show?.poster), showKey)
    }

    /** "Hey Google, play Beebo": carry on with the newest Continue Watching item. */
    private suspend fun resumeLatest(): PlayTarget? {
        val app = BeeboApp.instance
        val item = runCatching { app.api.continueWatching().items }.getOrNull()?.firstOrNull { it.stream != null } ?: return null
        val url = UrlUtils.join(app.session.baseUrl, item.stream) ?: return null
        return PlayTarget(item.id, item.kind, item.title, url, UrlUtils.join(app.session.baseUrl, item.poster))
    }
}
