package com.beeboentertainment.auto.media

import java.text.Normalizer

/**
 * A copy of the phone app's VoiceSearch (apps/core .../core/VoiceSearch.kt): the car app is a
 * separate Gradle project, so it carries its own. Keep the two in step.
 *
 * "Hey Google, play Friends season 2 episode 3 on Beebo" -> which file to play.
 *
 * Pure Kotlin (no Android types) so the matching is unit tested. The Android side hands in what
 * Assistant sent (the spoken query plus any structured extras such as the title or media focus)
 * and the library lists, and gets back the best title, or null when nothing is close enough.
 * A near miss must not start the wrong film, so the bar is deliberately high.
 *
 * Parental controls: [contentFilter] is the seam. When the household's parental filter exists it
 * sets this, and anything it refuses is never matched by voice, exactly as if it were not in the
 * library.
 */
object VoiceSearch {

    enum class Focus { ANY, MOVIE, SHOW }

    data class Query(
        val title: String,
        val season: Int? = null,
        val episode: Int? = null,
        val year: Int? = null,
        val focus: Focus = Focus.ANY,
        /** "play something on Beebo" / an empty query: carry on with what they were watching. */
        val resume: Boolean = false
    )

    data class Candidate(
        val id: String,
        val title: String,
        val kind: Focus,
        val year: Int? = null
    )

    data class Match(val candidate: Candidate, val score: Double)

    /** Parental-control seam: return false to hide a title from voice search. */
    @Volatile
    var contentFilter: (Candidate) -> Boolean = { true }

    /** Minimum similarity to play something. */
    const val MIN_SCORE = 0.72

    private val NUMBER_WORDS = mapOf(
        "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6, "seven" to 7,
        "eight" to 8, "nine" to 9, "ten" to 10, "eleven" to 11, "twelve" to 12, "thirteen" to 13,
        "fourteen" to 14, "fifteen" to 15, "sixteen" to 16, "seventeen" to 17, "eighteen" to 18,
        "nineteen" to 19, "twenty" to 20, "first" to 1, "second" to 2, "third" to 3, "fourth" to 4,
        "fifth" to 5, "sixth" to 6, "seventh" to 7, "eighth" to 8, "ninth" to 9, "tenth" to 10,
        "to" to 2, "too" to 2, "for" to 4, "won" to 1
    )

    private fun number(token: String): Int? = token.toIntOrNull() ?: NUMBER_WORDS[token]

    /**
     * Turns what Assistant sent into a [Query].
     * [raw] is SearchManager.QUERY; [title] is MediaStore.EXTRA_MEDIA_TITLE when Assistant filled
     * it; [mediaFocus] is MediaStore.EXTRA_MEDIA_FOCUS (e.g. "vnd.android.cursor.item/video").
     */
    fun parse(raw: String?, title: String? = null, mediaFocus: String? = null): Query {
        var text = (raw ?: "").lowercase().trim()
        var focus = when {
            mediaFocus?.contains("tv", ignoreCase = true) == true -> Focus.SHOW
            mediaFocus?.contains("movie", ignoreCase = true) == true -> Focus.MOVIE
            else -> Focus.ANY
        }
        // Words around the title that are about the request, not the title.
        text = text
            .replace(Regex("""^(ok(ay)?|hey) google[,]?\s*"""), "")
            .replace(Regex("""\s+(on|in|using|with|from)\s+(the\s+)?beebo(\s+(app|entertainment))?\s*$"""), "")
            .replace(Regex("""^(please\s+)?(play|watch|start|put on|resume|continue|open)\s+"""), "")
            .trim()
        if (Regex("""^(the\s+)?(movie|film)\s+""").containsMatchIn(text)) {
            focus = Focus.MOVIE
            text = text.replace(Regex("""^(the\s+)?(movie|film)\s+"""), "")
        } else if (Regex("""^(the\s+)?(tv\s+show|show|series|tv\s+series)\s+""").containsMatchIn(text)) {
            focus = Focus.SHOW
            text = text.replace(Regex("""^(the\s+)?(tv\s+show|show|series|tv\s+series)\s+"""), "")
        }
        text = text.replace(Regex("""\s+(the\s+)?(movie|film)$"""), "").trim()

        var season: Int? = null
        var episode: Int? = null
        // S02E03 / s2 e3 / 2x03
        Regex("""\bs(\d{1,2})\s*e(\d{1,3})\b""").find(text)?.let {
            season = it.groupValues[1].toInt(); episode = it.groupValues[2].toInt()
            text = text.removeRange(it.range)
        }
        if (season == null) Regex("""\b(\d{1,2})x(\d{1,3})\b""").find(text)?.let {
            season = it.groupValues[1].toInt(); episode = it.groupValues[2].toInt()
            text = text.removeRange(it.range)
        }
        val word = """(\d{1,3}|[a-z]+)"""
        // "season 2 episode 3", "season two, episode three"
        if (season == null) Regex("""\bseason\s+$word[,]?\s+(and\s+)?episode\s+$word\b""").find(text)?.let { m ->
            val s = number(m.groupValues[1]); val e = number(m.groupValues[3])
            if (s != null && e != null) { season = s; episode = e; text = text.removeRange(m.range) }
        }
        // "episode 3 of season 2"
        if (season == null) Regex("""\bepisode\s+$word\s+(of|from|in)\s+season\s+$word\b""").find(text)?.let { m ->
            val e = number(m.groupValues[1]); val s = number(m.groupValues[3])
            if (s != null && e != null) { season = s; episode = e; text = text.removeRange(m.range) }
        }
        // "season 2" alone: its first episode.
        if (season == null) Regex("""\bseason\s+$word\b""").find(text)?.let { m ->
            number(m.groupValues[1])?.let { season = it; text = text.removeRange(m.range) }
        }
        // "the next episode of X" / "the latest episode of X": resume the show.
        text = text.replace(Regex("""^(the\s+)?(next|latest|last|new(est)?)\s+episode\s+of\s+"""), "")
        if (season != null) focus = Focus.SHOW
        // "episode 4 of season 1 of Friends" leaves "of friends".
        text = text.trim().replace(Regex("""^(of|from)\s+"""), "").replace(Regex("""\s+(of|from)$"""), "")

        var year: Int? = null
        Regex("""[\s(]((19|20)\d{2})\)?$""").find(text)?.let {
            val cleaned = text.removeRange(it.range).trim()
            if (cleaned.isNotBlank()) { year = it.groupValues[1].toInt(); text = cleaned }
        }
        text = text.replace(Regex("""[,.!?]+$"""), "").replace(Regex("""\s+"""), " ").trim()

        val structured = title?.trim()?.takeIf { it.isNotBlank() }
        val finalTitle = structured ?: text
        val resume = finalTitle.isBlank() || finalTitle in setOf("something", "anything", "beebo", "music", "videos")
        return Query(title = if (resume) "" else finalTitle, season = season, episode = episode, year = year, focus = focus, resume = resume)
    }

