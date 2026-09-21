package com.beeboentertainment.movie.campsite.games

/**
 * A deliberately small, host-side word mask for things guests type that the whole
 * circle will read out loud (Two Truths and a Lie statements).
 *
 * The app had no profanity filter to reuse, so this is the modest built-in list the
 * activity asked for: a handful of common English swear words, matched as whole words
 * (case-insensitive, allowing a trailing plural or -ing/-ed), and replaced letter for
 * letter with asterisks except the first letter. It is not a moderation system and
 * does not pretend to be one - the people typing are sitting in the same circle.
 *
 * WHY WHOLE WORDS: substring matching is how "Scunthorpe" and "grass" get starred out.
 */
internal object CampfireWordFilter {

    private val WORDS = listOf(
        "fuck", "fucker", "fucking", "shit", "shitty", "bullshit", "bitch", "bastard",
        "asshole", "arsehole", "dick", "dickhead", "cunt", "twat", "wanker", "prick",
        "piss", "pissed", "crap", "damn", "goddamn", "slut", "whore", "motherfucker",
    )

    private val PATTERN = Regex(
        "\\b(" + WORDS.sortedByDescending { it.length }.joinToString("|") { Regex.escape(it) } + ")(s|es|ed|ing)?\\b",
        RegexOption.IGNORE_CASE,
    )

    /** The text with each listed word masked, e.g. "shit" -> "s***". */
    fun mask(text: String): String = PATTERN.replace(text) { match ->
        val word = match.value
        word.first() + "*".repeat(word.length - 1)
    }

    /** True if [mask] would change anything. */
    fun flags(text: String): Boolean = PATTERN.containsMatchIn(text)
}
