package com.beeboentertainment.movie.campsite.solo

import com.beeboentertainment.movie.campsite.games.GameCategory
import com.beeboentertainment.movie.campsite.games.SoloGame
import kotlinx.serialization.Serializable

internal val FIVE_LETTERS_GAME = SoloGame(
    id = "five-letters",
    title = "Five Letters",
    blurb = "Guess the hidden word in six tries. A new daily word, plus endless practice.",
    emoji = "🔤",
    category = GameCategory.PUZZLE,
    howToPlay = listOf(
        "Guess the hidden five-letter word in six tries. Each guess must be a real word.",
        "After each guess the tiles change colour. Green: right letter, right place. Yellow: the letter is in the word but somewhere else. Grey: the letter is not in the word (or not as many times as you used it).",
        "Repeated letters are scored fairly: if the word has one E and you guess two, only one of them lights up.",
        "The Daily word is the same for everyone on the same date and keeps your streak. Practice gives you a fresh word whenever you like and never touches the streak.",
        "Share sends only coloured squares, never the word.",
    ),
    needsTouch = false,
)

/** How one letter of a guess scored. */
internal enum class LetterMark { CORRECT, PRESENT, ABSENT }

/**
 * The rules of Five Letters, with no Android in them so they can be unit tested.
 *
 * The word lists are NOT in this file; see `assets/fiveletters/NOTICE.txt` for where they
 * come from and under what licence.
 */
internal object FiveLetters {
    const val LENGTH = 5
    const val TRIES = 6

    /**
     * Score [guess] against [answer]. Two passes, which is what makes repeated letters
     * honest: greens first use up their letters, then each remaining guess letter may
     * claim one of the letters still unused, left to right. So guessing LLAMA against
     * HELLO gives yellow, yellow, grey, grey, grey - the answer has two Ls, both used by
     * the two yellow Ls, and nothing is left for the A's.
     */
    fun score(guess: String, answer: String): List<LetterMark> {
        require(guess.length == LENGTH && answer.length == LENGTH)
        val g = guess.lowercase()
        val a = answer.lowercase()
        val marks = Array(LENGTH) { LetterMark.ABSENT }
        val unused = IntArray(26)
        for (i in 0 until LENGTH) {
            if (g[i] == a[i]) marks[i] = LetterMark.CORRECT else unused[a[i] - 'a']++
        }
        for (i in 0 until LENGTH) {
            if (marks[i] == LetterMark.CORRECT) continue
            val k = g[i] - 'a'
            if (k in 0..25 && unused[k] > 0) {
                marks[i] = LetterMark.PRESENT
                unused[k]--
            }
        }
        return marks.toList()
    }

    /**
     * The best thing known about each letter so far, for the on-screen keyboard. Green
     * beats yellow beats grey, so a letter once found in place stays green.
     */
    fun keyStates(guesses: List<String>, answer: String): Map<Char, LetterMark> {
        val out = HashMap<Char, LetterMark>()
        guesses.forEach { guess ->
            score(guess, answer).forEachIndexed { i, mark ->
                val c = guess[i].lowercaseChar()
                val old = out[c]
                if (old == null || mark.ordinal < old.ordinal) out[c] = mark
            }
        }
        return out
    }

    /** Day 1 is 1 January 2026. Before that is clamped to day 1. */
    private val EPOCH_DAY = epochDay(2026, 1, 1)

