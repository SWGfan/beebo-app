package com.beeboentertainment.movie.campsite.hunt

import com.beeboentertainment.movie.campsite.family.FamilyText
import com.beeboentertainment.movie.campsite.games.CampfireWordFilter

/**
 * The only free text a guest ever types in this feature is a nickname, and it appears on every
 * phone's leaderboard, so it is cleaned on the host before anything else sees it:
 *
 *  1. control, invisible and markup-significant characters are removed and the length is cut
 *     ([FamilyText.name]); the pages still draw it with textContent, so this is the second line;
 *  2. a name that looks like contact details (a link, an at-sign, a long run of digits) is replaced;
 *  3. a name on the small deny list, or one the campfire word filter flags, is replaced, also when
 *     spelled with look-alike digits or symbols, spaces or dots between letters.
 *
 * "Replaced" means the guest becomes "Camper 2" (the next free number). Nothing is stored anywhere.
 * This is a modest guard for a family circle, not a moderation system, and it does not claim to be.
 */
internal object HuntNames {

    /** Beyond [CampfireWordFilter]: names that never belong on a family leaderboard. */
    private val DENY = listOf(
        "nazi", "hitler", "rape", "rapist", "porn", "pedo", "suicide", "kill", "killer", "murder", "terrorist",
        "stupid", "idiot", "dumb", "hate", "sex", "sexy", "boob", "boobs", "penis", "vagina", "anal", "cum",
    )

    /** Words this long or longer are also caught inside a run of letters ("xxkillerxx"). Shorter ones only as whole words. */
    private const val SUBSTRING_MIN = 5

    private val LEET = mapOf('0' to 'o', '1' to 'i', '3' to 'e', '4' to 'a', '5' to 's', '7' to 't', '$' to 's', '@' to 'a', '!' to 'i')

    /** Remove format characters (zero-width spaces, direction marks) that [FamilyText.name] leaves alone. */
    private fun stripInvisible(s: String): String = s.filter {
        val t = Character.getType(it)
        t != Character.FORMAT.toInt() && t != Character.PRIVATE_USE.toInt() && t != Character.SURROGATE.toInt() &&
            t != Character.UNASSIGNED.toInt() && t != Character.LINE_SEPARATOR.toInt() && t != Character.PARAGRAPH_SEPARATOR.toInt()
    }

    private fun looksLikeContact(s: String): Boolean {
        val lower = s.lowercase()
        if (lower.contains("http") || lower.contains("www.") || lower.contains('@') || lower.contains(".com") || lower.contains(".ca")) return true
        return Regex("\\d{5,}").containsMatchIn(s.replace(Regex("[\\s.\\-()]"), ""))
    }

    private fun squashed(s: String): String =
        s.lowercase().map { LEET[it] ?: it }.filter { it in 'a'..'z' }.joinToString("")

    private fun tokens(s: String): Set<String> =
        s.lowercase().map { LEET[it] ?: it }.joinToString("").split(Regex("[^a-z]+")).filter { it.isNotEmpty() }.toSet()

    /** True when [name] should not be shown. */
    fun flagged(name: String): Boolean {
        if (looksLikeContact(name)) return true
        if (CampfireWordFilter.flags(name) || CampfireWordFilter.flags(tokens(name).joinToString(" "))) return true
        val toks = tokens(name)
        if (DENY.any { it in toks }) return true
        val run = squashed(name)
        return DENY.any { it.length >= SUBSTRING_MIN && run.contains(it) } ||
            listOf("fuck", "shit", "bitch", "cunt", "whore").any { run.contains(it) }
    }

    /** A name that is safe to show, or [fallback] when the typed one is blank or flagged. */
    fun clean(raw: String, fallback: String): String {
        val name = FamilyText.name(stripInvisible(raw), 24, "")
        return if (name.isBlank() || flagged(name)) fallback else name
    }

    /** [name] made unique among [taken] by adding " 2", " 3" and so on (compared without case). */
    fun unique(name: String, taken: Collection<String>): String {
        val lowered = taken.map { it.lowercase() }.toSet()
        if (name.lowercase() !in lowered) return name
        var n = 2
        while (true) {
            val candidate = name.take(21) + " " + n
            if (candidate.lowercase() !in lowered) return candidate
            n++
        }
    }
}
