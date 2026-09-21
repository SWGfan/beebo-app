package com.beeboentertainment.movie.campsite.tripclock

import com.beeboentertainment.movie.trip.PackingSnapshot
import com.beeboentertainment.movie.trip.StopResult
import com.beeboentertainment.movie.trip.TripStore
import java.util.TimeZone
import java.util.UUID

/**
 * What the Trip Clock does when the parent taps: change the clock, and keep the Trip Journal in step.
 *
 *  - Start: begins the clock, and starts a Trip if none is running or ATTACHES to the one that is
 *    (so the clock never makes a second trip). A new trip begins with its "departed" moment.
 *  - Add a stop: the stop goes on the clock and on the trip as a "stop" moment, so it shows in the
 *    recap. Coordinates are passed through only so the trip can drop them: [TripStore] keeps them
 *    only when the trip's "Save hunt locations" switch is on, and [TripClockState] has no field for
 *    one whatever the switch says.
 *  - Arrive: an "arrived" moment on the trip. It does not end the trip: the family is at camp now.
 *
 * Pure of Android types (the store and the trip store sit behind seams), so it is unit-tested with a
 * fake clock.
 */
internal class TripClockController(
    private val store: TripClockStore,
    private val trips: TripStore,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString().take(12) },
    private val badges: () -> Set<String> = { emptySet() },
    private val packing: () -> PackingSnapshot = { PackingSnapshot() },
) {
    fun state(): TripClockState = store.state()

    fun view(zone: TimeZone = TimeZone.getDefault(), pathFraction: Double? = null): TripClockView =
        TripClockLogic.view(store.state(), nowMs(), zone, pathFraction)

    /** Throws [IllegalArgumentException] (a message for the parent) if the times make no sense. */
    fun start(etaMs: Long, distanceM: Int, unit: KidUnit, nudgeMinutes: Int): TripClockState {
        val started = TripClockLogic.start(nowMs(), etaMs, distanceM, unit, nudgeMinutes)
        store.update { started }
        // Attach to a running trip, or begin one. Either way the trip has its "departed" moment.
        if (trips.active() == null) trips.start("Road trip", emptyList(), badges(), packing())
        return started
    }

    fun adjust(minutes: Int): TripClockState = store.update { TripClockLogic.adjust(it, minutes, nowMs()) }

    fun setEta(etaMs: Long): TripClockState = store.update { TripClockLogic.setEta(it, etaMs, nowMs()) }

    fun setKidUnit(unit: KidUnit): TripClockState = store.update { TripClockLogic.setKidUnit(it, unit) }

    fun setNudge(minutes: Int): TripClockState = store.update { TripClockLogic.setNudge(it, minutes) }

    fun acknowledgeNudge(): TripClockState = store.update { TripClockLogic.acknowledgeNudge(it, nowMs()) }

    /**
     * Add a stop to the clock and the trip. [lat] and [lng] come from the optional GPS and are handed
     * to the trip only so [com.beeboentertainment.movie.trip.TripLogic.recordStop] can decide; the
     * clock's own state never sees them.
     */
    fun addStop(title: String, lat: Double? = null, lng: Double? = null): TripClockState {
        val before = store.state()
        val id = newId()
        val now = nowMs()
        val after = store.update { TripClockLogic.addStop(it, id, title, now) }
        if (after.stops.size > before.stops.size) {
            val added = after.stops.last()
            trips.recordStop(StopResult(added.id, added.title, added.atMs, lat, lng))
        }
        return after
    }

    fun arrive(): TripClockState {
        val before = store.state()
        val after = store.update { TripClockLogic.arrive(it, nowMs()) }
        if (before.arrivedAtMs == 0L && after.arrivedAtMs > 0L) trips.recordArrival()
        return after
    }

    fun reset() = store.clear()
}
