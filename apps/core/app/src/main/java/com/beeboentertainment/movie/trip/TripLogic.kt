package com.beeboentertainment.movie.trip

/**
 * Every change to a [TripBook], as pure functions: a book goes in, a new book comes out, and
 * nothing here touches Android, the clock or the disk. [TripStore] wraps these with saving.
 *
 * The rules that matter, so the tests and the screens agree on them:
 *  - One trip runs at a time. Starting while one runs changes nothing.
 *  - Things that happen "during the trip" (a story, a hunt find) are kept only while a trip
 *    is running. With none running they are simply not recorded, and the games behave as before.
 *  - Coordinates are kept only when the trip has [Trip.saveLocation] on. This is the last line of
 *    defence: even a caller that passes a latitude gets it dropped.
 */
object TripLogic {

    const val MAX_TRIPS = 30
    const val MAX_MOMENTS = 400
    const val MAX_MEDIA = 300
    const val MAX_ROSTER = 64
    const val MAX_NAME = 60
    const val MAX_STORY_CHARS = 4000
    const val MAX_PACK_ITEMS = 200

    /** Id prefix of a `hunt` moment written by Scavenger Hunt for Everyone (a GPS waypoint uses "hunt-" and the waypoint id). */
    const val HUNT_CARD_PREFIX = "huntcard-"

    /** The trip name as saved: trimmed, control characters removed, never empty, bounded. */
    fun cleanName(raw: String, fallback: String): String {
        val text = raw.filter { !it.isISOControl() }.trim().take(MAX_NAME)
        return text.ifBlank { fallback }
    }

    /**
     * How two typed names are compared. A guest's identity IS the name they typed: there is no
     * account, no age and no device id behind it, so "Dad" and "dad " are the same person here and
     * two different people who both type "Dad" are, unavoidably, one. That matches how match
     * history already treats names (CampsiteHistoryStore), and the recap must not claim more.
     */
    fun key(name: String): String = name.trim().lowercase()

    /**
     * [existing] followed by every name in [more] not already present (case-insensitively), each
     * as it was first typed. Blank names are dropped and the list is capped.
     */
    fun mergeRoster(existing: List<String>, more: Iterable<String>): List<String> {
        val seen = linkedMapOf<String, String>()
        (existing.asSequence() + more.asSequence()).forEach { raw ->
            val name = raw.filter { !it.isISOControl() }.trim().take(MAX_NAME)
            val k = key(name)
            if (k.isNotEmpty() && k !in seen) seen[k] = name
        }
        return seen.values.take(MAX_ROSTER)
    }

    /** Begin a trip. No-op if one is already running, so a double tap cannot make two. */
    fun start(
        book: TripBook,
        id: String,
        name: String,
        now: Long,
        roster: List<String>,
        badgesEarned: Set<String>,
        packing: PackingSnapshot,
    ): TripBook {
        if (book.active != null) return book
        val trip = Trip(
            id = id,
            name = cleanName(name, "Our trip"),
            startedAt = now,
            roster = mergeRoster(emptyList(), roster),
            moments = listOf(TripMoment(id = "departed", at = now, kind = MomentKind.DEPARTED)),
            badgesAtStart = badgesEarned.sorted(),
            packingAtDepart = capPacking(packing),
        )
        return book.copy(trips = (book.trips + trip).takeLast(MAX_TRIPS))
    }

    /**
     * Finish the running trip. [roster] is the full roster worked out by the caller (typed names,
     * plus everyone who played or told a story), frozen here so the finished trip keeps saying
     * who was there even after match history is trimmed.
     */
    fun end(
        book: TripBook,
        now: Long,
        badgesEarned: Set<String>,
        packing: PackingSnapshot,
        roster: List<String>,
    ): TripBook = updateActive(book) { trip ->
        val at = maxOf(now, trip.startedAt)
        trip.copy(
            endedAt = at,
            roster = mergeRoster(trip.roster, roster),
            badgesAtEnd = badgesEarned.sorted(),
            packingAtReturn = capPacking(packing),
            moments = appendMoment(trip.moments, TripMoment(id = "home", at = at, kind = MomentKind.HOME)),
        )
    }

