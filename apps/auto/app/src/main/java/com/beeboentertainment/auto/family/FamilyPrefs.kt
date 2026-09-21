package com.beeboentertainment.auto.family

import android.content.Context
import android.content.SharedPreferences
import com.beeboentertainment.auto.drive.VideoGate
import com.beeboentertainment.movie.campsite.family.SharedPrefsFamilyStorage
import com.beeboentertainment.movie.campsite.quiet.QuietHoursStore
import com.beeboentertainment.movie.campsite.tripclock.TripClockStore
import kotlinx.coroutines.flow.MutableStateFlow
import java.util.TimeZone

/**
 * What a parent chose for Family Fun, kept in a small plain preferences file on the phone.
 *
 * NOTHING PERSONAL. Three switches, an age band, a quiet-hours window and the Trip Clock's own
 * saved state (times only: the phone app's [com.beeboentertainment.movie.campsite.tripclock.TripClockState]
 * has no field for a location, a name or a route). No account, no network, nothing is uploaded,
 * and the file is not included in backups ([android:allowBackup] is off for this app).
 *
 * Read cold: Android Auto starts the media service with no screen open, so every value is read
 * straight from disk on each call and never cached.
 */
internal class FamilyPrefs private constructor(private val sp: SharedPreferences) {

    /** Show the Family Fun folder in the car's media list. Off until a parent turns it on. */
    var enabled: Boolean
        get() = sp.getBoolean(KEY_ENABLED, false)
        set(v) = sp.edit().putBoolean(KEY_ENABLED, v).apply()

    /**
     * Allow voice games to be started from the car's own list, hands-free (rounds play one after
     * another, the car's Next button skips). Off until a parent turns it on: the safest default is
     * that nothing game-like plays in a car unless a parent said so.
     */
    var handsFreeGamesOk: Boolean
        get() = sp.getBoolean(KEY_HANDS_FREE, false)
        set(v) = sp.edit().putBoolean(KEY_HANDS_FREE, v).apply()

    var ageBand: AgeBand
        get() = AgeBand.fromWire(sp.getString(KEY_BAND, null))
        set(v) = sp.edit().putString(KEY_BAND, v.wire).apply()

    /** Kid unit for the glance: movies, episodes, songs or none (see [GlanceUnit]). */
    var glanceUnit: GlanceUnit
        get() = GlanceUnit.fromWire(sp.getString(KEY_UNIT, null))
        set(v) = sp.edit().putString(KEY_UNIT, v.wire).apply()

    /** Quiet hours: the phone app's own store, so the window means the same thing in both. */
    val quiet: QuietHoursStore = QuietHoursStore(SharedPrefsFamilyStorage(sp))

    /** The Trip Clock: the phone app's own store and state, kept in this app's preferences. */
    val clock: TripClockStore = TripClockStore(SharedPrefsFamilyStorage(sp))

    fun env(nowMs: Long = System.currentTimeMillis(), zone: TimeZone = TimeZone.getDefault()): FamilyEnv =
        FamilyEnv(
            nowMs = nowMs,
            zone = zone,
            quietSettings = quiet.settings(),
            ageBand = ageBand,
            clock = clock.state(),
            handsFreeGamesOk = handsFreeGamesOk,
        )

    companion object {
        private const val FILE = "beebo_family"
        private const val KEY_ENABLED = "family_enabled"
        private const val KEY_HANDS_FREE = "family_hands_free_games"
        private const val KEY_BAND = "family_age_band"
        private const val KEY_UNIT = "family_glance_unit"

        fun get(context: Context): FamilyPrefs =
            FamilyPrefs(context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE))
    }
}

/**
 * The small amount of state the phone screen and the media service share while both are alive in
 * one process. In memory only: nothing here survives the app being closed, and nothing here is
 * personal.
 */
internal object FamilyRuntime {

    /** Assume the worst until the phone screen says otherwise: a phone in the dashboard, driver's hands full. */
    val WORST_CASE = VideoGate.Signals(isAutomotive = false, projectingToAndroidAuto = true)

    /** Drive signals from the phone screen while it is open. Back to [WORST_CASE] when it closes. */
    val signals = MutableStateFlow(WORST_CASE)

    /** The running sleep timer, or null. */
    val sleep = MutableStateFlow<SleepTimerState?>(null)
}
