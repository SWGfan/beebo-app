package com.beeboentertainment.movie.campsite.tripclock

import com.beeboentertainment.movie.campsite.family.FamilyPackStorage
import kotlinx.serialization.json.Json

/**
 * The Trip Clock, saved. One small JSON string under one key, read fresh on every call (like
 * TripStore), so the state survives the process being killed and the phone restarting: everything in
 * it is an epoch-millisecond instant, which a reboot does not disturb (an "elapsed since boot" clock
 * would).
 *
 * No coordinate is ever written: [TripClockState] has no field for one.
 */
internal class TripClockStore(private val storage: FamilyPackStorage) {

    fun state(): TripClockState {
        val raw = storage.read(KEY)
        if (raw.isNullOrBlank() || raw.length > MAX_CHARS) return TripClockState()
        return runCatching { JSON.decodeFromString(TripClockState.serializer(), raw) }.getOrDefault(TripClockState())
    }

    @Synchronized
    fun update(edit: (TripClockState) -> TripClockState): TripClockState {
        val before = state()
        val after = edit(before)
        if (after != before) storage.write(KEY, JSON.encodeToString(TripClockState.serializer(), after))
        return after
    }

    /** Forget the clock (a finished or abandoned trip). */
    @Synchronized
    fun clear() = storage.remove(KEY)

    companion object {
        private const val KEY = "family_tripclock_v1"
        private const val MAX_CHARS = 60_000
        private val JSON = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    }
}
