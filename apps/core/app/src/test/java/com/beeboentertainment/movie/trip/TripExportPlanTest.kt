package com.beeboentertainment.movie.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The export timeline as pure data: how long each thing is on screen, and what gets left out. */
class TripExportPlanTest {

    private fun cards(vararg kinds: SlideKind) = kinds.map { Slide(it, title = it.name) }
    private fun photo(n: Int) = Slide(SlideKind.PHOTO, media = TripMedia("content://p/$n", false, n.toLong()))
    private fun video(n: Int) = Slide(SlideKind.VIDEO, media = TripMedia("content://v/$n", true, n.toLong()))

    private val settings = ExportSettings()

    @Test
    fun `cards then photos and clips, each with its own duration`() {
        val slides = cards(SlideKind.COVER, SlideKind.GAMES) + photo(1) + video(1)
        val plan = TripExportPlanner.plan(slides, settings) { 30_000L }
        assertEquals(
            listOf(TripExportPlanner.COVER_MS, TripExportPlanner.CARD_MS, TripExportPlanner.PHOTO_MS, TripExportPlanner.CLIP_MAX_MS),
            plan.items.map { it.durationMs },
        )
        assertEquals(TripExportPlanner.COVER_MS + TripExportPlanner.CARD_MS + TripExportPlanner.PHOTO_MS + TripExportPlanner.CLIP_MAX_MS, plan.totalMs)
    }

    @Test
    fun `a long video is trimmed to a few seconds from the start`() {
        val plan = TripExportPlanner.plan(listOf(video(1)), settings) { 90_000L }
        val clip = plan.items.single() as PlanItem.Video
        assertEquals(0L, clip.startMs)
        assertEquals(5_000L, clip.durationMs)
    }

    @Test
    fun `a short video is kept whole and a tiny one is dropped`() {
        val short = TripExportPlanner.plan(listOf(video(1)), settings) { 2_500L }.items.single() as PlanItem.Video
        assertEquals(2_500L, short.durationMs)
        val tiny = TripExportPlanner.plan(listOf(video(1)), settings) { 400L }
        assertTrue(tiny.items.isEmpty())
        assertEquals(1, tiny.skippedMedia)
    }

    @Test
    fun `a video whose length cannot be read is assumed long enough for a full clip`() {
        val clip = TripExportPlanner.plan(listOf(video(1)), settings) { null }.items.single() as PlanItem.Video
        assertEquals(TripExportPlanner.CLIP_MAX_MS, clip.durationMs)
    }

    @Test
    fun `the video is capped in length and extra media is dropped from the end, never a card`() {
        val slides = cards(SlideKind.COVER, SlideKind.GAMES) + (1..1000).map { photo(it) }
        val plan = TripExportPlanner.plan(slides, settings)
        assertTrue(plan.totalMs <= TripExportPlanner.MAX_TOTAL_MS)
        assertEquals(2, plan.items.count { it is PlanItem.Card })
        assertTrue(plan.skippedMedia > 0)
        assertEquals(1000, plan.items.count { it is PlanItem.Photo } + plan.skippedMedia)
        // The photos that made it are the first ones.
        val kept = plan.items.filterIsInstance<PlanItem.Photo>().map { it.media.uri }
        assertEquals((1..kept.size).map { "content://p/$it" }, kept)
    }

    @Test
    fun `no more than the media item limit is planned`() {
        val plan = TripExportPlanner.plan((1..400).map { photo(it) }, settings)
        assertTrue(plan.items.size <= TripExportPlanner.MAX_MEDIA_ITEMS)
    }

    @Test
    fun `a story card stays up longer the more it says, within bounds`() {
        val short = TripExportPlanner.cardMs(Slide(SlideKind.STORY, body = "Once."))
        val medium = TripExportPlanner.cardMs(Slide(SlideKind.STORY, body = "word ".repeat(20)))
        val huge = TripExportPlanner.cardMs(Slide(SlideKind.STORY, body = "word ".repeat(2000)))
        assertEquals(6_000L, short)
        assertEquals(8_000L, medium)
        assertEquals(20_000L, huge)
    }

    @Test
    fun `quality sets the frame size and 1080p is the ceiling`() {
        val p1080 = TripExportPlanner.plan(cards(SlideKind.COVER), ExportSettings(quality = ExportQuality.P1080))
        val p720 = TripExportPlanner.plan(cards(SlideKind.COVER), ExportSettings(quality = ExportQuality.P720))
        assertEquals(1920 to 1080, p1080.width to p1080.height)
        assertEquals(1280 to 720, p720.width to p720.height)
        assertTrue(ExportQuality.entries.all { it.height <= 1080 })
    }

    @Test
    fun `audio is off unless asked for`() {
        assertFalse(ExportSettings().ambience)
        assertFalse(TripExportPlanner.plan(cards(SlideKind.COVER), ExportSettings()).ambience)
        assertTrue(TripExportPlanner.plan(cards(SlideKind.COVER), ExportSettings(ambience = true)).ambience)
    }

    @Test
    fun `an empty deck plans to nothing`() {
        assertTrue(TripExportPlanner.plan(emptyList(), settings).items.isEmpty())
    }

    // ---- picture sizing ------------------------------------------------------------------

    @Test
    fun `a photo is fitted inside the frame without cropping and centred`() {
        val landscape = FrameMath.fit(4000, 3000, 1920, 1080)
        assertEquals(1440f, landscape.width, 0.5f)
        assertEquals(1080f, landscape.height, 0.5f)
        assertEquals(240f, landscape.left, 0.5f)
        assertEquals(0f, landscape.top, 0.5f)

        val portrait = FrameMath.fit(3000, 4000, 1920, 1080)
        assertEquals(810f, portrait.width, 0.5f)
        assertEquals(1080f, portrait.height, 0.5f)
        assertEquals(555f, portrait.left, 0.5f)

        val wide = FrameMath.fit(4000, 1000, 1920, 1080)
        assertEquals(1920f, wide.width, 0.5f)
        assertEquals(480f, wide.height, 0.5f)
        assertEquals(300f, wide.top, 0.5f)
    }

    @Test
    fun `a photo is decoded no larger than needed`() {
        assertEquals(1, FrameMath.sampleSize(1920, 1080, 1920, 1080))
        assertEquals(2, FrameMath.sampleSize(4000, 3000, 1920, 1080))
        assertEquals(4, FrameMath.sampleSize(8000, 6000, 1920, 1080))
        assertEquals(8, FrameMath.sampleSize(12000, 9000, 1280, 720))
        assertEquals(1, FrameMath.sampleSize(800, 600, 1920, 1080))
        assertEquals(1, FrameMath.sampleSize(0, 0, 1920, 1080))
    }
}
