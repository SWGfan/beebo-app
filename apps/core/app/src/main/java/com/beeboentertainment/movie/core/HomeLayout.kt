package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.ContinueItem

/** Home's sections, in the order they appear. */
enum class HomeSection(val heading: String) {
    CONTINUE("Continue watching"),
    UP_NEXT("Up next"),
    RECENTLY_ADDED("Recently added"),
    BECAUSE_YOU_WATCHED("Because you watched"),
    COLLECTIONS("Collections")
}

/**
 * Home's pure rules. Continue watching always comes first; the shelves under it only start
 * loading once Continue has painted, so Home appears fast.
 */
object HomeLayout {

    val ORDER: List<HomeSection> = HomeSection.entries.toList()

    /**
     * Splits the one-row-per-show list: rows with progress are Continue watching, a show's next
     * episode that hasn't been started is Up next. Order within each is kept as the server sent it.
     */
    fun split(rows: List<ContinueItem>): Pair<List<ContinueItem>, List<ContinueItem>> =
        rows.partition { !isUpNext(it) }

    fun isUpNext(row: ContinueItem): Boolean = row.upNext && row.currentTime <= 0.0

    /** The sections that draw, in [ORDER]; an empty shelf draws nothing at all. */
    fun visibleSections(
        continueCount: Int,
        upNextCount: Int,
        recentCount: Int,
        recommendedCount: Int,
        collectionsCount: Int
    ): List<HomeSection> = ORDER.filter {
        when (it) {
            HomeSection.CONTINUE -> continueCount > 0
            HomeSection.UP_NEXT -> upNextCount > 0
            HomeSection.RECENTLY_ADDED -> recentCount > 0
            HomeSection.BECAUSE_YOU_WATCHED -> recommendedCount > 0
            HomeSection.COLLECTIONS -> collectionsCount > 0
        }
    }

    /** The shelves wait for Continue: nothing below it is fetched while it is still loading. */
    fun shelvesMayLoad(continueLoading: Boolean): Boolean = !continueLoading
}

/**
 * The one-time "Beebo has a new layout" tip. Shown once to someone who used the old layout, and
 * never to a new install (there is nothing for them to relearn).
 */
object NavTip {
    const val KEY = "nav_layout_tip_2026_seen"
    const val TEXT = "Beebo has a new layout: Home, Browse, Library, Play, More. " +
        "Movies and TV are together in Browse."

    /**
     * [hadOldLayout] is whether this launch went straight into the app (it was already set up
     * before this version). A new install marks the tip as seen without showing it.
     */
    fun shouldShow(store: KeyValueStore, hadOldLayout: Boolean): Boolean {
        if (store.getBoolean(KEY, false)) return false
        if (!hadOldLayout) {
            store.putBoolean(KEY, true)
            return false
        }
        return true
    }

    fun dismiss(store: KeyValueStore) = store.putBoolean(KEY, true)
}
