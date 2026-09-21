package com.beeboentertainment.movie.data

import kotlinx.serialization.Serializable

/*
 * DTOs for the actor page's extras: "Not in your library" (GET /api/actor/<id>/missing),
 * trailers (GET /api/trailer) and the owner's look-it-up sites (GET /api/search-sites).
 * Every field defaults, like the rest of the models, so an older server never crashes a parse.
 */

@Serializable
data class PersonRef(
    val id: Int = 0,
    val name: String? = null
)

/** A title this person is in that the library doesn't have. `poster` is an absolute TMDB URL or null. */
@Serializable
data class MissingTitle(
    val tmdbId: Int = 0,
    /** "movie" or "tv" */
    val kind: String = "movie",
    val title: String = "",
    val year: Int? = null,
    val poster: String? = null,
    val voteCount: Int = 0,
    val character: String? = null,
    val overview: String? = null,
    val request: RequestRef? = null
)

@Serializable
data class ActorMissingResponse(
    val ok: Boolean = false,
    val person: PersonRef? = null,
    val items: List<MissingTitle> = emptyList(),
    /** Why there is nothing to show (no_api_key, tmdb_unreachable, ...). Informational only. */
    val reason: String? = null,
    val error: String? = null
)

@Serializable
data class TrailerResponse(
    val ok: Boolean = false,
    /** YouTube video id, or null when there is no trailer. */
    val youtubeKey: String? = null,
    val name: String? = null,
    val reason: String? = null
)

/** One search site: `urlTemplate` contains `{query}`. */
@Serializable
data class SearchSite(
    /** imdb | tmdb | google | bing | duckduckgo | custom */
    val engine: String = "google",
    val name: String = "Google",
    val urlTemplate: String = "",
    /** Built-in engines search "title year"; custom sites search the title alone. */
    val appendYear: Boolean = true
)

@Serializable
data class SearchSitesResponse(
    val ok: Boolean = false,
    val movies: SearchSite? = null,
    val tv: SearchSite? = null,
    val google: SearchSite? = null
)
