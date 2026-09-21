package com.beeboentertainment.movie.core

/**
 * The A–Z jump bar that sits above the Movies and TV grids.
 *
 * Two rules matter and they have to agree with each other, or tapping a letter lands in the
 * wrong place:
 *   1. the list is sorted by [sortKey]
 *   2. a title is filed under the first character of that same [sortKey]
 *
 * Because of that the app sorts the list itself rather than trusting the order the server
 * happened to send, which also guarantees each letter's run is contiguous.
 *
 * Bucketing is the first character of the title, matching the website exactly: "The Matrix"
 * files under T, not M. Leading articles are NOT stripped (the [ignoreArticles] flag exists but
 * defaults to false, so the two implementations cannot drift). Anything that doesn't start with
 * a letter (digits, punctuation, "…And Justice For All") files under '#'.
 */
object AlphaIndex {

    const val OTHER = '#'

    /** The bar's contents: '#' first, then A–Z. */
    val LETTERS: List<Char> = listOf(OTHER) + ('A'..'Z').toList()

    private val ARTICLES = listOf("the ", "a ", "an ")

    /**
     * Normalised key used for BOTH sorting and bucketing.
     * Strips leading punctuation/whitespace, folds accents, and upper-cases.
     * Leading articles are kept, because the website buckets on the literal first character.
     */
    fun sortKey(title: String?, ignoreArticles: Boolean = false): String {
        var s = title.orEmpty().trim()
        if (s.isEmpty()) return ""
        s = foldAccents(s)
        // drop leading quotes/brackets/ellipses so "…And Justice" and "'71" behave predictably
        s = s.trimStart { !it.isLetterOrDigit() }
        if (ignoreArticles) {
            val lower = s.lowercase()
            for (a in ARTICLES) {
                if (lower.startsWith(a)) {
                    s = s.substring(a.length).trimStart()
                    break
                }
            }
        }
        return s.uppercase()
    }

    /** Which bucket a title belongs in. */
    fun letterFor(title: String?, ignoreArticles: Boolean = false): Char {
        val key = sortKey(title, ignoreArticles)
        val c = key.firstOrNull() ?: return OTHER
        return if (c in 'A'..'Z') c else OTHER
    }

    /** Sort a list of anything by its title, using the same key the index buckets on. */
    fun <T> sorted(items: List<T>, ignoreArticles: Boolean = false, titleOf: (T) -> String?): List<T> =
        items.sortedWith(
            compareBy({ sortKey(titleOf(it), ignoreArticles) }, { titleOf(it).orEmpty().uppercase() })
        )

    /** Letters that actually have something behind them; everything else is dimmed in the bar. */
    fun <T> availableLetters(items: List<T>, ignoreArticles: Boolean = false, titleOf: (T) -> String?): Set<Char> =
        items.mapTo(LinkedHashSet()) { letterFor(titleOf(it), ignoreArticles) }

    /**
     * Group an ALREADY-SORTED list into letter sections, in bar order.
     * Empty sections are omitted, so the grid never shows a header with nothing under it.
     */
    fun <T> sections(
        sortedItems: List<T>,
        ignoreArticles: Boolean = false,
        titleOf: (T) -> String?
    ): List<Pair<Char, List<T>>> {
        if (sortedItems.isEmpty()) return emptyList()
        val out = LinkedHashMap<Char, MutableList<T>>()
        for (item in sortedItems) {
            out.getOrPut(letterFor(titleOf(item), ignoreArticles)) { mutableListOf() }.add(item)
        }
        // Preserve bar order ('#' then A–Z) rather than encounter order.
        return LETTERS.mapNotNull { letter -> out[letter]?.let { letter to it.toList() } }
    }

    /**
     * Position of a letter's first item within the flat sorted list — what the jump bar scrolls to.
     * Returns -1 when the letter has nothing behind it.
     */
    fun <T> firstIndexOf(
        sortedItems: List<T>,
        letter: Char,
        ignoreArticles: Boolean = false,
        titleOf: (T) -> String?
    ): Int = sortedItems.indexOfFirst { letterFor(titleOf(it), ignoreArticles) == letter }

    /**
     * Where each letter's header sits in a LazyGrid that renders one full-width header item
     * followed by that section's tiles. This is what a tap on the A–Z bar scrolls to.
     */
    fun <T> headerIndices(sections: List<Pair<Char, List<T>>>): Map<Char, Int> {
        val out = LinkedHashMap<Char, Int>()
        var cursor = 0
        for ((letter, items) in sections) {
            out[letter] = cursor
            cursor += 1 + items.size   // the header itself, then its tiles
        }
        return out
    }

    /** Minimal accent folding — enough for "Amélie" to file under A and sort near "Amelia". */
    private fun foldAccents(s: String): String {
        val sb = StringBuilder(s.length)
        for (ch in s) {
            val idx = ACCENTED.indexOf(ch)
            sb.append(if (idx >= 0) PLAIN[idx] else ch)
        }
        return sb.toString()
    }

    private const val ACCENTED = "ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÇçÑñÝýÿ"
    private const val PLAIN =    "AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuCcNnYyy"
}
