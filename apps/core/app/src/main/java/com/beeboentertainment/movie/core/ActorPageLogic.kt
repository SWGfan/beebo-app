package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.MissingTitle
import com.beeboentertainment.movie.data.SearchSite

/**
 * ▶ Trailer on a poster: which titles get the button and where a YouTube key is sent.
 * The key comes from the server (GET /api/trailer); the app opens the YouTube app when it is
 * installed and the web page otherwise.
 */
object TrailerLogic {

    const val NO_TRAILER = "No trailer found"

    private val KEY = Regex("^[A-Za-z0-9_-]{6,20}$")

    /** Only a matched title (a real TMDB id) can have a trailer looked up. */
    fun canShow(tmdbId: Int?): Boolean = tmdbId != null && tmdbId > 0

    /** A key is only ever put into a URL when it looks like a YouTube video id. */
    fun isValidKey(key: String?): Boolean = key != null && KEY.matches(key)

    /** Opens the YouTube app directly. */
    fun appUri(key: String): String? = if (isValidKey(key)) "vnd.youtube:$key" else null

    /** The fallback when there is no YouTube app (most Android TVs without it, some phones). */
    fun webUrl(key: String): String? = if (isValidKey(key)) "https://www.youtube.com/watch?v=$key" else null

    /** The URIs to try, in order. Empty means there is nothing to open. */
    fun launchOrder(key: String?): List<String> =
        if (key == null || !isValidKey(key)) emptyList() else listOfNotNull(appUri(key), webUrl(key))
}

/**
 * The "look it up" button on a title not in the library: the owner's chosen site (the same one
 * the desktop app searches for Movies or for TV Shows), with Google as the fallback and the
 * second option.
 */
object SearchSiteLogic {

    const val PLACEHOLDER = "{query}"

    val GOOGLE = SearchSite(engine = "google", name = "Google", urlTemplate = "https://www.google.com/search?q={query}", appendYear = true)

    /** JavaScript's encodeURIComponent, which is what the desktop app uses, so both build the same URL. */
    fun encodeComponent(s: String): String =
        java.net.URLEncoder.encode(s, "UTF-8")
            .replace("+", "%20")
            .replace("%21", "!")
            .replace("%27", "'")
            .replace("%28", "(")
            .replace("%29", ")")
            .replace("%7E", "~")

    /** A template we are willing to open: http(s), with a {query} slot. */
    fun isUsable(site: SearchSite?): Boolean {
        val t = site?.urlTemplate?.trim().orEmpty()
        return (t.startsWith("https://", true) || t.startsWith("http://", true)) && t.contains(PLACEHOLDER)
    }

    /** The site to use, falling back to Google when the server sent nothing usable. */
    fun resolve(site: SearchSite?): SearchSite = if (isUsable(site)) site!! else GOOGLE

    /** "Title 1998" for built-in engines, the title alone for custom sites (as on the desktop). */
    fun query(title: String, year: Int?, appendYear: Boolean): String {
        val t = title.trim()
        return if (appendYear && year != null && year > 0) "$t $year" else t
    }

    fun url(site: SearchSite?, title: String, year: Int?): String {
        val s = resolve(site)
        return s.urlTemplate.trim().replace(PLACEHOLDER, encodeComponent(query(title, year, s.appendYear)))
    }

    /** The site for a kind of title, from the server's answer (null == older server). */
    fun siteFor(kind: String, movies: SearchSite?, tv: SearchSite?): SearchSite = resolve(if (kind == "tv") tv else movies)

    fun buttonLabel(site: SearchSite?): String = "Search " + resolve(site).name.ifBlank { "Google" }

    /** A second "Google" button only makes sense when the main one isn't Google already. */
    fun showGoogleToo(site: SearchSite?): Boolean = resolve(site).engine != "google"
}

/** "Not in your library" on the actor page. */
object MissingTitlesLogic {

    const val SECTION_TITLE = "Not in your library"
    const val SECTION_HINT = "Other things they're in that you don't have yet."
    const val BADGE = "Not owned"

    enum class RequestState { REQUEST, JOIN, REQUESTED_BY_YOU, ADDED, DISMISSED }

    fun films(items: List<MissingTitle>): List<MissingTitle> = items.filter { it.kind != "tv" && it.tmdbId > 0 }

    fun shows(items: List<MissingTitle>): List<MissingTitle> = items.filter { it.kind == "tv" && it.tmdbId > 0 }

    /**
     * Belt and braces: never offer something the owned lists on this very screen already show
     * (the server excludes them too; this covers a list that changed between the two calls).
     */
    fun withoutOwned(items: List<MissingTitle>, ownedMovieIds: Set<Int>, ownedShowIds: Set<Int>): List<MissingTitle> =
        items.filterNot { if (it.kind == "tv") it.tmdbId in ownedShowIds else it.tmdbId in ownedMovieIds }

    fun subtitle(item: MissingTitle): String =
        listOfNotNull(if (item.kind == "tv") "TV show" else "Film", item.year?.toString()).joinToString(" · ")

    fun roleLine(item: MissingTitle): String? = item.character?.trim()?.takeIf { it.isNotEmpty() }?.let { "as $it" }

    fun requestState(item: MissingTitle): RequestState {
        val r = item.request ?: return RequestState.REQUEST
        return when (r.status) {
            "dismissed" -> RequestState.DISMISSED
            "added" -> RequestState.ADDED
            else -> if (r.mine) RequestState.REQUESTED_BY_YOU else RequestState.JOIN
        }
    }

    fun canRequest(item: MissingTitle): Boolean =
        requestState(item).let { it == RequestState.REQUEST || it == RequestState.JOIN }

    fun requestButtonLabel(item: MissingTitle): String = when (requestState(item)) {
        RequestState.REQUEST -> "Request this title"
        RequestState.JOIN -> "Ask for this too"
        RequestState.REQUESTED_BY_YOU -> "You've asked for this"
        RequestState.ADDED -> "On its way"
        RequestState.DISMISSED -> "The owner isn't getting this"
    }

    /** The small label on the tile. */
    fun badge(item: MissingTitle): String = when (requestState(item)) {
        RequestState.REQUESTED_BY_YOU -> "Requested"
        RequestState.JOIN -> "Someone asked"
        RequestState.ADDED -> "On its way"
        else -> BADGE
    }

    /** The list after a request went through: that tile turns into "Requested". */
    fun markRequested(items: List<MissingTitle>, kind: String, tmdbId: Int, requestId: String, status: String): List<MissingTitle> =
        items.map {
            if (it.kind == kind && it.tmdbId == tmdbId) it.copy(request = com.beeboentertainment.movie.data.RequestRef(requestId, status, mine = true))
            else it
        }
}
