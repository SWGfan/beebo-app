package com.beeboentertainment.movie.player

import android.util.Log
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.CatalogCache
import com.beeboentertainment.movie.data.UpNextItem

/**
 * Turns the bare `videoId` a watch-party host broadcasts into something this
 * device is actually allowed to play.
 *
 * ## Why a resolver at all
 *
 * The room protocol carries an IDENTITY, never a location: a `load`/`sync`
 * envelope holds the host's media id and nothing else. That is deliberate. The
 * room socket is a relay — whatever one device puts in, the others get — so a
 * path or a URL taken off it would be an instruction from another device about
 * which bytes to open. Two things would be wrong with that at once: the viewer
 * would be reading a location it never authorised, and the stream URLs this
 * server hands out carry a per-item media token (`mt=`) that a client cannot
 * mint anyway, so a relayed URL would either be someone else's token or a
 * forgery attempt.
 *
 * So the id is treated as untrusted input and resolved the long way round:
 *
 *  1. [isSafeItemId] rejects anything that is not the server's own id shape.
 *     The host falls back to the stream URI when an item has no id
 *     (`MediaItem.mediaId = itemId.ifBlank { uriString }`), so a URL really can
 *     arrive here — and it is dropped rather than opened.
 *  2. The id is looked up through THIS device's authenticated [ApiClient],
 *     against ITS OWN server and ITS OWN token. The playable stream path comes
 *     back from the server, freshly signed for this viewer. An id that the
 *     viewer's account cannot see simply does not come back, and nothing plays.
 *
 * The net effect: the host can only ever ask "do you have this?", never "open
 * that". The viewer's own server answers.
 *
 * ## How the lookup works
 *
 * There is no single "give me item X" endpoint, so the two existing catalogue
 * routes are used, TV first because it is the cheap pair of small responses:
 *
 *  - TV: `/api/episode-context` maps an episode id to its showKey (it answers
 *    404 for anything that is not a TV episode), then
 *    `/api/tvshows/<showKey>/episodes` yields that episode's signed `stream`.
 *  - Movie: `/api/movies` — the unfiltered catalogue — is searched for the id.
 *    [CatalogCache] is consulted first so an already-browsed library resolves
 *    with no network call at all.
 *
 * The result is shaped as an [UpNextItem] purely so it can be handed to the
 * existing [MediaItemFactory.forUpNextItem]; nothing new builds MediaItems.
 */
object PartyVideoResolver {

    private const val TAG = "PartyVideoResolver"

    /** Server ids are base64url of a file name, so they never exceed this in practice. */
    private const val MAX_ID_LENGTH = 512

    /**
     * True when [raw] has the shape of a server-issued item id and nothing else.
     *
     * Server ids are base64url (see the desktop server's encodeId), i.e. only
     * `A-Z a-z 0-9 - _`, with padding tolerated. Everything a location would
     * need — a scheme, a slash, a backslash, a dot-dot — is therefore absent by
     * construction, and anything carrying one is refused here rather than being
     * sanitised into something that looks acceptable.
     */
    fun isSafeItemId(raw: String?): Boolean {
        val id = raw?.trim().orEmpty()
        if (id.isEmpty() || id.length > MAX_ID_LENGTH) return false
        return id.all { c ->
            (c in 'A'..'Z') || (c in 'a'..'z') || (c in '0'..'9') || c == '-' || c == '_' || c == '='
        }
    }

    /**
     * Resolve [videoId] to a playable item, or null when this account's server
     * does not offer it (unknown id, removed title, no library access, or the
     * lookup failed). Suspends; safe to call from a UI scope.
     *
     * Never throws: every failure mode is "we cannot play this", which the
     * caller reports to the user rather than crashing the player.
     */
    suspend fun resolve(api: ApiClient, videoId: String): UpNextItem? {
        val id = videoId.trim()
        if (!isSafeItemId(id)) {
            // A URL or path off the room socket lands here. Do not log the value.
            Log.w(TAG, "refusing a party video id that is not a server item id")
            return null
        }
        return resolveEpisode(api, id) ?: resolveMovie(api, id)
    }

    /** TV: episode id -> showKey -> the episode row, which carries the signed stream path. */
    private suspend fun resolveEpisode(api: ApiClient, id: String): UpNextItem? {
        val showKey = (
            try {
                api.episodeContext(id).takeIf { it.ok }?.showKey?.takeIf { it.isNotBlank() }
            } catch (t: Throwable) {
                // 404/400 is the normal answer for a movie id; anything else is a
                // network problem that the movie branch will hit again anyway.
                null
            }
            ) ?: return null

        val episodes = try {
            api.episodes(showKey)
        } catch (t: Throwable) {
            Log.w(TAG, "episode lookup failed for a party load: ${t.javaClass.simpleName}")
            return null
        }
        if (!episodes.ok) return null

        val episode = episodes.seasons
            .asSequence()
            .flatMap { it.episodes.asSequence() }
            .firstOrNull { it.id == id }
            ?: return null
        if (episode.stream.isNullOrBlank()) return null

        val show = episodes.show
        return UpNextItem(
            kind = "tv",
            id = episode.id,
            showKey = showKey,
            title = episode.title.ifBlank { show?.name.orEmpty() },
            poster = show?.poster,
            stream = episode.stream
        )
    }

    /** Movie: search the account's own catalogue for the id and take its signed stream path. */
    private suspend fun resolveMovie(api: ApiClient, id: String): UpNextItem? {
        // The unfiltered list is what the Movies tab already caches, so a library
        // that has been browsed this session resolves without touching the network.
        CatalogCache.movies(null)?.items?.firstOrNull { it.id == id }?.let { return movieItem(it) }

        val movies = try {
            api.movies()
        } catch (t: Throwable) {
            Log.w(TAG, "movie lookup failed for a party load: ${t.javaClass.simpleName}")
            return null
        }
        if (!movies.ok) return null
        CatalogCache.putMovies(null, movies)
        return movies.items.firstOrNull { it.id == id }?.let { movieItem(it) }
    }

    private fun movieItem(movie: com.beeboentertainment.movie.data.Movie): UpNextItem? {
        if (movie.stream.isNullOrBlank()) return null
        return UpNextItem(
            kind = "movie",
            id = movie.id,
            showKey = null,
            title = movie.title,
            poster = movie.poster,
            stream = movie.stream
        )
    }
}
