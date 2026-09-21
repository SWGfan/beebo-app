package com.beeboentertainment.movie.tripshare

import com.beeboentertainment.movie.campsite.games.MatchPlayer
import com.beeboentertainment.movie.campsite.games.MatchRecord
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.trip.MomentKind
import com.beeboentertainment.movie.trip.PackedItem
import com.beeboentertainment.movie.trip.PackingSnapshot
import com.beeboentertainment.movie.trip.Trip
import com.beeboentertainment.movie.trip.TripMedia
import com.beeboentertainment.movie.trip.TripMoment
import com.beeboentertainment.movie.trip.TripSummaryBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale
import java.util.TimeZone

/**
 * What the shared page is told. The privacy switches are checked here on the phone's side (the
 * computer enforces them again), in particular that nothing about a place is in the data unless the
 * sender switched it on.
 */
class TripShareManifestTest {

    private val utc = TimeZone.getTimeZone("UTC")
    private val us = Locale.US
    private val hour = 3_600_000L
    private val day0 = 1_750_000_000_000L - (1_750_000_000_000L % (24 * hour)) // midnight UTC

    private val trip = Trip(
        id = "t1", name = "Lake weekend", startedAt = day0 + 9 * hour, endedAt = day0 + 2 * 24 * hour + 17 * hour,
        roster = listOf("Dad", "Ana"),
        packingAtDepart = PackingSnapshot(day0, listOf(PackedItem("Tent", true), PackedItem("Torch", false))),
        packingAtReturn = PackingSnapshot(day0 + 60 * hour, listOf(PackedItem("Tent", true), PackedItem("Torch", true))),
        moments = listOf(
            TripMoment("story-1", day0 + 20 * hour, MomentKind.STORY, "Campfire story", "The fox <b>jumped</b> over the log.", listOf("Ana", "Zed"), "Cozy"),
            TripMoment("hunt-1", day0 + 12 * hour, MomentKind.HUNT, "Big rock", names = listOf("Ana"), lat = 51.5074, lng = -0.1278),
            TripMoment("hunt-2", day0 + 13 * hour, MomentKind.HUNT, "Old tree", names = listOf("Zed")),
        ),
        saveLocation = true,
    )

    private fun p(name: String, won: Boolean = false) = MatchPlayer(name, if (won) 1 else 0, won, false)
    private val matches = listOf(
        MatchRecord("m1", "chess", "Chess", listOf(p("Ana", true), p("Zed")), "Ana", "winner", day0 + 21 * hour),
    )

    private val summary = TripSummaryBuilder.build(trip, matches, emptyList(), earnedBadgesNow = emptySet(), now = day0 + 100 * hour)

    private fun build(
        options: ShareOptions = ShareOptions(),
        media: List<SharedMedia> = emptyList(),
        song: ShareSong? = null,
    ) = TripShareManifestBuilder.build(summary, media, options, song, now = day0 + 100 * hour, zone = utc, locale = us)

    private fun allText(m: ShareManifest): String = ApiClient.JSON.encodeToString(ShareManifest.serializer(), m)

    @Test
    fun `defaults are private with no places, no song and guests hidden`() {
        val o = ShareOptions()
        assertFalse(o.includeLocation)
        assertFalse(o.includeSong)
        assertFalse(o.rightsAck)
        assertTrue(o.shownNames.isEmpty())
        assertEquals(ShareExpiry.MONTH, o.expiry)
        val m = build()
        assertTrue(m.places.isEmpty())
        assertNull(m.song)
    }

    @Test
    fun `places are added only when switched on and only where the trip saved them`() {
        val off = allText(build(ShareOptions(includeLocation = false)))
        assertFalse("no coordinates leak when off", off.contains("51.5074") || off.contains("-0.1278") || off.contains("\"lat\""))
        val on = build(ShareOptions(includeLocation = true))
        assertEquals(listOf(SharePlace("Big rock", 51.5074, -0.1278)), on.places)
    }

