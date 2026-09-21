package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.CollectionDetail
import com.beeboentertainment.movie.data.CollectionPart
import com.beeboentertainment.movie.data.CollectionSummary

/**
 * Everything the Collections grid and a franchise's page decide, kept out of Compose so it can
 * be tested on the JVM. The server owns the order (release order) and the counts; nothing here
 * re-sorts parts or recounts ownership.
 */
object CollectionsLogic {

    /** The grid's filter chips. */
    enum class Filter(val label: String) { ALL("All"), INCOMPLETE("Missing films"), COMPLETE("Complete") }

    /** What a tile on a franchise's page does when chosen. */
    enum class PartAction {
        /** Owned: play it. */
        PLAY,
        /** Not owned and nobody has asked: offer "Request". */
        REQUEST,
        /** Not owned, already requested by you. */
        REQUESTED_BY_YOU,
        /** Not owned, requested by someone else in the household: you can add your name. */
        REQUESTED_BY_OTHERS,
        /** The owner said no. Shown, not actionable. */
        DISMISSED,
        /** Marked found, but no file matched yet - usually it's still being copied in. */
        ADDED
    }

    fun filter(items: List<CollectionSummary>, filter: Filter, query: String = ""): List<CollectionSummary> {
        val q = query.trim()
        return items.filter {
            when (filter) {
                Filter.ALL -> true
                Filter.INCOMPLETE -> !it.complete
                Filter.COMPLETE -> it.complete
            }
        }.filter { q.isEmpty() || title(it).contains(q, ignoreCase = true) }
    }

    fun title(c: CollectionSummary): String = c.displayName.ifBlank { c.name.ifBlank { "Collection" } }

    fun title(c: CollectionDetail): String = c.displayName.ifBlank { c.name.ifBlank { "Collection" } }

    /** "You have all 3" / "2 of 4". */
    fun progressLabel(owned: Int, total: Int): String = when {
        total <= 0 -> ""
        owned >= total -> if (total == 1) "You have it" else "You have all $total"
        else -> "$owned of $total"
    }

    /** "1979-1992", "1995", or null when TMDB gave no dates. */
    fun yearsLabel(first: Int?, last: Int?): String? = when {
        first == null && last == null -> null
        first == null || last == null || first == last -> (first ?: last).toString()
        else -> "$first–$last"
    }

    fun subtitle(c: CollectionSummary): String =
        listOfNotNull(progressLabel(c.ownedCount, c.total).ifBlank { null }, yearsLabel(c.firstYear, c.lastYear))
            .joinToString(" · ")

    /** The page heading's second line. */
    fun detailSummary(c: CollectionDetail): String {
        val missing = (c.total - c.ownedCount).coerceAtLeast(0)
        return when {
            c.total == 0 -> "Nothing listed for this collection yet."
            missing == 0 -> "${progressLabel(c.ownedCount, c.total)} — complete"
            c.ownedCount == 0 -> "None of the ${c.total} films are in your library"
            else -> "${progressLabel(c.ownedCount, c.total)} in your library · $missing not"
        }
    }

    fun partAction(part: CollectionPart): PartAction {
        if (part.owned && part.movie != null) return PartAction.PLAY
        val r = part.request ?: return PartAction.REQUEST
        return when (r.status) {
            "dismissed" -> PartAction.DISMISSED
            "added" -> PartAction.ADDED
            else -> if (r.mine) PartAction.REQUESTED_BY_YOU else PartAction.REQUESTED_BY_OTHERS
        }
    }

    /** The small label under a not-owned tile. Null for an owned film (it shows its year). */
    fun partBadge(part: CollectionPart): String? = when (partAction(part)) {
        PartAction.PLAY -> null
        PartAction.REQUEST -> "Not in library"
        PartAction.REQUESTED_BY_YOU -> "Requested"
        PartAction.REQUESTED_BY_OTHERS -> "Someone asked"
        PartAction.DISMISSED -> "Not getting it"
        PartAction.ADDED -> "On its way"
    }

    /** May choosing this tile open the request dialog? */
    fun canRequest(part: CollectionPart): Boolean =
        partAction(part) == PartAction.REQUEST || partAction(part) == PartAction.REQUESTED_BY_OTHERS

    /** Server-relative cached poster first, then the TMDB CDN one. */
    fun posterPath(poster: String?, tmdbPoster: String?): String? =
        poster?.takeIf { it.isNotBlank() } ?: tmdbPoster?.takeIf { it.isNotBlank() }

    /**
     * "Part of the Alien Collection" for a film's details. The server's name is used as-is
     * apart from making sure it reads as a collection and doesn't say "the The".
     */
    fun partOfLine(collectionName: String?): String? {
        val n = collectionName?.trim().orEmpty()
        if (n.isEmpty()) return null
        val named = if (n.endsWith("collection", ignoreCase = true)) n else "$n Collection"
        val bare = if (named.startsWith("the ", ignoreCase = true)) named.substring(4) else named
        return "Part of the $bare"
    }

    /** After a successful request from a franchise's page: show it as yours without a reload. */
    fun withRequested(detail: CollectionDetail, tmdbId: Int, requestId: String, status: String = "requested"): CollectionDetail =
        detail.copy(parts = detail.parts.map { p ->
            if (p.tmdbId == tmdbId && !p.owned) {
                p.copy(request = com.beeboentertainment.movie.data.RequestRef(requestId, status, mine = true))
            } else p
        })
}
