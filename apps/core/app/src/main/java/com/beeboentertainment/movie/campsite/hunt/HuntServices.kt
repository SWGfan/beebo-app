package com.beeboentertainment.movie.campsite.hunt

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.campsite.family.FamilyPackBHost
import com.beeboentertainment.movie.campsite.quiet.QuietGate
import com.beeboentertainment.movie.trip.TripStore
import com.beeboentertainment.movie.trip.TripStoreSink

/**
 * The hunt service and its guest page, bundled so the public
 * [com.beeboentertainment.movie.campsite.CampsiteServer] can take them as one parameter without
 * exposing module-internal types (the same shape as the Songbook and Quiz bundle). Built lazily: a
 * server that never gets a hunt request (every existing test) never reads an asset.
 */
class HuntServices internal constructor(
    huntProvider: () -> HuntService,
    internal val page: () -> String,
) {
    internal val hunt: HuntService by lazy(huntProvider)

    companion object {
        /** The app's one shared instance, also used by the host phone's own screen. */
        fun shared(): HuntServices = HuntHost.services
    }
}

/** Process-wide instance for the app itself. Tests build their own [HuntServices] instead. */
internal object HuntHost {

    val services: HuntServices by lazy {
        HuntServices(
            huntProvider = {
                val prefs = BeeboApp.instance.session.plain
                HuntService(
                    trip = TripStoreSink(TripStore.forApp(prefs)),
                    badges = HuntPrefsBadgeSink(prefs),
                    quiet = { QuietGate.isQuietNow() },
                )
            },
            page = { FamilyPackBHost.readAsset("campsite-hunt.html") },
        )
    }

    val hunt: HuntService get() = services.hunt
}
