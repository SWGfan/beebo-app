package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.RequestRef
import com.beeboentertainment.movie.data.TitleRequest
import com.beeboentertainment.movie.data.TitleRequestCreate
import com.beeboentertainment.movie.data.TitleSearchResult

/**
 * The decisions behind "Request a title", out of Compose so they run on the JVM.
 *
 * The server is the authority on dedupe, library matching, permissions and rate limits; this
 * only decides what to show and what to send, and keeps the on-screen lists in step after a
 * successful call so nothing needs a reload.
 */
object TitleRequestLogic {

    /** Matches the server's cap; longer notes are trimmed there anyway. */
    const val NOTE_MAX = 280
    const val MIN_QUERY = 2

    enum class Kind(val param: String?, val label: String) { ALL(null, "Everything"), MOVIE("movie", "Movies"), TV("tv", "TV shows") }

    /** What a search result row offers. */
    enum class ResultAction { REQUEST, JOIN, REQUESTED_BY_YOU, IN_LIBRARY, DISMISSED, ADDED }

    fun canSearch(query: String): Boolean = query.trim().length >= MIN_QUERY

    fun resultAction(r: TitleSearchResult): ResultAction {
        if (r.inLibrary) return ResultAction.IN_LIBRARY
        val req = r.request ?: return ResultAction.REQUEST
        return when (req.status) {
            "dismissed" -> ResultAction.DISMISSED
            "added" -> ResultAction.ADDED
            else -> if (req.mine) ResultAction.REQUESTED_BY_YOU else ResultAction.JOIN
        }
    }

    fun resultButtonLabel(action: ResultAction): String = when (action) {
        ResultAction.REQUEST -> "Request"
        ResultAction.JOIN -> "Me too"
        ResultAction.REQUESTED_BY_YOU -> "Requested"
        ResultAction.IN_LIBRARY -> "In library"
        ResultAction.DISMISSED -> "Declined"
        ResultAction.ADDED -> "Added"
    }

    fun isActionable(action: ResultAction): Boolean = action == ResultAction.REQUEST || action == ResultAction.JOIN

    fun resultSubtitle(r: TitleSearchResult): String =
        listOfNotNull(if (r.kind == "tv") "TV show" else "Film", r.year?.toString()).joinToString(" · ")

    fun statusLabel(status: String): String = when (status) {
        "added" -> "Added"
        "dismissed" -> "Declined"
        else -> "Requested"
    }

    /** Trimmed to the cap as the person types, so the counter can never go negative. */
    fun clampNote(note: String): String = if (note.length > NOTE_MAX) note.take(NOTE_MAX) else note

    fun noteCounter(note: String): String = "${note.length} / $NOTE_MAX"

    fun buildCreate(kind: String, tmdbId: Int?, title: String, year: Int?, note: String, poster: String?): TitleRequestCreate =
        TitleRequestCreate(
            kind = if (kind == "tv") "tv" else "movie",
            tmdbId = tmdbId?.takeIf { it > 0 },
            title = title.trim(),
            year = year,
            note = note.trim().replace(Regex("\\s+"), " ").take(NOTE_MAX).ifBlank { null },
            poster = poster?.takeIf { it.startsWith("https://image.tmdb.org/") }
        )

    fun create(result: TitleSearchResult, note: String): TitleRequestCreate =
        buildCreate(result.kind, result.tmdbId, result.title, result.year, note, result.tmdbPoster)

    /** The confirmation line after a successful request. */
    fun successMessage(title: String, created: Boolean, deduped: Boolean, appended: Boolean): String = when {
        deduped -> "You've already asked for $title."
        appended -> "Added your name to the request for $title."
        created -> "Requested $title. You'll see it here once it's added."
        else -> "Requested $title."
    }

    /** Search results after a request went through: the row turns into "Requested". */
    fun markResultRequested(results: List<TitleSearchResult>, kind: String, tmdbId: Int, request: TitleRequest?): List<TitleSearchResult> =
        results.map {
            if (it.kind == kind && it.tmdbId == tmdbId) {
                it.copy(request = RequestRef(request?.id.orEmpty(), request?.status ?: "requested", mine = true))
            } else it
        }

    /** Put a fresh or updated request at the top of "My requests", replacing any older copy. */
    fun upsert(list: List<TitleRequest>, request: TitleRequest?): List<TitleRequest> {
        if (request == null || request.id.isBlank()) return list
        return listOf(request) + list.filterNot { it.id == request.id }
    }

    /** Dismiss is offered only to the owner, and only on something still open. */
    fun canDismiss(ownerCanDismiss: Boolean, request: TitleRequest): Boolean =
        ownerCanDismiss && request.status == "requested"

    /** "Requested by Mia, Sam" - the owner's view only; members get an empty list from the server. */
    fun requestersLine(request: TitleRequest): String? {
        val names = request.requesters.map { it.name }.filter { it.isNotBlank() }
        return if (names.isEmpty()) null else "Asked for by " + names.joinToString(", ")
    }

    fun requestSubtitle(request: TitleRequest): String {
        val what = when {
            request.kind == "tv" && request.season != null && request.episode != null ->
                "Season ${request.season}, episode ${request.episode}"
            request.kind == "tv" -> "TV show"
            else -> "Film"
        }
        return listOfNotNull(what, request.year?.toString()).joinToString(" · ")
    }

    /** Open requests first, then added, then declined; newest first within each. */
    fun sorted(list: List<TitleRequest>): List<TitleRequest> =
        list.sortedWith(
            compareBy<TitleRequest> { when (it.status) { "requested" -> 0; "added" -> 1; else -> 2 } }
                .thenByDescending { it.requestedAt ?: 0L }
        )
}
