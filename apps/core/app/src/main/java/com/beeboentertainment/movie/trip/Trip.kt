package com.beeboentertainment.movie.trip

import kotlinx.serialization.Serializable

/** One line of a packing-list snapshot: the item's words and whether it was ticked. */
@Serializable
data class PackedItem(val text: String, val checked: Boolean = false)

/**
 * The packing list as it stood at one moment (leaving, coming home). A copy, not a live view:
 * the checklist keeps changing after the trip and the recap must keep saying what was true then.
 */
@Serializable
data class PackingSnapshot(val at: Long = 0L, val items: List<PackedItem> = emptyList()) {
    val total: Int get() = items.size
    val packed: Int get() = items.count { it.checked }
}

/** The kinds of entry in a trip's moment log. Wire strings, saved in the JSON, so never rename one. */
object MomentKind {
    const val DEPARTED = "departed"
    const val HOME = "home"
    const val STORY = "story"
    const val HUNT = "hunt"

    // Family pack B (Campfire Songbook): one entry per singing session, titles only.
    const val SONG = "song"
    /** A finished Plate & Sign Hunt round: "Spotted 34 of 64". Counts only, never a location. */
    const val TALLY = "tally"

    /** The Trip Clock reached its destination. Does not end the trip: the family is now at camp. */
    const val ARRIVED = "arrived"

    /** A stop the parent added on the Trip Clock ("Snack stop"). Coordinates only if the trip opted in. */
    const val STOP = "stop"
}

/**
 * One entry in the trip's log. A single flat shape on purpose: adding a kind later needs no
 * schema change, and every field has a default so an older saved trip still reads back.
 *
 * [names] are display names exactly as somebody typed them (the storyteller, the finder). They
 * identify nobody; see [TripLogic.mergeRoster].
 */
@Serializable
data class TripMoment(
    val id: String,
    val at: Long,
    val kind: String,
    val title: String = "",
    val text: String = "",
    val names: List<String> = emptyList(),
    val mood: String = "",
    /** Only ever set when the trip's [Trip.saveLocation] is on. See [TripLogic.recordHunt]. */
    val lat: Double? = null,
    val lng: Double? = null,
)

/**
 * A photo or video the person picked for this trip through the system photo picker. Only the
 * address the picker handed back is kept, never a copy, and the picker's access to it can lapse,
 * so every reader has to cope with a media item that no longer opens.
 */
@Serializable
data class TripMedia(
    val uri: String,
    val video: Boolean = false,
    /** Epoch millis the picture or clip was taken, or 0 when the picker did not say. */
    val takenAt: Long = 0L,
)

/**
 * A trip: what one family outing looked like, kept on this phone.
 *
 * A trip is not a campsite session. The guest server dies after 15 idle minutes and a trip
 * spans many sessions, so a trip is its own thing with its own start and end, and everything
 * else (matches, badges, packing) is looked up by the time window it defines.
 */
@Serializable
data class Trip(
    val id: String,
    val name: String,
    val startedAt: Long,
    /** 0 while the trip is running. */
    val endedAt: Long = 0L,
    /**
     * Names the host added. The recap's full roster also folds in the names that turn up in
     * matches and the moment log, see [TripQueries.roster].
     */
    val roster: List<String> = emptyList(),
    val moments: List<TripMoment> = emptyList(),
    val badgesAtStart: List<String> = emptyList(),
    val badgesAtEnd: List<String> = emptyList(),
    val packingAtDepart: PackingSnapshot = PackingSnapshot(),
    val packingAtReturn: PackingSnapshot? = null,
    /** Off unless the host turns it on. Hunt coordinates are saved only while this is true. */
    val saveLocation: Boolean = false,
    val media: List<TripMedia> = emptyList(),
) {
    val running: Boolean get() = endedAt <= 0L
}

/** Everything saved: the trips, oldest first. At most one is running. */
@Serializable
data class TripBook(val trips: List<Trip> = emptyList()) {
    val active: Trip? get() = trips.lastOrNull { it.running }
}

/** A finished story, as handed to the trip by a game. Pure data. */
data class StoryResult(
    val id: String,
    val title: String,
    val mood: String,
    val tellers: List<String>,
    val text: String,
)

/** A finished plate or sign hunt, as handed to the trip. Counts and nicknames only: no location. */
data class TallyResult(
    val id: String,
    val title: String,
    val text: String,
    val found: Int,
    val total: Int,
    val names: List<String> = emptyList(),
)

/** A stop added on the Trip Clock. [lat] and [lng] are dropped unless the trip has saveLocation on. */
data class StopResult(
    val id: String,
    val title: String,
    val at: Long,
    val lat: Double? = null,
    val lng: Double? = null,
)

/** One scavenger-hunt find, as handed to the trip. Coordinates are dropped unless the trip opted in. */
data class HuntFind(
    val waypointId: String,
    val label: String,
    val finder: String,
    val lat: Double? = null,
    val lng: Double? = null,
)
