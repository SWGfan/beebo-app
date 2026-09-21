package com.beeboentertainment.movie.data

import kotlinx.serialization.Serializable

/*
 * DTOs for the Collections screens (GET /api/collections, /api/collections/<id>) and
 * "Request a title" (/api/title-search, /api/title-requests). Every field defaults, like the
 * rest of Models.kt, so an older or newer server never crashes the parse.
 *
 * Posters: `poster` is server-relative (a cached image) or null; `tmdbPoster` is an absolute
 * TMDB CDN URL for things the server has no image of - typically a film you don't own.
 * UrlUtils.join passes an absolute URL straight through, so `join(base, poster ?: tmdbPoster)`
 * works for both.
 */

@Serializable
data class CollectionSummary(
    val id: Int = 0,
    val name: String = "",
    /** "Toy Story Collection" even when TMDB calls it "Toy Story". */
    val displayName: String = "",
    val poster: String? = null,
    val tmdbPoster: String? = null,
    val ownedCount: Int = 0,
    val total: Int = 0,
    val complete: Boolean = false,
    val firstYear: Int? = null,
    val lastYear: Int? = null
)

@Serializable
data class CollectionsResponse(
    val ok: Boolean = false,
    val items: List<CollectionSummary> = emptyList(),
    /** Library films nobody has checked for a collection yet. */
    val unchecked: Int = 0,
    /** The server is looking some of those up right now; a later visit will show more. */
    val refreshing: Boolean = false,
    val error: String? = null
)

/** A request already filed for a title, as the search results and collection parts report it. */
@Serializable
data class RequestRef(
    val id: String = "",
    /** requested | added | dismissed */
    val status: String = "requested",
    /** This signed-in person is one of the requesters. */
    val mine: Boolean = false
)

@Serializable
data class CollectionPart(
    val tmdbId: Int = 0,
    val title: String = "",
    val year: Int? = null,
    val releaseDate: String? = null,
    val owned: Boolean = false,
    val poster: String? = null,
    val tmdbPoster: String? = null,
    /** The /api/movies item for an owned film - what plays. Null when not owned. */
    val movie: Movie? = null,
    val request: RequestRef? = null
)

@Serializable
data class CollectionDetail(
    val id: Int = 0,
    val name: String = "",
    val displayName: String = "",
    val ownedCount: Int = 0,
    val total: Int = 0,
    val complete: Boolean = false,
    /** Release order, oldest first, undated last - the server's order, never re-sorted. */
    val parts: List<CollectionPart> = emptyList()
)

@Serializable
data class CollectionDetailResponse(
    val ok: Boolean = false,
    val collection: CollectionDetail? = null,
    val error: String? = null
)

@Serializable
data class TitleSearchResult(
    /** movie | tv */
    val kind: String = "movie",
    val tmdbId: Int = 0,
    val title: String = "",
    val year: Int? = null,
    val overview: String? = null,
    val tmdbPoster: String? = null,
    val inLibrary: Boolean = false,
    val request: RequestRef? = null
)

@Serializable
data class TitleSearchResponse(
    val ok: Boolean = false,
    val items: List<TitleSearchResult> = emptyList(),
    val error: String? = null
)

@Serializable
data class TitleRequestCreate(
    val kind: String,
    val tmdbId: Int? = null,
    val title: String,
    val year: Int? = null,
    val note: String? = null,
    val poster: String? = null
)

@Serializable
data class TitleRequester(
    val name: String = "",
    val note: String? = null,
    val at: Long? = null
)

@Serializable
data class TitleRequest(
    val id: String = "",
    val kind: String = "movie",
    val title: String = "",
    val showName: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val year: Int? = null,
    val tmdbId: Int? = null,
    val poster: String? = null,
    /** request (asked for from the app) | upnext (the player found the next part missing) */
    val source: String = "request",
    /** requested | added | dismissed */
    val status: String = "requested",
    val requestedAt: Long? = null,
    val addedAt: Long? = null,
    val mine: Boolean = false,
    /** Your own note. Other people's notes only reach the owner, in [requesters]. */
    val note: String? = null,
    val requesters: List<TitleRequester> = emptyList(),
    val requesterCount: Int = 0
)

@Serializable
data class TitleRequestsResponse(
    val ok: Boolean = false,
    /** True for the owner (an admin): the only account that may dismiss. */
    val canDismiss: Boolean = false,
    val items: List<TitleRequest> = emptyList(),
    val error: String? = null
)

@Serializable
data class TitleRequestResult(
    val ok: Boolean = false,
    val created: Boolean = false,
    val deduped: Boolean = false,
    val appended: Boolean = false,
    val request: TitleRequest? = null,
    val error: String? = null,
    val retryAfterSeconds: Int? = null
)

@Serializable
data class TitleRequestIdBody(val id: String)
