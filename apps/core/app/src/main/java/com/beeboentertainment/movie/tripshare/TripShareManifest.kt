package com.beeboentertainment.movie.tripshare

import com.beeboentertainment.movie.trip.MomentKind
import com.beeboentertainment.movie.trip.NameMask
import com.beeboentertainment.movie.trip.SlideKind
import com.beeboentertainment.movie.trip.TripFormat
import com.beeboentertainment.movie.trip.TripMedia
import com.beeboentertainment.movie.trip.TripSlides
import com.beeboentertainment.movie.trip.TripSummary
import kotlinx.serialization.Serializable
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/*
 * The trip as plain data for the page a link opens. The computer that serves it treats all of it as
 * untrusted text (it caps lengths, strips control characters, escapes everything it prints and has no
 * script on the page), so nothing here needs to be HTML-safe; it only has to say what happened.
 */

@Serializable
data class ShareMedia(val sha: String, val w: Int = 0, val h: Int = 0, val caption: String = "")

@Serializable
data class ShareItem(
    /** departed, home, game, story, hunt, badge, packing, photo or video. */
    val kind: String,
    val at: Long = 0L,
    val title: String = "",
    val text: String = "",
    val lines: List<String> = emptyList(),
    val media: ShareMedia? = null,
)

@Serializable
data class ShareDay(val label: String, val items: List<ShareItem>)

@Serializable
data class SharePlace(val label: String, val lat: Double, val lng: Double)

@Serializable
data class ShareSong(val sha: String, val title: String = "")

@Serializable
data class ShareManifest(
    val title: String,
    val dates: String = "",
    val crew: String = "",
    val stats: List<String> = emptyList(),
    val days: List<ShareDay> = emptyList(),
    val undated: List<ShareItem> = emptyList(),
    val places: List<SharePlace> = emptyList(),
    val song: ShareSong? = null,
)

/** A photo or clip that is now on the computer: the pick, the hash it was stored under, and its size in pixels. */
internal data class SharedMedia(val media: TripMedia, val sha: String, val w: Int = 0, val h: Int = 0)

internal object TripShareManifestBuilder {

    private const val STORY_CHARS = 2000

    /**
     * Builds the page's content.
     *
     * What follows the sender's choices, not the phone's convenience:
     *  - guests read as "a friend" unless their name is in [ShareOptions.shownNames];
     *  - hunt places are added only when [ShareOptions.includeLocation] is on (and only if the trip
     *    saved them, which is its own opt-in);
     *  - the song is added only when [ShareOptions.includeSong] is on and a song was sent.
     */
    fun build(
        summary: TripSummary,
        media: List<SharedMedia>,
        options: ShareOptions,
        song: ShareSong? = null,
        now: Long = System.currentTimeMillis(),
        zone: TimeZone = TimeZone.getDefault(),
        locale: Locale = Locale.getDefault(),
    ): ShareManifest {
        val trip = summary.trip
        val mask = NameMask.only(options.shownNames)
        val dated = ArrayList<ShareItem>()
        val undated = ArrayList<ShareItem>()
        fun add(item: ShareItem) { if (item.at > 0L) dated += item else undated += item }

        add(ShareItem("departed", at = trip.startedAt, title = "We set off"))
        summary.games.forEach { g -> add(ShareItem("game", at = g.endedAt, title = TripSlides.resultLine(g, mask))) }
        summary.stories.forEach { s ->
            val told = mask.all(s.names)
            add(
                ShareItem(
                    "story", at = s.at, title = s.title,
                    text = TripSlides.excerpt(s.text, STORY_CHARS),
                    lines = if (told.isEmpty()) emptyList() else listOf("Told by " + told.joinToString(", ")),
                ),
            )
        }
        summary.hunt.forEach { h ->
            val by = mask.all(h.names).joinToString(" & ")
            add(ShareItem("hunt", at = h.at, title = "Found: ${h.title}", lines = if (by.isEmpty()) emptyList() else listOf("Found by $by")))
        }
        if (!trip.running && trip.endedAt > 0L) {
            add(ShareItem("home", at = trip.endedAt, title = "Home again", lines = listOf("After " + TripFormat.length(trip.startedAt, trip.endedAt, now))))
        }

        // Badges and packing already have their wording in the slideshow deck; reuse it word for word.
        TripSlides.build(summary, emptyList(), mask, now).forEach { slide ->
            when (slide.kind) {
                SlideKind.BADGES -> undated += ShareItem("badge", title = slide.title, lines = slide.lines)
                SlideKind.PACKING -> undated += ShareItem("packing", title = slide.title, lines = slide.lines)
                else -> Unit
            }
        }

        media.take(ShareDefaults.MAX_MEDIA).forEach { m ->
            val t = m.media.takenAt
            val caption = if (t > 0L) format("EEE d MMM, h:mm a", t, zone, locale) else ""
            add(
                ShareItem(
                    kind = if (m.media.video) "video" else "photo", at = t,
                    media = ShareMedia(m.sha, m.w, m.h, caption.take(ShareDefaults.CAPTION_MAX)),
                ),
            )
        }

        val dayKey = { ms: Long -> format("yyyyMMdd", ms, zone, locale) }
        val days = dated.sortedBy { it.at }.groupBy { dayKey(it.at) }.toSortedMap().map { (_, items) ->
            ShareDay(format("EEEE d MMMM", items.first().at, zone, locale), items)
        }

        val places = if (options.includeLocation) {
            trip.moments.filter { it.kind == MomentKind.HUNT && it.lat != null && it.lng != null }
                .map { SharePlace(it.title, it.lat!!, it.lng!!) }
        } else emptyList()

        val photos = media.count { !it.media.video }
        val clips = media.count { it.media.video }
        val stats = listOfNotNull(
            summary.gameCount.takeIf { it > 0 }?.let { TripSlides.plural(it, "game") + " played" },
            summary.stories.size.takeIf { it > 0 }?.let { TripSlides.plural(it, "story").replace("storys", "stories") },
            photos.takeIf { it > 0 }?.let { TripSlides.plural(it, "photo") },
            clips.takeIf { it > 0 }?.let { TripSlides.plural(it, "clip") },
            summary.badges.size.takeIf { it > 0 }?.let { TripSlides.plural(it, "badge") },
        )

        return ShareManifest(
            title = trip.name,
            dates = TripFormat.dateRange(trip.startedAt, trip.endedAt, now, locale, zone),
            crew = TripSlides.crew(summary.roster, mask).orEmpty(),
            stats = stats,
            days = days,
            undated = undated,
            places = places,
            song = if (options.includeSong) song else null,
        )
    }

    private fun format(pattern: String, ms: Long, zone: TimeZone, locale: Locale): String =
        SimpleDateFormat(pattern, locale).apply { timeZone = zone }.format(Date(ms))
}
