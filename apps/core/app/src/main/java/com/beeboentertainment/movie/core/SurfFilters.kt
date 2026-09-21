package com.beeboentertainment.movie.core

/**
 * The three-axis surf selection: what kind of thing, which genre, which slice of time.
 *
 * Pure Kotlin so the composition rules — especially "pass at most one of year/decade" — can be
 * unit-tested without a device. The screen and the player both build their requests from here,
 * which is what keeps the two in sync.
 */
data class SurfFilters(
    val kind: String = KIND_MOVIE,
    val genreId: Int? = null,
    /** Kept only for display; the request carries the id. */
    val genreName: String? = null,
    /**
     * The decade the user drilled into. Stays set while a specific [year] inside it is chosen,
     * so the year chips remain expanded — but in that case it is NOT sent to the server.
     */
    val decade: Int? = null,
    val year: Int? = null
) {

    companion object {
        const val KIND_MOVIE = "movie"
        const val KIND_TV = "tv"
        const val KIND_BOTH = "both"

        val KINDS = listOf(KIND_MOVIE, KIND_TV, KIND_BOTH)

        fun kindLabel(kind: String): String = when (kind) {
            KIND_TV -> "TV Shows"
            KIND_BOTH -> "Both"
            else -> "Movies"
        }

        fun kindEmoji(kind: String): String = when (kind) {
            KIND_TV -> "📺"   // 📺
            KIND_BOTH -> "🍿" // 🍿
            else -> "🎬"      // 🎬
        }

        fun isValidKind(kind: String?): Boolean = kind in KINDS

        /** 1994 -> 1990. Negative/absurd input is returned untouched rather than throwing. */
        fun decadeOf(year: Int): Int = if (year < 0) year else year - (year % 10)

        fun decadeLabel(decade: Int): String = "${decade}s"

        /** Is this year inside this decade bucket? */
        fun yearInDecade(year: Int, decade: Int): Boolean = year >= decade && year <= decade + 9
    }

    /* ------------------------------ transitions ------------------------------ */

    /** Changing the kind invalidates everything downstream — the pools are different. */
    fun withKind(newKind: String): SurfFilters =
        if (newKind == kind) this
        else SurfFilters(kind = if (isValidKind(newKind)) newKind else KIND_MOVIE)

    /** Selecting a genre must preserve the year selection. */
    fun withGenre(id: Int?, name: String? = null): SurfFilters =
        copy(genreId = id, genreName = if (id == null) null else name)

    fun clearGenre(): SurfFilters = copy(genreId = null, genreName = null)

    /**
     * Drill into a decade. Clears any specific year, because the user just widened the slice
     * back out to ten years. Preserves the genre.
     */
    fun withDecade(d: Int?): SurfFilters =
        if (d == null) copy(decade = null, year = null) else copy(decade = d, year = null)

    /** Pick a specific year; the enclosing decade is remembered so the year chips stay open. */
    fun withYear(y: Int?): SurfFilters =
        if (y == null) copy(year = null) else copy(year = y, decade = decadeOf(y))

    fun clearTime(): SurfFilters = copy(decade = null, year = null)

    fun clearAll(): SurfFilters = SurfFilters(kind = kind)

    /* ------------------------------- requests ------------------------------- */

    /** The `genre` query value: the API wants the raw id or nothing. */
    val genreParam: String? get() = genreId?.takeIf { it != 0 }?.toString()

    /**
     * The `year` query value. Only ever set when a specific year is chosen.
     * At most one of [requestYear] / [requestDecade] is ever non-null — that is the contract's
     * "pass at most one" rule, enforced here rather than at every call site.
     */
    val requestYear: Int? get() = year

    /** The `decade` query value: suppressed once a specific year narrows it further. */
    val requestDecade: Int? get() = if (year == null) decade else null

    /** True when a year or decade filter is active (which excludes unknown-year titles). */
    val hasTimeFilter: Boolean get() = year != null || decade != null

    val hasAnyFilter: Boolean get() = genreId != null || hasTimeFilter

    /* -------------------------------- labels -------------------------------- */

    /** "Any category" / "Comedy". */
    fun genreLabel(): String = genreName ?: if (genreId == null) "Any category" else "Genre $genreId"

    /** "Any year" / "1990s" / "1994". */
    fun timeLabel(): String = when {
        year != null -> year.toString()
        decade != null -> decadeLabel(decade)
        else -> "Any year"
    }

    /**
     * One-line summary for the chooser and for the player chrome, e.g.
     * "Movies · Comedy · 1990s" or "Both · Any category · Any year".
     */
    fun summary(includeKind: Boolean = true): String {
        val parts = mutableListOf<String>()
        if (includeKind) parts += kindLabel(kind)
        parts += genreLabel()
        parts += timeLabel()
        return parts.joinToString(" · ")
    }

    /** Shorter form used when only the active filters matter (empty-pool message). */
    fun activeFilterSummary(): String {
        val parts = mutableListOf(kindLabel(kind))
        genreName?.let { parts += it }
        if (hasTimeFilter) parts += timeLabel()
        return parts.joinToString(" · ")
    }
}

/**
 * How big is the pool for the current combination?
 *
 * The server does the work for us: genre counts already respect an active year filter, and year
 * counts already respect an active genre. So the right number is always sitting in one of the
 * bucket lists — we just have to pick the correct one instead of making a third round trip.
 *
 * Takes plain id/count pairs so the pure core stays free of data-layer types.
 */
object SurfPoolSize {

    fun estimate(
        filters: SurfFilters,
        genreCounts: List<Pair<Int, Int>>,
        decadeCounts: List<Pair<Int, Int>>,
        yearCounts: List<Pair<Int, Int>>,
        total: Int
    ): Int {
        // A genre chip's count is already the genre+year pool size.
        filters.genreId?.let { id ->
            return genreCounts.firstOrNull { it.first == id }?.second ?: 0
        }
        // No genre: fall back to the year buckets, which are genre-aware.
        filters.year?.let { y ->
            return yearCounts.firstOrNull { it.first == y }?.second ?: 0
        }
        filters.decade?.let { d ->
            return decadeCounts.firstOrNull { it.first == d }?.second ?: 0
        }
        return total
    }
}
