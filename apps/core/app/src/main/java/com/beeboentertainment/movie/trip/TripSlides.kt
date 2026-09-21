package com.beeboentertainment.movie.trip

/**
 * Which names a slide may show. Present mode on the host's own screen shows names exactly as they
 * were typed. A video that leaves the phone follows the design's default instead: a guest shows
 * as "a friend" unless the host ticked their name (see [only]).
 */
internal class NameMask private constructor(private val allowed: Set<String>?) {

    fun apply(name: String): String =
        if (allowed == null || TripLogic.key(name) in allowed) name.trim() else PLACEHOLDER

    /** Masked and de-duplicated, so two hidden guests read as one "a friend", not two. */
    fun all(names: List<String>): List<String> = names.map(::apply).distinct()

    companion object {
        const val PLACEHOLDER = "a friend"
        val ShowAll = NameMask(null)
        fun only(shown: Collection<String>): NameMask = NameMask(shown.map { TripLogic.key(it) }.toSet())
    }
}

internal enum class SlideKind { COVER, GAMES, RESULTS, STORY, HUNT, BADGES, PACKING, PHOTO, VIDEO, ROAD }

/**
 * One screen of the slideshow, as plain data. Present mode draws it with Compose and the MP4 export
 * draws the very same slide onto a bitmap, so the two cannot drift apart.
 */
internal data class Slide(
    val kind: SlideKind,
    val title: String = "",
    val subtitle: String = "",
    val lines: List<String> = emptyList(),
    val body: String = "",
    val media: TripMedia? = null,
)

internal object TripSlides {

    private const val MAX_STORY_SLIDES = 6
    private const val MAX_RESULT_SLIDES = 2
    private const val RESULTS_PER_SLIDE = 6
    private const val EXCERPT_CHARS = 420
    private const val CREW_NAMES_SHOWN = 6

    /**
     * The deck in the order the design gives: cover, games and winners, stories, badges, packing,
     * then the picked photos and videos. A section with nothing in it is left out rather than shown
     * empty, so a trip with no stories has no stories slide.
     */
    fun build(
        summary: TripSummary,
        media: List<TripMedia>,
        mask: NameMask = NameMask.ShowAll,
        now: Long = System.currentTimeMillis(),
    ): List<Slide> = buildList {
        add(cover(summary, media.isNotEmpty(), mask, now))
        addAll(games(summary, mask))
        addAll(stories(summary, mask))
        hunt(summary, mask)?.let { add(it) }
        road(summary, now)?.let { add(it) }
        badges(summary)?.let { add(it) }
        packing(summary)?.let { add(it) }
        media.forEach { add(Slide(if (it.video) SlideKind.VIDEO else SlideKind.PHOTO, media = it)) }
    }

    fun cover(summary: TripSummary, hasMedia: Boolean, mask: NameMask, now: Long): Slide {
        val trip = summary.trip
        val lines = mutableListOf<String>()
        lines += if (trip.running) "Trip in progress" else TripFormat.length(trip.startedAt, trip.endedAt, now)
        crew(summary.roster, mask)?.let { lines += it }
        if (summary.isEmpty && !hasMedia) lines += "Nothing has been recorded on this trip yet."
        return Slide(
            SlideKind.COVER,
            title = trip.name,
            subtitle = TripFormat.dateRange(trip.startedAt, trip.endedAt, now),
            lines = lines,
        )
    }

    /** "With Ana, Ben and 2 more", or null with nobody on the roster. */
    fun crew(roster: List<String>, mask: NameMask): String? {
        val names = mask.all(roster)
        if (names.isEmpty()) return null
        val shown = names.take(CREW_NAMES_SHOWN)
        val more = names.size - shown.size
        return when {
            more > 0 -> "With " + shown.joinToString(", ") + " and $more more"
            shown.size == 1 -> "With " + shown[0]
            else -> "With " + shown.dropLast(1).joinToString(", ") + " and " + shown.last()
        }
    }

    private fun games(summary: TripSummary, mask: NameMask): List<Slide> {
        if (summary.gameCount == 0 && summary.thisOrThatRounds == 0) return emptyList()
        val head = mutableListOf<String>()
        summary.tally.take(5).forEach { head += "${mask.apply(it.name)} · ${plural(it.wins, "win")}" }
        summary.champions.take(3).forEach { head += "${it.game} champion: ${mask.apply(it.name)}" }
        if (summary.thisOrThatRounds > 0) head += "This or That · ${plural(summary.thisOrThatRounds, "round")}"
        val slides = mutableListOf(
            Slide(
                SlideKind.GAMES,
                title = "Games & winners",
                subtitle = if (summary.gameCount > 0) "${plural(summary.gameCount, "game")} played" else "",
                lines = head,
            ),
        )
        val recent = summary.games.takeLast(RESULTS_PER_SLIDE * MAX_RESULT_SLIDES)
        recent.chunked(RESULTS_PER_SLIDE).forEachIndexed { i, chunk ->
            slides += Slide(
                SlideKind.RESULTS,
                title = if (i == 0) "Game night results" else "More results",
                lines = chunk.map { resultLine(it, mask) },
            )
        }
        return slides
    }