    /** Keep a finished story on the running trip. Saved once per [StoryResult.id]. */
    fun recordStory(book: TripBook, story: StoryResult, now: Long): TripBook {
        val text = story.text.trim().take(MAX_STORY_CHARS)
        if (text.isEmpty()) return book
        return updateActive(book) { trip ->
            val moment = TripMoment(
                id = "story-" + story.id,
                at = now,
                kind = MomentKind.STORY,
                title = story.title.trim().take(MAX_NAME * 2).ifBlank { "Campfire story" },
                text = text,
                names = mergeRoster(emptyList(), story.tellers),
                mood = story.mood.trim().take(MAX_NAME),
            )
            trip.copy(moments = upsertMoment(trip.moments, moment))
        }
    }

    /**
     * Keep scavenger-hunt finds on the running trip, one entry per waypoint. A later report of the
     * same waypoint updates it in place and keeps the time it was first recorded.
     */
    fun recordHunt(book: TripBook, finds: List<HuntFind>, now: Long): TripBook {
        if (finds.isEmpty()) return book
        return updateActive(book) { trip ->
            var moments = trip.moments
            finds.forEach { find ->
                val id = "hunt-" + find.waypointId
                val first = moments.firstOrNull { it.id == id }?.at ?: now
                val keep = trip.saveLocation && find.lat != null && find.lng != null
                moments = upsertMoment(
                    moments,
                    TripMoment(
                        id = id,
                        at = first,
                        kind = MomentKind.HUNT,
                        title = find.label.trim().take(MAX_NAME * 2).ifBlank { "Waypoint" },
                        names = mergeRoster(emptyList(), listOf(find.finder)),
                        lat = if (keep) find.lat else null,
                        lng = if (keep) find.lng else null,
                    ),
                )
            }
            trip.copy(moments = moments)
        }
    }

    /**
     * Family pack B: keep the songs a family sang on the running trip as ONE entry per singing
     * session ([sessionId]); asking again updates the same entry. Titles only: no audio, no lyrics,
     * and [names] only when the host chose to include them.
     */
    fun recordSongs(book: TripBook, sessionId: String, titles: List<String>, names: List<String>, now: Long): TripBook {
        val clean = titles.map { it.filter { c -> !c.isISOControl() }.trim().take(MAX_NAME * 2) }.filter { it.isNotEmpty() }.take(MAX_PACK_ITEMS)
        if (clean.isEmpty()) return book
        return updateActive(book) { trip ->
            val id = "song-" + sessionId.filter { it.isLetterOrDigit() || it == '-' }.take(40)
            val first = trip.moments.firstOrNull { it.id == id }?.at ?: now
            val moment = TripMoment(
                id = id,
                at = first,
                kind = MomentKind.SONG,
                title = if (clean.size == 1) "Sang " + clean[0] else "Sang " + clean.size + " songs",
                text = clean.joinToString("\n"),
                names = mergeRoster(emptyList(), names),
            )
            trip.copy(moments = upsertMoment(trip.moments, moment))
        }
    }

    /**
     * Keep a finished plate or sign hunt on the running trip, one entry per round id. Counts and
     * nicknames only: there is no coordinate field in a [TallyResult], so nothing here can carry one.
     */
    fun recordTally(book: TripBook, tally: TallyResult, now: Long): TripBook {
        if (tally.total <= 0) return book
        return updateActive(book) { trip ->
            val moment = TripMoment(
                id = "tally-" + tally.id,
                at = now,
                kind = MomentKind.TALLY,
                title = tally.title.trim().take(MAX_NAME * 2).ifBlank { "Plate hunt" },
                text = tally.text.trim().take(MAX_NAME * 3),
                names = mergeRoster(emptyList(), tally.names),
            )
            trip.copy(moments = upsertMoment(trip.moments, moment))
        }
    }

