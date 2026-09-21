package com.beeboentertainment.movie.campsite.games

/**
 * A game played on ONE phone, by one person, with nobody else and nothing else running.
 *
 * WHY THIS IS NOT A [CampsiteGame]: a campsite game is a thing the host serves to guests -
 * it seats players, takes authenticated moves and renders a per-viewer view for the guest
 * page. A solo puzzle has none of that. Listing one in [CampsiteGameCatalog.ALL] would put
 * it on every guest's menu with nothing behind it, so solo puzzles are described here and
 * listed in their own block of the catalog. They share the metadata names the menu reads
 * ([id], [title], [blurb], [category], [needsGuests]) so one menu can show both kinds.
 *
 * Solo puzzles never touch the campsite server, the hotspot or the network. Everything
 * they keep (a game in progress, stats, best times) is in the app's own plain preferences.
 */
internal data class SoloGame(
    /** Stable id. Saved games and stats are keyed by it, so never change one. */
    val id: String,
    val title: String,
    val blurb: String,
    val emoji: String,
    val category: GameCategory,
    /** The "How to play" sheet, one short paragraph per entry. */
    val howToPlay: List<String>,
    /** Always false for a solo puzzle: it is the definition of one. */
    val needsGuests: Boolean = false,
    /**
     * True when the game cannot sensibly be played with a D-pad or remote (drag-and-drop,
     * pinch). False when every action has a focusable control or a key. The same fact as
     * [CampsiteGame.needsTouch].
     */
    val needsTouch: Boolean,
) {
    /** Whether Android TV can offer it: the rule of [CampsiteGame.showOnTv]. A solo puzzle uses no camera and is never passed round. */
    val showOnTv: Boolean
        get() = com.beeboentertainment.movie.core.TvFeatures.gameShowsOnTv(needsTouch, usesCamera = false, passThePhone = false)
}
