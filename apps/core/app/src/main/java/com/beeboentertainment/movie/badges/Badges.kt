package com.beeboentertainment.movie.badges

import android.content.SharedPreferences
import com.beeboentertainment.movie.checklist.ChecklistStore
import com.beeboentertainment.movie.data.ContinueCache
import com.beeboentertainment.movie.party.games.ThisOrThatStats
import java.util.Calendar

/**
 * "Explorer" badges — a lightweight retention layer built entirely on activity the app
 * already records. Nothing here is a new tracker of movies/games/packing: the counts come from
 * the existing stores ([ContinueCache], [ThisOrThatStats], [ChecklistStore]); we only persist
 * the small set of *earned* badge ids (plus two tiny counters the app had no home for).
 *
 * Badges are sticky: once earned they stay earned even if the underlying data later resets (a
 * fresh trip clears the game counter, say) — that's the whole point of a keepsake.
 */

/** One badge the family can unlock. [emoji] is its little graphic; [howTo] is the one-liner. */
data class Badge(
    val id: String,
    val title: String,
    val emoji: String,
    val howTo: String,
)

/** The inputs a badge is judged against, gathered once from the existing local stores. */
data class BadgeInputs(
    val moviesWatched: Int,
    val triviaRounds: Int,
    val packingComplete: Boolean,
    val bingoWin: Boolean,
    val trips: Int,
    /** Plates and signs ticked across every finished Plate & Sign Hunt round (Family Pack A). */
    val platesSpotted: Int = 0,
    /** A finished A-to-Z sign hunt with every letter found. */
    val alphabetComplete: Boolean = false,
    /** Nights quiet hours were kept while Campsite was running (Family Pack A). */
    val quietNights: Int = 0,
    /** Items found across finished Scavenger Hunts for Everyone (the best list of each hunt). */
    val huntItems: Int = 0,
    /** Someone found every item on a hunt card. */
    val huntComplete: Boolean = false,
)

/** The fixed catalog, in display order. Ids are stable — they're the persistence key. */
val BADGES: List<Badge> = listOf(
    Badge("first_movie", "First Movie Together", "🎬", "Watch a movie or show together"),
    Badge("trivia_5", "Trivia Rounds x5", "🎲", "Play 5 rounds of This or That"),
    Badge("packed", "Packed and Ready", "🧳", "Tick every item on the packing list"),
    Badge("bingo", "Bingo Winner", "🎉", "Win a round of car bingo"),
    Badge("veteran", "Road Trip Veteran", "🏕️", "Set up Campfire Mode on 3 different days"),
    Badge("plate_spotter_20", "Plate Spotter", "🚗", "Spot 20 plates in Plate & Sign Hunt"),
    Badge("alphabet_complete", "Alphabet Complete", "🔤", "Find every letter A to Z on signs"),
    Badge("quiet_hero", "Quiet Hero", "🌙", "Keep quiet hours for 3 nights"),
    Badge("sharp_eyes", "Sharp Eyes", "🔎", "Find 30 things in Scavenger Hunts"),
    Badge("full_card", "Full Card", "🗒️", "Find every item on a hunt card"),
)

/** Decide, from [inputs], which catalog badges are currently satisfied. */
fun badgeEarned(id: String, inputs: BadgeInputs): Boolean = when (id) {
    "first_movie" -> inputs.moviesWatched >= 1
    "trivia_5" -> inputs.triviaRounds >= 5
    "packed" -> inputs.packingComplete
    "bingo" -> inputs.bingoWin
    "veteran" -> inputs.trips >= 3
    "plate_spotter_20" -> inputs.platesSpotted >= 20
    "alphabet_complete" -> inputs.alphabetComplete
    "quiet_hero" -> inputs.quietNights >= 3
    "sharp_eyes" -> inputs.huntItems >= 30
    "full_card" -> inputs.huntComplete
    else -> false
}

/**
 * Persistence + computation for badges, on the app's existing plain [SharedPreferences]
 * (SessionStore.plain) — no new prefs file. Everything is a handful of keys.
 */
object BadgeStore {

    private const val K_EARNED = "badges_earned_v1"     // comma-joined earned ids
    private const val K_BINGO = "badge_bingo_win_v1"    // set true when a bingo round is won
    private const val K_TRIP_COUNT = "badge_trip_count_v1"
    private const val K_TRIP_DAY = "badge_trip_last_day_v1" // yyyyDDD of the last counted trip day
    private const val K_PLATES = "badge_plates_spotted_v1"
    private const val K_ALPHABET = "badge_alphabet_complete_v1"
    private const val K_HUNT_ITEMS = "badge_hunt_items_v1"
    private const val K_HUNT_COMPLETE = "badge_hunt_complete_v1"