    /** Lowercase, no accents, no punctuation, "&" as "and", no leading article. */
    fun normalize(s: String): String {
        val noAccents = Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("""\p{Mn}+"""), "")
        return noAccents.lowercase()
            .replace("&", " and ")
            .replace(Regex("""\(\s*(19|20)\d{2}\s*\)"""), " ")
            .replace(Regex("""[^a-z0-9 ]"""), " ")
            .replace(Regex("""^\s*(the|a|an)\s+"""), "")
            .replace(Regex("""\s+"""), " ")
            .trim()
    }

    /** 0..1 similarity of a spoken title to a library title. */
    fun similarity(spoken: String, title: String): Double {
        val a = normalize(spoken)
        val b = normalize(title)
        if (a.isEmpty() || b.isEmpty()) return 0.0
        if (a == b) return 1.0
        if (a.replace(" ", "") == b.replace(" ", "")) return 0.98
        val editRatio = 1.0 - levenshtein(a, b).toDouble() / maxOf(a.length, b.length)
        val ta = a.split(' ').toSet()
        val tb = b.split(' ').toSet()
        val overlap = ta.intersect(tb).size.toDouble()
        val jaccard = overlap / ta.union(tb).size
        // "star wars" for "Star Wars: A New Hope" - every spoken word is in the title, which starts with it.
        val prefix = if (b.startsWith("$a ") && ta.size >= 1 && a.length >= 4) 0.8 + 0.15 * (a.length.toDouble() / b.length) else 0.0
        return maxOf(editRatio, jaccard, prefix)
    }

    /** The best library title for [query], or null when nothing clears [MIN_SCORE]. */
    fun bestMatch(query: Query, candidates: List<Candidate>): Match? {
        if (query.title.isBlank()) return null
        var best: Match? = null
        for (c in candidates) {
            if (query.focus != Focus.ANY && c.kind != query.focus) continue
            if (!runCatching { contentFilter(c) }.getOrDefault(false)) continue
            var score = similarity(query.title, c.title)
            if (query.year != null && c.year != null) score += if (query.year == c.year) 0.05 else -0.1
            // "Blade Runner 2049": the "year" may be part of the title itself.
            if (query.year != null) score = maxOf(score, similarity("${query.title} ${query.year}", c.title))
            // A season/episode was asked for: a show is the better answer on a tie.
            if (query.season != null && c.kind == Focus.SHOW) score += 0.01
            val prev = best
            if (prev == null || score > prev.score) best = Match(c, score)
        }
        return best?.takeIf { it.score >= MIN_SCORE }
    }

    data class EpisodeRef(val id: String, val season: Int?, val episode: Int?, val watchedPercent: Int = 0, val watchedAt: Long? = null)

    /**
     * Which episode of a matched show to play: the one asked for; the first of a season; or
     * otherwise where they left off (the newest part-watched episode, else the episode after the
     * newest finished one, else the very first).
     */
    fun pickEpisode(episodes: List<EpisodeRef>, season: Int?, episode: Int?): EpisodeRef? {
        if (episodes.isEmpty()) return null
        val ordered = episodes.sortedWith(compareBy<EpisodeRef>({ it.season ?: Int.MAX_VALUE }, { it.episode ?: Int.MAX_VALUE }))
        if (season != null && episode != null) return ordered.firstOrNull { it.season == season && it.episode == episode }
        if (season != null) return ordered.firstOrNull { it.season == season }
        val started = ordered.filter { it.watchedAt != null }
        val partial = started.filter { it.watchedPercent in 1..94 }.maxByOrNull { it.watchedAt ?: 0L }
        if (partial != null) return partial
        val lastDone = started.maxByOrNull { it.watchedAt ?: 0L }
        if (lastDone != null) {
            val i = ordered.indexOf(lastDone)
            return ordered.getOrNull(i + 1) ?: lastDone
        }
        return ordered.first()
    }

    /** Edit distance where swapping two neighbouring letters ("freinds") costs one edit. */
    private fun levenshtein(a: String, b: String): Int {
        var prevPrev = IntArray(b.length + 1)
        var prev = IntArray(b.length + 1) { it }
        var cur = IntArray(b.length + 1)
        for (i in 1..a.length) {
            cur[0] = i
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                var d = minOf(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) d = minOf(d, prevPrev[j - 2] + 1)
                cur[j] = d
            }
            val t = prevPrev; prevPrev = prev; prev = cur; cur = t
        }
        return prev[b.length]
    }
}