    fun resultLine(game: GameLine, mask: NameMask): String {
        val who = when {
            game.winners.isNotEmpty() -> mask.all(game.winners).joinToString(" & ") + " won"
            game.outcome == "draw" -> "a draw"
            game.botWon -> "the computer won"
            else -> "finished"
        }
        return "${game.title} · $who"
    }

    private fun stories(summary: TripSummary, mask: NameMask): List<Slide> =
        summary.stories.take(MAX_STORY_SLIDES).map { story ->
            val told = mask.all(story.names)
            Slide(
                SlideKind.STORY,
                title = story.title,
                subtitle = listOfNotNull(
                    story.mood.takeIf { it.isNotBlank() },
                    told.takeIf { it.isNotEmpty() }?.let { "told by " + it.joinToString(", ") },
                ).joinToString(" · "),
                body = excerpt(story.text, EXCERPT_CHARS),
            )
        }

    private fun hunt(summary: TripSummary, mask: NameMask): Slide? {
        if (summary.hunt.isEmpty()) return null
        return Slide(
            SlideKind.HUNT,
            title = "Scavenger hunt",
            subtitle = "${plural(summary.hunt.size, "waypoint")} found",
            lines = summary.hunt.take(8).map { h ->
                val by = mask.all(h.names).joinToString(" & ")
                if (by.isEmpty()) h.title else "${h.title} · found by $by"
            },
        )
    }

    /** "On the road": the Trip Clock's stops and arrival, and the plate and sign hunts. Counts only. */
    private fun road(summary: TripSummary, now: Long): Slide? {
        if (summary.tallies.isEmpty() && summary.stops.isEmpty() && summary.arrivedAt == 0L && summary.quietNights == 0) return null
        val lines = mutableListOf<String>()
        summary.tallies.take(4).forEach { lines += it.text.ifBlank { it.title } }
        summary.stops.take(6).forEach { lines += "Stop: " + it.title }
        if (summary.arrivedAt > 0L) lines += "Arrived " + TripFormat.dateRange(summary.arrivedAt, summary.arrivedAt, now)
        if (summary.quietNights > 0) lines += "Quiet hours kept: " + plural(summary.quietNights, "night")
        return Slide(SlideKind.ROAD, title = "On the road", subtitle = "", lines = lines)
    }

    private fun badges(summary: TripSummary): Slide? {
        if (summary.badges.isEmpty()) return null
        return Slide(
            SlideKind.BADGES,
            title = "Badges earned",
            subtitle = "${plural(summary.badges.size, "new badge")} this trip",
            lines = summary.badges.map { it.title },
        )
    }

    private fun packing(summary: TripSummary): Slide? {
        val p = summary.packing ?: return null
        val lines = mutableListOf<String>()
        if (p.atDepart.total > 0) lines += "Leaving: ${p.atDepart.packed} of ${p.atDepart.total} items packed"
        val back = p.atReturn
        if (back != null && back.total > 0) lines += "Back home: ${back.packed} of ${back.total} items ticked"
        if (p.leftUnpacked.isNotEmpty()) {
            val shown = p.leftUnpacked.take(4)
            val more = p.leftUnpacked.size - shown.size
            lines += "Left unpacked: " + shown.joinToString(", ") + if (more > 0) " and $more more" else ""
        }
        if (lines.isEmpty()) return null
        return Slide(SlideKind.PACKING, title = "Packing", lines = lines)
    }

    /** [text] cut at a word boundary to at most [max] characters, with an ellipsis when cut. */
    fun excerpt(text: String, max: Int): String {
        val clean = text.replace(Regex("\\s+"), " ").trim()
        if (clean.length <= max) return clean
        val cut = clean.take(max)
        val at = cut.lastIndexOf(' ')
        return (if (at > max / 2) cut.take(at) else cut).trimEnd(',', ';', ':', '-') + "…"
    }

    fun plural(n: Int, word: String): String = if (n == 1) "1 $word" else "$n ${word}s"
}