    /** The ids already earned and kept. */
    fun earnedIds(prefs: SharedPreferences): Set<String> =
        prefs.getString(K_EARNED, "")
            ?.split(',')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?.toSet()
            ?: emptySet()

    private fun persistEarned(prefs: SharedPreferences, ids: Set<String>) {
        prefs.edit().putString(K_EARNED, ids.joinToString(",")).apply()
    }

    /** Whether a car-bingo win has ever been recorded. */
    fun bingoWin(prefs: SharedPreferences): Boolean = prefs.getBoolean(K_BINGO, false)

    /**
     * Hook for a future car-bingo game to call on a win. Wiring it unlocks the "Bingo Winner"
     * badge the next time the Badges screen is opened. Unused today, so that badge stays locked.
     */
    fun recordBingoWin(prefs: SharedPreferences) {
        prefs.edit().putBoolean(K_BINGO, true).apply()
    }

    /**
     * A Plate & Sign Hunt round finished. [spotted] is added to the running total (0 for an alphabet
     * hunt, which is not plates); [alphabetComplete] latches. Two small numbers, on this phone only.
     */
    fun recordPlateRound(prefs: SharedPreferences, spotted: Int, alphabetComplete: Boolean) {
        val edit = prefs.edit()
        if (spotted > 0) edit.putInt(K_PLATES, (prefs.getInt(K_PLATES, 0) + spotted).coerceAtMost(1_000_000))
        if (alphabetComplete) edit.putBoolean(K_ALPHABET, true)
        edit.apply()
    }

    /**
     * A Scavenger Hunt for Everyone finished. [found] (the best list's count) is added to the running
     * total; [complete] latches when someone found every item. Two small numbers, on this phone only.
     */
    fun recordHuntRound(prefs: SharedPreferences, found: Int, complete: Boolean) {
        val edit = prefs.edit()
        if (found > 0) edit.putInt(K_HUNT_ITEMS, (prefs.getInt(K_HUNT_ITEMS, 0) + found).coerceAtMost(1_000_000))
        if (complete) edit.putBoolean(K_HUNT_COMPLETE, true)
        edit.apply()
    }

    /** How many distinct days a trip landmark (Campfire Mode) has been used. */
    fun tripCount(prefs: SharedPreferences): Int = prefs.getInt(K_TRIP_COUNT, 0)

    /**
     * Count today as a trip day, at most once per calendar day. Called when Campfire Mode opens
     * (parking at a campsite is a trip milestone). Feeds the "Road Trip Veteran" badge.
     */
    fun recordTripToday(prefs: SharedPreferences) {
        val cal = Calendar.getInstance()
        val today = cal.get(Calendar.YEAR) * 1000 + cal.get(Calendar.DAY_OF_YEAR)
        if (prefs.getInt(K_TRIP_DAY, 0) == today) return
        prefs.edit()
            .putInt(K_TRIP_DAY, today)
            .putInt(K_TRIP_COUNT, prefs.getInt(K_TRIP_COUNT, 0) + 1)
            .apply()
    }

    /** Gather the judging inputs from the existing local stores. */
    fun gatherInputs(prefs: SharedPreferences): BadgeInputs {
        val watched = ContinueCache.get(prefs)?.items.orEmpty().count { it.title.isNotBlank() }
        val rounds = ThisOrThatStats.snapshot(prefs).rounds
        val checklist = ChecklistStore(prefs).visible
        val packingComplete = checklist.isNotEmpty() && checklist.all { it.checked }
        return BadgeInputs(
            moviesWatched = watched,
            triviaRounds = rounds,
            packingComplete = packingComplete,
            bingoWin = bingoWin(prefs),
            trips = tripCount(prefs),
            platesSpotted = prefs.getInt(K_PLATES, 0),
            alphabetComplete = prefs.getBoolean(K_ALPHABET, false),
            huntItems = prefs.getInt(K_HUNT_ITEMS, 0),
            huntComplete = prefs.getBoolean(K_HUNT_COMPLETE, false),
            quietNights = runCatching {
                com.beeboentertainment.movie.campsite.quiet.QuietHoursStore(
                    com.beeboentertainment.movie.campsite.family.SharedPrefsFamilyStorage(prefs),
                ).nights().size
            }.getOrDefault(0),
        )
    }

    /**
     * Recompute earned state from live inputs, UNION it with what's already been earned (sticky),
     * persist, and return the full earned set. Call this when the Badges screen opens.
     */
    fun refresh(prefs: SharedPreferences): Set<String> {
        val inputs = gatherInputs(prefs)
        val nowEarned = BADGES.map { it.id }.filter { badgeEarned(it, inputs) }.toSet()
        val union = earnedIds(prefs) + nowEarned
        persistEarned(prefs, union)
        return union
    }
}
