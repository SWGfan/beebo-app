package com.beeboentertainment.movie.core

/**
 * Browse's segmented switch: films and shows together, one of them, or the music library.
 *
 * MUSIC is a different kind of thing, not a filter over the same grid: it draws its own screen
 * (artists, albums, songs), so it includes neither films nor shows.
 */
enum class BrowseFilter(val label: String) {
    ALL("All"), FILMS("Films"), SHOWS("Shows"), MUSIC("Music");

    val includesFilms: Boolean get() = this == ALL || this == FILMS
    val includesShows: Boolean get() = this == ALL || this == SHOWS

    /** True for the switch positions that show the films-and-shows grid, search box and chips. */
    val isVideo: Boolean get() = this != MUSIC

    companion object {
        fun fromName(name: String?): BrowseFilter = entries.firstOrNull { it.name == name } ?: ALL
    }
}

/**
 * Browse's pure rules: which titles the switch shows, one search over films and shows, how the
 * merged results are ordered, and when to offer "Request this title".
 */
object BrowseLogic {

    enum class Kind { FILM, SHOW }

    /** One tile in a merged list. Exactly one of [film] and [show] is set, matching [kind]. */
    data class Hit<F, S>(val kind: Kind, val title: String, val film: F? = null, val show: S? = null)

    /** Shortest search that runs, the same as Request a title's. */
    const val MIN_QUERY = 2

    /**
     * How well [title] matches [query]; lower is better, null is no match.
     * 0 the whole title, 1 the start of the title, 2 the start of a word, 3 anywhere.
     * Case and accents are ignored, so "amelie" finds "Amélie".
     */
    fun matchRank(title: String, query: String): Int? {
        val q = fold(query).trim()
        if (q.isEmpty()) return 3
        val t = fold(title).trim()
        return when {
            t == q -> 0
            t.startsWith(q) -> 1
            t.split(' ', '-', ':', '.', '(', '\'').any { it.startsWith(q) } -> 2
            t.contains(q) -> 3
            else -> null
        }
    }

    private fun fold(s: String): String =
        java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFD)
            .replace(Regex("\\p{Mn}+"), "")
            .lowercase()

    /**
     * The titles to draw for [filter] and [query].
     *
     * No query: everything the switch allows, A-Z with the same key the A-Z bar uses (a film
     * before a show of the same name). A query: only matches, best match first, then A-Z, then
     * films before shows, so typing a title puts that title first whichever kind it is.
     */
    fun <F, S> results(
        films: List<F>,
        shows: List<S>,
        filter: BrowseFilter,
        query: String,
        filmTitle: (F) -> String,
        showTitle: (S) -> String
    ): List<Hit<F, S>> {
        val all = buildList {
            if (filter.includesFilms) films.forEach { add(Hit<F, S>(Kind.FILM, filmTitle(it), film = it)) }
            if (filter.includesShows) shows.forEach { add(Hit<F, S>(Kind.SHOW, showTitle(it), show = it)) }
        }
        val q = query.trim()
        if (q.isEmpty()) {
            return all.sortedWith(
                compareBy<Hit<F, S>>({ AlphaIndex.sortKey(it.title) }, { it.title.uppercase() }, { it.kind.ordinal })
            )
        }
        return all
            .mapNotNull { hit -> matchRank(hit.title, q)?.let { it to hit } }
            .sortedWith(
                compareBy<Pair<Int, Hit<F, S>>>(
                    { it.first },
                    { AlphaIndex.sortKey(it.second.title) },
                    { it.second.title.uppercase() },
                    { it.second.kind.ordinal }
                )
            )
            .map { it.second }
    }

    /** Whether Browse is showing search results (rather than the switch's A-Z grid). */
    fun isSearching(query: String): Boolean = query.isNotBlank()

    /** The state under the search box while a query is typed. */
    enum class SearchState { LOADING, RESULTS, TOO_SHORT, REQUEST_THIS_TITLE }

    /**
     * Nothing in the library for a real query: offer "Request this title" (prefilled) instead of
     * a dead end. A one-letter query that finds nothing just says so; the catalogue still
     * loading is not "nothing found".
     */
    fun searchState(query: String, resultCount: Int, loading: Boolean): SearchState = when {
        resultCount > 0 -> SearchState.RESULTS
        loading -> SearchState.LOADING
        query.trim().length < MIN_QUERY -> SearchState.TOO_SHORT
        else -> SearchState.REQUEST_THIS_TITLE
    }

    /** Request a title's own switch, matching Browse's. */
    fun requestKindFor(filter: BrowseFilter): TitleRequestLogic.Kind = when (filter) {
        BrowseFilter.FILMS -> TitleRequestLogic.Kind.MOVIE
        BrowseFilter.SHOWS -> TitleRequestLogic.Kind.TV
        // Music has nothing to request from TMDB, so it asks the same way All does.
        BrowseFilter.ALL, BrowseFilter.MUSIC -> TitleRequestLogic.Kind.ALL
    }

    /**
     * TV listings (TMDB) lump some genres together that films keep apart. Browse splits them so
     * "Action" means the same thing for a film and a show, and a show tagged "Action & Adventure"
     * appears under both Action and Adventure. The film names are used ("Science Fiction").
     */
    private val COMBINED_GENRES = mapOf(
        "action & adventure" to listOf("Action", "Adventure"),
        "sci-fi & fantasy" to listOf("Science Fiction", "Fantasy"),
        "war & politics" to listOf("War", "Politics")
    )

    /** The genre chip names one server genre stands for: itself, or its parts when combined. */
    fun splitGenre(name: String): List<String> =
        COMBINED_GENRES[name.trim().lowercase()] ?: listOf(name.trim())

    /**
     * Genre chip names from films and shows. The two number their genres differently, so the
     * lists are merged by name ("Comedy" once), with combined TV genres split, A-Z.
     */
    fun mergedGenreNames(filmGenres: List<String>, showGenres: List<String>): List<String> =
        (filmGenres + showGenres).flatMap { splitGenre(it) }.filter { it.isNotBlank() }
            .distinctBy { it.lowercase() }
            .sortedBy { it.lowercase() }

    /** Whether a title with genre [ids] is in the genre called [name], using that kind's [genres] list. */
    fun inGenre(ids: List<Int>, genres: Map<Int, String>, name: String?): Boolean =
        name == null || ids.any { id ->
            genres[id]?.let { g -> splitGenre(g).any { it.equals(name, ignoreCase = true) } } == true
        }

    /** One genre chip: its name and how many titles the current switch shows under it. */
    data class GenreChip(val name: String, val count: Int)

    /**
     * The genre chips for [filter], identical in shape for All, Films and Shows: every genre that
     * has at least one title under the switch, A-Z, with its count.
     */
    fun <F, S> genreChips(
        films: List<F>,
        shows: List<S>,
        filter: BrowseFilter,
        filmGenres: Map<Int, String>,
        showGenres: Map<Int, String>,
        filmGenreIds: (F) -> List<Int>,
        showGenreIds: (S) -> List<Int>
    ): List<GenreChip> {
        val names = mergedGenreNames(
            if (filter.includesFilms) filmGenres.values.toList() else emptyList(),
            if (filter.includesShows) showGenres.values.toList() else emptyList()
        )
        return names.map { name ->
            val filmCount = if (filter.includesFilms) films.count { inGenre(filmGenreIds(it), filmGenres, name) } else 0
            val showCount = if (filter.includesShows) shows.count { inGenre(showGenreIds(it), showGenres, name) } else 0
            GenreChip(name, filmCount + showCount)
        }.filter { it.count > 0 }
    }
}