    /** Days since 1970-01-01 for a proleptic Gregorian date. java.time needs API 26; this does not. */
    fun epochDay(year: Int, month: Int, day: Int): Long {
        val y = if (month <= 2) year - 1L else year.toLong()
        val era = Math.floorDiv(y, 400L)
        val yoe = y - era * 400
        val mp = (month + 9) % 12
        val doy = (153 * mp + 2) / 5 + day - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    /** The puzzle number for a calendar date, as shown to the player ("Daily #259"). */
    fun puzzleNumber(year: Int, month: Int, day: Int): Int =
        (epochDay(year, month, day) - EPOCH_DAY + 1).coerceAtLeast(1L).toInt()

    /**
     * The answer for a puzzle number. Deterministic: every phone with the same list gives
     * the same word on the same day, with no server. The list is walked in a fixed
     * shuffled order (a seeded Fisher-Yates using our own SplitMix64, so it never depends
     * on a library's random implementation) so neighbouring days are not alphabetical
     * neighbours, and it only repeats after the whole list has been used.
     */
    fun dailyAnswer(answers: List<String>, puzzleNumber: Int): String {
        require(answers.isNotEmpty())
        val order = IntArray(answers.size) { it }
        val rng = SplitMix64(0x5EED_F1E5L)
        for (i in order.size - 1 downTo 1) {
            val j = rng.nextInt(i + 1)
            val t = order[i]; order[i] = order[j]; order[j] = t
        }
        val index = Math.floorMod(puzzleNumber - 1, answers.size)
        return answers[order[index]]
    }

    /** Emoji-square share text. Letters are never included. */
    fun shareText(title: String, rows: List<List<LetterMark>>, won: Boolean): String {
        val header = "$title ${if (won) rows.size else "X"}/$TRIES"
        val grid = rows.joinToString("\n") { row ->
            row.joinToString("") {
                when (it) {
                    LetterMark.CORRECT -> "🟩"
                    LetterMark.PRESENT -> "🟨"
                    LetterMark.ABSENT -> "⬜"
                }
            }
        }
        return "$header\n\n$grid"
    }

    /** Clean a list file: lowercase, a-z only, exactly five letters, first occurrence kept. */
    fun parseList(text: String): List<String> =
        text.lineSequence().map { it.trim().lowercase() }
            .filter { it.length == LENGTH && it.all { c -> c in 'a'..'z' } }
            .distinct().toList()
}

/** A tiny, fully specified PRNG so a seed means the same thing forever. */
internal class SplitMix64(private var state: Long) {
    fun nextLong(): Long {
        state += -0x61c8864680b583ebL
        var z = state
        z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
        z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
        return z xor (z ushr 31)
    }

    fun nextInt(bound: Int): Int {
        require(bound > 0)
        return Math.floorMod(nextLong() ushr 1, bound.toLong()).toInt()
    }
}

/** One game in progress or finished. Saved as-is so a game resumes exactly. */
@Serializable
internal data class FiveLettersState(
    val daily: Boolean,
    val puzzle: Int,
    val answer: String,
    val guesses: List<String> = emptyList(),
    /** True once the stats have counted this game, so a resumed finished game never counts twice. */
    val counted: Boolean = false,
) {
    val won: Boolean get() = guesses.lastOrNull() == answer
    val over: Boolean get() = won || guesses.size >= FiveLetters.TRIES
}

@Serializable
internal data class FiveLettersStats(
    val played: Int = 0,
    val wins: Int = 0,
    val streak: Int = 0,
    val bestStreak: Int = 0,
    /** Puzzle number of the last daily finished, for continuing a streak. */
    val lastDaily: Int = 0,
    /** Wins by number of guesses, index 0 = solved in one. */
    val distribution: List<Int> = List(FiveLetters.TRIES) { 0 },
    val practicePlayed: Int = 0,
    val practiceWins: Int = 0,
) {
    /**
     * Count a finished game. Only the daily puzzle moves the streak and distribution:
     * practice words are unlimited, so letting them count would make the streak meaningless.
     */
    fun record(game: FiveLettersState): FiveLettersStats {
        if (!game.daily) {
            return copy(practicePlayed = practicePlayed + 1, practiceWins = practiceWins + if (game.won) 1 else 0)
        }
        val continues = lastDaily == game.puzzle - 1
        val nextStreak = if (game.won) (if (continues) streak + 1 else 1) else 0
        val dist = distribution.toMutableList().also { while (it.size < FiveLetters.TRIES) it.add(0) }
        if (game.won) dist[game.guesses.size - 1]++
        return copy(
            played = played + 1,
            wins = wins + if (game.won) 1 else 0,
            streak = nextStreak,
            bestStreak = maxOf(bestStreak, nextStreak),
            lastDaily = game.puzzle,
            distribution = dist,
        )
    }

    /** The streak as it stands today: a missed day breaks it even before the next game. */
    fun currentStreak(todayPuzzle: Int): Int = if (lastDaily >= todayPuzzle - 1) streak else 0
}
