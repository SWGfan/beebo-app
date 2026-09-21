package com.beeboentertainment.movie.trip

import android.content.SharedPreferences
import com.beeboentertainment.movie.data.ApiClient
import java.util.UUID

/**
 * Where the saved [TripBook] lives. A one-string seam so [TripStore] can be built and tested with
 * no Android context: the app uses [SharedPrefsTripPersistence], a test uses [MemoryTripPersistence].
 */
interface TripPersistence {
    fun read(): String?
    fun write(text: String)
}

class MemoryTripPersistence(var text: String? = null) : TripPersistence {
    override fun read(): String? = text
    override fun write(text: String) { this.text = text }
}

/**
 * Trips in the app's existing plain SharedPreferences (SessionStore.plain), the same way match
 * history is kept: one JSON string under one key, encoded with the app's own Json. That file is
 * excluded from Auto Backup and device transfer (res/xml/backup_rules.xml), so a trip - with its
 * guest names - never leaves this phone that way.
 */
class SharedPrefsTripPersistence(private val prefs: SharedPreferences) : TripPersistence {
    override fun read(): String? = runCatching { prefs.getString(KEY, null) }.getOrNull()
    override fun write(text: String) {
        runCatching { prefs.edit().putString(KEY, text).apply() }
    }

    private companion object {
        const val KEY = "trip_journal_v1"
    }
}

/**
 * The trip book, saved. Every call reads the latest copy, applies one [TripLogic] change and writes
 * it back under a process-wide lock. Nothing is cached: the games, the hunt screen and the recap
 * each build their own [TripStore], and a cached book in one would overwrite what another wrote.
 * The book is small (trips are capped), so re-reading is cheap.
 */
class TripStore(
    private val persistence: TripPersistence,
    private val clock: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString().take(12) },
) {

    fun book(): TripBook = synchronized(LOCK) { load() }

    fun active(): Trip? = book().active

    fun trip(id: String): Trip? = book().trips.firstOrNull { it.id == id }

    /** Newest first, which is how the recap lists them. */
    fun all(): List<Trip> = book().trips.sortedByDescending { it.startedAt }

    /** Begin a trip. Returns it, or null if one is already running. */
    fun start(name: String, roster: List<String>, badgesEarned: Set<String>, packing: PackingSnapshot): Trip? {
        val id = newId()
        val next = change { TripLogic.start(it, id, name, clock(), roster, badgesEarned, packing) }
        return next.trips.firstOrNull { it.id == id }
    }

    fun end(badgesEarned: Set<String>, packing: PackingSnapshot, roster: List<String>): Trip? {
        val running = active() ?: return null
        val next = change { TripLogic.end(it, clock(), badgesEarned, packing, roster) }
        return next.trips.firstOrNull { it.id == running.id }
    }

    /** Whether a story was kept (false when no trip is running). */
    fun recordStory(story: StoryResult): Boolean {
        if (active() == null) return false
        change { TripLogic.recordStory(it, story, clock()) }
        return true
    }

    /** Whether a plate or sign hunt was kept (false when no trip is running). */
    fun recordTally(tally: TallyResult): Boolean {
        if (active() == null) return false
        change { TripLogic.recordTally(it, tally, clock()) }
        return true
    }

    fun recordArrival() {
        if (active() == null) return
        change { TripLogic.recordArrival(it, clock()) }
    }

    fun recordStop(stop: StopResult) {
        if (active() == null) return
        change { TripLogic.recordStop(it, stop, clock()) }
    }

    fun recordHunt(finds: List<HuntFind>) {
        if (active() == null) return
        change { TripLogic.recordHunt(it, finds, clock()) }
    }

    /** Family pack B: whether the sung-songs entry was kept (false when no trip is running). */
    fun recordSongs(sessionId: String, titles: List<String>, names: List<String>): Boolean {
        if (active() == null) return false
        change { TripLogic.recordSongs(it, sessionId, titles, names, clock()) }
        return true
    }

    fun setSaveLocation(on: Boolean) { change { TripLogic.setSaveLocation(it, on) } }

    fun addRoster(tripId: String, names: List<String>) { change { TripLogic.addRoster(it, tripId, names) } }

    fun rename(tripId: String, name: String) { change { TripLogic.rename(it, tripId, name) } }

    fun setMedia(tripId: String, media: List<TripMedia>) { change { TripLogic.setMedia(it, tripId, media) } }

    fun delete(tripId: String) { change { TripLogic.delete(it, tripId) } }

    private fun change(edit: (TripBook) -> TripBook): TripBook = synchronized(LOCK) {
        val before = load()
        val after = edit(before)
        if (after != before) persistence.write(ApiClient.JSON.encodeToString(TripBook.serializer(), after))
        after
    }

    private fun load(): TripBook {
        val raw = persistence.read()
        if (raw.isNullOrBlank() || raw.length > MAX_CHARS) return TripBook()
        return runCatching { ApiClient.JSON.decodeFromString(TripBook.serializer(), raw) }.getOrDefault(TripBook())
    }

    companion object {
        private val LOCK = Any()
        private const val MAX_CHARS = 2_000_000

        /** The store the app itself uses. */
        fun forApp(prefs: SharedPreferences): TripStore = TripStore(SharedPrefsTripPersistence(prefs))
    }
}
