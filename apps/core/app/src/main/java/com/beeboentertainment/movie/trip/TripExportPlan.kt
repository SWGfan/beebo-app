package com.beeboentertainment.movie.trip

/** Output size of the exported video. 1080p is the ceiling; 720p is for slower phones and smaller files. */
enum class ExportQuality(val label: String, val width: Int, val height: Int) {
    P1080("1080p", 1920, 1080),
    P720("720p", 1280, 720),
}

/** What the person chose on the export screen. */
internal data class ExportSettings(
    val quality: ExportQuality = ExportQuality.P1080,
    /** Off by default. When on, the only sound is the synthesized campfire ambience. */
    val ambience: Boolean = false,
    /** Names the host ticked to appear on the cards. Everyone else reads as "a friend". */
    val shownNames: Set<String> = emptySet(),
    /** Include photos and videos dated outside the trip. */
    val includeOutsideMedia: Boolean = false,
)

internal sealed interface PlanItem {
    val durationMs: Long

    /** A title, summary or story card, drawn to a bitmap. */
    data class Card(val slide: Slide, override val durationMs: Long) : PlanItem

    data class Photo(val media: TripMedia, override val durationMs: Long) : PlanItem

    /** The first [durationMs] of a video, from [startMs]. */
    data class Video(val media: TripMedia, val startMs: Long, override val durationMs: Long) : PlanItem
}

internal data class ExportPlan(
    val items: List<PlanItem>,
    val width: Int,
    val height: Int,
    val ambience: Boolean,
    /** Photos or videos left out to keep the video a sensible length. */
    val skippedMedia: Int,
) {
    val totalMs: Long get() = items.sumOf { it.durationMs }
}

/**
 * Turns the slides into a timeline for the encoder: how long each card, photo and clip is on
 * screen. Pure, so the timing rules are tested without encoding anything.
 *
 * The length is capped because encoding runs at roughly real time on a phone: a two-hour video
 * would be a two-hour wait with the phone hot. Cards are never dropped; extra photos and clips are,
 * from the end, and the plan says how many.
 */
internal object TripExportPlanner {

    const val CARD_MS = 5_000L
    const val COVER_MS = 6_000L
    const val PHOTO_MS = 4_000L
    const val CLIP_MAX_MS = 5_000L
    const val CLIP_MIN_MS = 1_000L
    const val MAX_TOTAL_MS = 12 * 60_000L
    const val MAX_MEDIA_ITEMS = 150

    private const val STORY_MIN_MS = 6_000L
    private const val STORY_LEAD_MS = 3_000L
    private const val STORY_MAX_MS = 20_000L
    private const val MS_PER_WORD = 250L

    /**
     * @param videoDurationMs the real length of a picked video in milliseconds, or null when it
     *   could not be read. A clip is never planned longer than the video itself.
     */
    fun plan(
        slides: List<Slide>,
        settings: ExportSettings,
        videoDurationMs: (TripMedia) -> Long? = { null },
    ): ExportPlan {
        val cards = slides.filter { it.media == null }.map { PlanItem.Card(it, cardMs(it)) }
        var budget = MAX_TOTAL_MS - cards.sumOf { it.durationMs }
        var skipped = 0
        val mediaItems = mutableListOf<PlanItem>()
        slides.filter { it.media != null }.forEachIndexed { index, slide ->
            val media = slide.media ?: return@forEachIndexed
            val item = if (media.video) clip(media, videoDurationMs(media)) else PlanItem.Photo(media, PHOTO_MS)
            if (item == null || index >= MAX_MEDIA_ITEMS || item.durationMs > budget) {
                skipped++
            } else {
                budget -= item.durationMs
                mediaItems += item
            }
        }
        // Cards come first in the deck and the media follow, exactly as the slides are ordered.
        return ExportPlan(
            items = cards + mediaItems,
            width = settings.quality.width,
            height = settings.quality.height,
            ambience = settings.ambience,
            skippedMedia = skipped,
        )
    }

    fun cardMs(slide: Slide): Long = when (slide.kind) {
        SlideKind.COVER -> COVER_MS
        SlideKind.STORY -> {
            val words = slide.body.split(Regex("\\s+")).count { it.isNotBlank() }
            (STORY_LEAD_MS + words * MS_PER_WORD).coerceIn(STORY_MIN_MS, STORY_MAX_MS)
        }
        else -> CARD_MS
    }

    /** null when the video is too short to be worth a clip (or empty). */
    private fun clip(media: TripMedia, realMs: Long?): PlanItem.Video? {
        val length = if (realMs == null) CLIP_MAX_MS else minOf(realMs, CLIP_MAX_MS)
        return if (length < CLIP_MIN_MS) null else PlanItem.Video(media, startMs = 0L, durationMs = length)
    }
}