    /**
     * Keep a finished Scavenger Hunt for Everyone on the running trip as a `hunt` moment, one entry per
     * hunt id. Counts and nicknames only: a [TallyResult] has no item text, photo or coordinate. The id
     * starts with [HUNT_CARD_PREFIX] so the recap can tell it from a GPS waypoint.
     */
    fun recordHuntCard(book: TripBook, tally: TallyResult, now: Long): TripBook {
        if (tally.total <= 0 || tally.found <= 0) return book
        return updateActive(book) { trip ->
            val id = HUNT_CARD_PREFIX + tally.id.filter { it.isLetterOrDigit() || it == '-' }.take(40)
            val first = trip.moments.firstOrNull { it.id == id }?.at ?: now
            val moment = TripMoment(
                id = id,
                at = first,
                kind = MomentKind.HUNT,
                title = tally.title.trim().take(MAX_NAME * 2).ifBlank { "Scavenger hunt" },
                text = tally.text.trim().take(MAX_NAME * 3),
                names = mergeRoster(emptyList(), tally.names),
            )
            trip.copy(moments = upsertMoment(trip.moments, moment))
        }
    }

    /** The Trip Clock got there. Written once; a second call keeps the first time. */
    fun recordArrival(book: TripBook, now: Long): TripBook = updateActive(book) { trip ->
        if (trip.moments.any { it.kind == MomentKind.ARRIVED }) trip
        else trip.copy(moments = appendMoment(trip.moments, TripMoment(id = "arrived", at = maxOf(now, trip.startedAt), kind = MomentKind.ARRIVED)))
    }

    /**
     * A stop the parent added on the Trip Clock. Coordinates are kept only when the trip has
     * [Trip.saveLocation] on, the same last line of defence [recordHunt] has.
     */
    fun recordStop(book: TripBook, stop: StopResult, now: Long): TripBook = updateActive(book) { trip ->
        val keep = trip.saveLocation && stop.lat != null && stop.lng != null
        val moment = TripMoment(
            id = "stop-" + stop.id,
            at = if (stop.at > 0L) stop.at else now,
            kind = MomentKind.STOP,
            title = stop.title.filter { !it.isISOControl() }.trim().take(MAX_NAME * 2).ifBlank { "Stop" },
            lat = if (keep) stop.lat else null,
            lng = if (keep) stop.lng else null,
        )
        trip.copy(moments = upsertMoment(trip.moments, moment))
    }

    /** Turn hunt-location saving on or off for the running trip. Turning it off erases what was saved. */
    fun setSaveLocation(book: TripBook, on: Boolean): TripBook = updateActive(book) { trip ->
        if (on) trip.copy(saveLocation = true)
        else trip.copy(
            saveLocation = false,
            moments = trip.moments.map { if (it.lat != null || it.lng != null) it.copy(lat = null, lng = null) else it },
        )
    }

    /** Add typed names to a trip's roster. */
    fun addRoster(book: TripBook, tripId: String, names: List<String>): TripBook =
        updateTrip(book, tripId) { it.copy(roster = mergeRoster(it.roster, names)) }

    fun rename(book: TripBook, tripId: String, name: String): TripBook =
        updateTrip(book, tripId) { it.copy(name = cleanName(name, it.name)) }

    /** The photos and videos picked for a trip, replacing the earlier pick. Duplicates dropped. */
    fun setMedia(book: TripBook, tripId: String, media: List<TripMedia>): TripBook =
        updateTrip(book, tripId) { it.copy(media = media.distinctBy { m -> m.uri }.take(MAX_MEDIA)) }

    fun delete(book: TripBook, tripId: String): TripBook =
        book.copy(trips = book.trips.filterNot { it.id == tripId })

    private fun capPacking(snapshot: PackingSnapshot): PackingSnapshot =
        snapshot.copy(items = snapshot.items.take(MAX_PACK_ITEMS).map { it.copy(text = it.text.trim().take(MAX_NAME * 2)) })

    private fun appendMoment(moments: List<TripMoment>, moment: TripMoment): List<TripMoment> =
        (moments + moment).takeLast(MAX_MOMENTS)

    private fun upsertMoment(moments: List<TripMoment>, moment: TripMoment): List<TripMoment> {
        val at = moments.indexOfFirst { it.id == moment.id }
        return if (at >= 0) moments.toMutableList().also { it[at] = moment } else appendMoment(moments, moment)
    }

    private fun updateActive(book: TripBook, change: (Trip) -> Trip): TripBook {
        val id = book.active?.id ?: return book
        return updateTrip(book, id, change)
    }

    private fun updateTrip(book: TripBook, tripId: String, change: (Trip) -> Trip): TripBook =
        book.copy(trips = book.trips.map { if (it.id == tripId) change(it) else it })
}
