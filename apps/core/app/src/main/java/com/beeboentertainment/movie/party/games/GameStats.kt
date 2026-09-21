package com.beeboentertainment.movie.party.games

import android.content.SharedPreferences

/**
 * A tiny persisted play counter for This or That, so the Trip Recap can say how much the family
 * played without the game needing a whole history store. Deliberately three keys in the app's
 * existing plain [SharedPreferences] (no new file), written once per round.
 */
object ThisOrThatStats {

    private const val K_ROUNDS = "tot_rounds_v1"
    private const val K_FIRST = "tot_first_ms_v1"
    private const val K_LAST = "tot_last_ms_v1"

    data class Snapshot(val rounds: Int, val firstMs: Long, val lastMs: Long)

    /** Count one round that started/was seen on this device, stamping first- and last-played. */
    fun recordRound(prefs: SharedPreferences) {
        val now = System.currentTimeMillis()
        val editor = prefs.edit()
            .putInt(K_ROUNDS, prefs.getInt(K_ROUNDS, 0) + 1)
            .putLong(K_LAST, now)
        if (prefs.getLong(K_FIRST, 0L) <= 0L) editor.putLong(K_FIRST, now)
        editor.apply()
    }

    fun snapshot(prefs: SharedPreferences): Snapshot = Snapshot(
        rounds = prefs.getInt(K_ROUNDS, 0),
        firstMs = prefs.getLong(K_FIRST, 0L),
        lastMs = prefs.getLong(K_LAST, 0L),
    )

    /** Clear the counter — used when the family starts a fresh trip from the recap screen. */
    fun reset(prefs: SharedPreferences) {
        prefs.edit().remove(K_ROUNDS).remove(K_FIRST).remove(K_LAST).apply()
    }
}

/**
 * The same tiny persisted play counter, but for Movie Trivia — a "best-of-N" round counts as one
 * play. Mirrors [ThisOrThatStats] exactly (three keys in the app's existing plain
 * [SharedPreferences], no new file) so the Trip Recap / badges can report trivia rounds the same
 * way without a bespoke history store.
 */
object MovieTriviaStats {

    private const val K_ROUNDS = "trivia_rounds_v1"
    private const val K_FIRST = "trivia_first_ms_v1"
    private const val K_LAST = "trivia_last_ms_v1"

    data class Snapshot(val rounds: Int, val firstMs: Long, val lastMs: Long)

    /** Count one completed trivia round, stamping first- and last-played. */
    fun recordRound(prefs: SharedPreferences) {
        val now = System.currentTimeMillis()
        val editor = prefs.edit()
            .putInt(K_ROUNDS, prefs.getInt(K_ROUNDS, 0) + 1)
            .putLong(K_LAST, now)
        if (prefs.getLong(K_FIRST, 0L) <= 0L) editor.putLong(K_FIRST, now)
        editor.apply()
    }

    fun snapshot(prefs: SharedPreferences): Snapshot = Snapshot(
        rounds = prefs.getInt(K_ROUNDS, 0),
        firstMs = prefs.getLong(K_FIRST, 0L),
        lastMs = prefs.getLong(K_LAST, 0L),
    )

    fun reset(prefs: SharedPreferences) {
        prefs.edit().remove(K_ROUNDS).remove(K_FIRST).remove(K_LAST).apply()
    }
}
