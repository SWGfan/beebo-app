package com.beeboentertainment.movie.core

/**
 * Plain routing rules for the phone's bottom bar and the TV's left rail, kept free of Compose so
 * they can be unit tested.
 *
 * The layout is Home · Browse · Library · Play · More. Earlier layouts had Movies · TV · Library ·
 * Surf · Other (and before that a Downloads tab). Android saves the back stack across process death
 * and app updates, so an old route can come back after this update: every old route is still
 * registered as a destination (restoring an unknown destination would crash) and [migrate] says
 * where it now lives. The screen for an old route only forwards there.
 */
object MainNav {
    const val HOME = "home"
    const val BROWSE = "browse"
    const val LIBRARY = "library"
    const val PLAY = "play"
    const val MORE = "more"

    /** Bottom bar routes, left to right. The TV rail uses the same five, top to bottom. */
    val BOTTOM_TABS = listOf(HOME, BROWSE, LIBRARY, PLAY, MORE)

    /* ---------------------------- routes from older layouts ---------------------------- */

    const val MOVIES = "movies"
    const val TV = "tv"
    /** The old Library tab's route; it opened on Continue, which is now Home. */
    const val OLD_LIBRARY = "continue"
    /** Surf is still a screen, launched by "Surprise me" on Home and More; no longer a tab. */
    const val SURF = "surf"
    /** Historic route name for the Other tab (it started life as Games). */
    const val OTHER = "games"
    const val DOWNLOADS = "downloads"
    /** Story Mode (website build only) now opens inside Play. */
    const val STORIES = "stories"

    val LEGACY_ROUTES = listOf(MOVIES, TV, OLD_LIBRARY, OTHER, DOWNLOADS)

    /** The Browse switch a migrated route should select, and the Library section to open. */
    data class Migration(
        val route: String,
        val browseFilter: BrowseFilter? = null,
        val librarySection: LibrarySection? = null
    )

    /**
     * Where an old route lives now, or null when [route] is not an old tab route. A TV has no
     * Downloads, so the old Downloads route lands on the Library's first section instead.
     */
    fun migrate(route: String?, isTv: Boolean = false): Migration? = when (route) {
        MOVIES -> Migration(BROWSE, browseFilter = BrowseFilter.FILMS)
        TV -> Migration(BROWSE, browseFilter = BrowseFilter.SHOWS)
        OLD_LIBRARY -> Migration(HOME)
        OTHER -> Migration(PLAY)
        DOWNLOADS -> Migration(
            LIBRARY,
            librarySection = LibrarySection.DOWNLOADS.takeIf { TvFeatures.downloadsAvailable(isTv) },
        )
        else -> null
    }

    /**
     * The tab that lights up for [route]: a tab owns itself, an old route lights its new home,
     * Surf belongs to Home (where "Surprise me" lives) and Story Mode to Play. Anything else (a
     * pushed detail screen) owns no tab, returning null.
     */
    fun tabFor(route: String?): String? = when (route) {
        null -> null
        in BOTTOM_TABS -> route
        SURF -> HOME
        STORIES -> PLAY
        else -> migrate(route)?.route
    }

    /** The rail on a TV: the same destinations as the phone, so nothing is hidden behind a remote. */
    fun destinations(isTv: Boolean): List<String> = BOTTOM_TABS

    /** The destination a TV rail's first focus lands on before Home takes it for Continue. */
    fun firstRailFocus(): String = HOME
}

/** Library's sections, in chip order. Continue moved to Home; full history stays here. */
enum class LibrarySection(val label: String) {
    WATCHLIST("☆ Watchlist"),
    FAVOURITES("★ Favourites"),
    /** Your playlists, smart playlists, the ones the owner shares, and the play queue. */
    PLAYLISTS("🎵 Playlists"),
    HISTORY("History"),
    DOWNLOADS("⬇ Downloads");

    /** The section to fall back on when a saved one is not offered on this device. */
    fun onDevice(isTv: Boolean): LibrarySection = if (this in visibleOn(isTv)) this else WATCHLIST

    companion object {
        fun fromName(name: String?): LibrarySection = entries.firstOrNull { it.name == name } ?: WATCHLIST

        /** The chips this device shows, in chip order: a TV has no Downloads (see [TvFeatures]). */
        fun visibleOn(isTv: Boolean): List<LibrarySection> =
            entries.filter { it != DOWNLOADS || TvFeatures.downloadsAvailable(isTv) }
    }
}