    @Test
    fun `the song is added only when switched on and one was sent`() {
        val song = ShareSong("a".repeat(64), "Campfire song")
        assertNull(build(ShareOptions(includeSong = false), song = song).song)
        assertEquals(song, build(ShareOptions(includeSong = true, rightsAck = true), song = song).song)
        assertNull(build(ShareOptions(includeSong = true, rightsAck = true), song = null).song)
    }

    @Test
    fun `guests read as a friend unless ticked`() {
        val hidden = allText(build())
        assertFalse(hidden.contains("Zed"))
        assertFalse(hidden.contains("Ana"))
        assertTrue(hidden.contains("a friend"))
        val shown = build(ShareOptions(shownNames = setOf("ana")))
        val text = allText(shown)
        assertTrue(text.contains("Ana"))
        assertFalse(text.contains("Zed"))
        assertTrue(shown.crew.contains("Ana"))
    }

    @Test
    fun `the timeline is grouped by day in the sender's zone and ordered by time`() {
        val m = build()
        assertTrue(m.days.size >= 2)
        val times = m.days.flatMap { d -> d.items.map { it.at } }
        assertEquals(times.sorted(), times)
        assertEquals("departed", m.days.first().items.first().kind)
        assertEquals("home", m.days.last().items.last().kind)
        assertTrue(m.days.first().label.matches(Regex("[A-Z][a-z]+ \\d{1,2} [A-Z][a-z]+")))
        assertEquals(m.days.map { it.label }.distinct(), m.days.map { it.label })
        assertTrue(m.days.flatMap { it.items }.any { it.kind == "game" })
        assertTrue(m.days.flatMap { it.items }.any { it.kind == "story" })
    }

    @Test
    fun `the same moment falls on a different day in another zone`() {
        val pacific = TripShareManifestBuilder.build(summary, emptyList(), ShareOptions(), null, now = day0 + 100 * hour, zone = TimeZone.getTimeZone("Pacific/Kiritimati"), locale = us)
        val utcDays = build().days.map { it.label }
        assertTrue(pacific.days.map { it.label } != utcDays || pacific.days.size != build().days.size)
    }

    @Test
    fun `photos and clips land on the day they were taken and carry their hash and size`() {
        val sha1 = "1".repeat(64)
        val sha2 = "2".repeat(64)
        val sha3 = "3".repeat(64)
        val m = build(
            media = listOf(
                SharedMedia(TripMedia("content://a", false, day0 + 15 * hour), sha1, 1600, 1200),
                SharedMedia(TripMedia("content://b", true, day0 + 26 * hour), sha2, 0, 0),
                SharedMedia(TripMedia("content://c", false, 0L), sha3, 800, 600),
            ),
        )
        val items = m.days.flatMap { it.items }
        val photo = items.first { it.kind == "photo" }
        assertEquals(ShareMedia(sha1, 1600, 1200, photo.media!!.caption), photo.media)
        assertTrue(photo.media!!.caption.isNotBlank())
        assertEquals("video", items.first { it.media?.sha == sha2 }.kind)
        val undated = m.undated.first { it.media != null }
        assertEquals(sha3, undated.media!!.sha)
        assertEquals("", undated.media!!.caption)
    }

    @Test
    fun `text is sent as plain text with nothing escaped or trimmed into markup`() {
        val story = build().days.flatMap { it.items }.first { it.kind == "story" }
        assertTrue("the phone does not pre-escape; the computer escapes when it prints", story.text.contains("<b>jumped</b>"))
    }

    @Test
    fun `stats count what is really there`() {
        val m = build(media = listOf(SharedMedia(TripMedia("u", false, day0 + 15 * hour), "4".repeat(64))))
        assertTrue(m.stats.contains("1 game played"))
        assertTrue(m.stats.contains("1 story"))
        assertTrue(m.stats.contains("1 photo"))
    }

    @Test
    fun `badges and packing come along as undated cards`() {
        val m = build()
        assertNotNull(m.undated.firstOrNull { it.kind == "packing" })
    }

    @Test
    fun `the manifest survives the JSON the computer receives`() {
        val m = build(ShareOptions(includeLocation = true))
        val back = ApiClient.JSON.decodeFromString(ShareManifest.serializer(), allText(m))
        assertEquals(m, back)
        assertEquals("Lake weekend", back.title)
    }
}
