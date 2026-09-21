package com.beeboentertainment.movie.campsite.quiet

import com.beeboentertainment.movie.campsite.family.MemoryFamilyStorage
import com.beeboentertainment.movie.campsite.family.WallClock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.GregorianCalendar
import java.util.TimeZone

class QuietHoursTest {

    private val toronto = TimeZone.getTimeZone("America/Toronto")
    private val la = TimeZone.getTimeZone("America/Los_Angeles")
    private val kolkata = TimeZone.getTimeZone("Asia/Kolkata")
    private val sydney = TimeZone.getTimeZone("Australia/Sydney")
    private val utc = TimeZone.getTimeZone("UTC")
    private val hour = 3_600_000L
    private val min = 60_000L

    /** A wall-clock time in [zone] as epoch millis. Only used for times that exist. */
    private fun at(zone: TimeZone, y: Int, mo: Int, d: Int, h: Int, mi: Int = 0): Long =
        GregorianCalendar(zone).apply { clear(); set(y, mo - 1, d, h, mi, 0) }.timeInMillis

    private val night = QuietSettings(enabled = true, startMinute = 22 * 60, endMinute = 6 * 60)

    // ---- the window ------------------------------------------------------------------------

    @Test
    fun `a window that crosses midnight is quiet at both ends and not in the day`() {
        fun quiet(h: Int, m: Int) = QuietHours.isQuiet(night, at(toronto, 2026, 7, 15, h, m), toronto)
        assertFalse(quiet(21, 59))
        assertTrue(quiet(22, 0))
        assertTrue(quiet(23, 59))
        assertTrue(quiet(0, 0))
        assertTrue(quiet(3, 30))
        assertTrue(quiet(5, 59))
        assertFalse(quiet(6, 0))
        assertFalse(quiet(12, 0))
    }

    @Test
    fun `a window inside one day works and an empty window is never quiet`() {
        val nap = QuietSettings(true, 13 * 60, 15 * 60)
        assertFalse(QuietHours.isQuiet(nap, at(toronto, 2026, 7, 15, 12, 59), toronto))
        assertTrue(QuietHours.isQuiet(nap, at(toronto, 2026, 7, 15, 13, 0), toronto))
        assertTrue(QuietHours.isQuiet(nap, at(toronto, 2026, 7, 15, 14, 59), toronto))
        assertFalse(QuietHours.isQuiet(nap, at(toronto, 2026, 7, 15, 15, 0), toronto))
        val empty = QuietSettings(true, 22 * 60, 22 * 60)
        assertFalse(QuietHours.isQuiet(empty, at(toronto, 2026, 7, 15, 22, 0), toronto))
        assertNull(QuietHours.status(empty, at(toronto, 2026, 7, 15, 22, 0), toronto))
    }

    @Test
    fun `off means never quiet whatever the clock says`() {
        val off = night.copy(enabled = false)
        assertFalse(QuietHours.isQuiet(off, at(toronto, 2026, 7, 15, 23, 30), toronto))
        assertNull(QuietHours.status(off, at(toronto, 2026, 7, 15, 23, 30), toronto))
        assertFalse("default is off", QuietSettings().enabled)
    }

    @Test
    fun `the same instant is read in each phone's own zone`() {
        val instant = at(toronto, 2026, 7, 15, 3, 0) // 03:00 in Toronto (EDT)
        assertTrue(QuietHours.isQuiet(night, instant, toronto))
        assertTrue("00:00 in Los Angeles", QuietHours.isQuiet(night, instant, la))
        assertFalse("12:30 in Kolkata", QuietHours.isQuiet(night, instant, kolkata))
        assertFalse("07:00 UTC", QuietHours.isQuiet(night, instant, utc))
        assertEquals(12 * 60 + 30, QuietHours.minuteOfDay(instant, kolkata))
    }

    @Test
    fun `status says when it flips`() {
        val evening = at(toronto, 2026, 7, 15, 21, 0)
        val before = QuietHours.status(night, evening, toronto)!!
        assertFalse(before.active)
        assertEquals(at(toronto, 2026, 7, 15, 22, 0), before.changeAtMs)
        assertEquals(hour, before.msUntilChange(evening))

        val late = at(toronto, 2026, 7, 15, 23, 0)
        val inside = QuietHours.status(night, late, toronto)!!
        assertTrue(inside.active)
        assertEquals(at(toronto, 2026, 7, 16, 6, 0), inside.changeAtMs)

        val small = at(toronto, 2026, 7, 16, 2, 0)
        assertEquals(at(toronto, 2026, 7, 16, 6, 0), QuietHours.status(night, small, toronto)!!.changeAtMs)
    }

    // ---- daylight saving ---------------------------------------------------------------------

    @Test
    fun `the clocks going forward make the night an hour shorter in real time`() {
        // Toronto, 2026-03-08: 02:00 becomes 03:00. The gate sign says 10 pm to 6 am, so the window is 7 real hours.
        val start = at(toronto, 2026, 3, 7, 22, 0)
        val s = QuietHours.status(night, start + 30 * min, toronto)!!
        assertTrue(s.active)
        assertEquals(at(toronto, 2026, 3, 8, 6, 0), s.changeAtMs)
        assertEquals(7 * hour, s.changeAtMs - start)
        assertTrue(QuietHours.isQuiet(night, at(toronto, 2026, 3, 8, 5, 59), toronto))
        assertFalse(QuietHours.isQuiet(night, at(toronto, 2026, 3, 8, 6, 0), toronto))
    }

    @Test
    fun `the clocks going back make the night an hour longer in real time`() {
        // Toronto, 2026-11-01: 02:00 becomes 01:00.
        val start = at(toronto, 2026, 10, 31, 22, 0)
        val s = QuietHours.status(night, start + 30 * min, toronto)!!
        assertEquals(9 * hour, s.changeAtMs - start)
        assertFalse(QuietHours.isQuiet(night, at(toronto, 2026, 11, 1, 6, 0), toronto))
    }

    @Test
    fun `southern hemisphere and half-hour zones behave`() {
        // Sydney springs forward on 2026-10-04.
        val start = at(sydney, 2026, 10, 3, 22, 0)
        val s = QuietHours.status(night, start + 30 * min, sydney)!!
        assertEquals(7 * hour, s.changeAtMs - start)
        // Kolkata has no daylight saving and a +5:30 offset.
        val k = at(kolkata, 2026, 7, 15, 23, 15)
        assertTrue(QuietHours.isQuiet(night, k, kolkata))
        assertEquals(at(kolkata, 2026, 7, 16, 6, 0), QuietHours.status(night, k, kolkata)!!.changeAtMs)
    }

    @Test
    fun `an edge that falls in the missing hour moves forward instead of vanishing`() {
        val before = at(toronto, 2026, 3, 8, 0, 30)
        assertEquals(at(toronto, 2026, 3, 8, 3, 30), WallClock.nextOccurrence(2 * 60 + 30, before, toronto))
        // And the ordinary case: the next 22:00 after 23:00 is tomorrow's.
        assertEquals(at(toronto, 2026, 7, 16, 22, 0), WallClock.nextOccurrence(22 * 60, at(toronto, 2026, 7, 15, 23, 0), toronto))
        assertEquals(at(toronto, 2026, 7, 15, 22, 0), WallClock.previousOccurrence(22 * 60, at(toronto, 2026, 7, 15, 23, 0), toronto))
        assertEquals(at(toronto, 2026, 7, 14, 22, 0), WallClock.previousOccurrence(22 * 60, at(toronto, 2026, 7, 15, 21, 0), toronto))
    }

    // ---- the 15 minute warning -----------------------------------------------------------------

    @Test
    fun `the warning is due only in the fifteen minutes before quiet hours and only once`() {
        val zone = toronto
        val start = at(zone, 2026, 7, 15, 22, 0)
        assertNull(QuietHours.warningDue(night, start - 16 * min, zone, 0))
        assertEquals(start, QuietHours.warningDue(night, start - 15 * min, zone, 0))
        assertEquals(start, QuietHours.warningDue(night, start - 1 * min, zone, 0))
        assertNull("already warned about this window", QuietHours.warningDue(night, start - 5 * min, zone, start))
        assertNull("quiet has begun", QuietHours.warningDue(night, start, zone, 0))
        assertNull("off", QuietHours.warningDue(night.copy(enabled = false), start - 5 * min, zone, 0))
        // Tomorrow's window is a new one and warns again.
        val tomorrow = at(zone, 2026, 7, 16, 22, 0)
        assertEquals(tomorrow, QuietHours.warningDue(night, tomorrow - 10 * min, zone, start))
    }

    @Test
    fun `the evening prompt is for late sessions, once, and never when quiet hours are already on`() {
        val z = toronto
        fun prompt(h: Int, m: Int, settings: QuietSettings = QuietSettings(), asked: Boolean = false) =
            QuietHours.shouldPrompt(settings, asked, at(z, 2026, 7, 15, h, m), z)
        assertFalse(prompt(19, 59))
        assertTrue(prompt(20, 0))
        assertTrue(prompt(23, 30))
        assertTrue(prompt(4, 59))
        assertFalse(prompt(5, 0))
        assertFalse(prompt(14, 0))
        assertFalse(prompt(22, 0, asked = true))
        assertFalse(prompt(22, 0, settings = night))
    }

    @Test
    fun `presets are the ones the report asks for`() {
        assertEquals(listOf(21 * 60, 22 * 60, 23 * 60), QuietSettings.START_PRESETS)
        assertEquals(listOf(6 * 60, 7 * 60), QuietSettings.END_PRESETS)
        assertEquals("10:00 PM to 6:00 AM", QuietHours.windowText(night))
        assertEquals("12:00 AM", QuietHours.clockText(0))
        assertEquals("12:30 PM", QuietHours.clockText(12 * 60 + 30))
        assertEquals("9:05 AM", QuietHours.clockText(9 * 60 + 5))
        assertEquals("12 min", QuietHours.durationText(12 * min))
        assertEquals("1 hour 5 min", QuietHours.durationText(65 * min))
        assertEquals("2 hours", QuietHours.durationText(2 * hour))
    }

    // ---- what quiet does to music --------------------------------------------------------------

    @Test
    fun `outside quiet hours music is allowed, inside it needs the headphones answer`() {
        assertEquals(MusicDecision.ALLOW, QuietMusicPolicy.decide(quiet = false, headphonesConfirmed = false))
        assertEquals(MusicDecision.ALLOW, QuietMusicPolicy.decide(quiet = false, headphonesConfirmed = true))
        assertEquals(MusicDecision.REFUSE, QuietMusicPolicy.decide(quiet = true, headphonesConfirmed = false))
        assertEquals(MusicDecision.ALLOW_WITH_HEADPHONES, QuietMusicPolicy.decide(quiet = true, headphonesConfirmed = true))
    }

    // ---- the live side, with a fake clock ------------------------------------------------------------

    private class Clock(var now: Long)

    private fun runtime(clock: Clock, zone: TimeZone, saved: QuietSettings = night, storage: MemoryFamilyStorage = MemoryFamilyStorage()): QuietRuntime {
        val store = QuietHoursStore(storage)
        store.save(saved)
        return QuietRuntime(store, nowMs = { clock.now }, zone = { zone })
    }

    @Test
    fun `the banner appears for the window and carries no rule or health claim`() {
        val clock = Clock(at(toronto, 2026, 7, 15, 23, 0))
        val rt = runtime(clock, toronto)
        val v = rt.view()
        assertTrue(v.active)
        assertEquals("6:00 AM", v.endText)
        assertEquals("Quiet hours until 6:00 AM. Please keep the sound down.", v.bannerText)
        rt.headphonesConfirmed = true
        assertEquals("Quiet hours until 6:00 AM. Headphones only, please.", rt.view().bannerText)
        clock.now = at(toronto, 2026, 7, 16, 9, 0)
        assertEquals("", rt.view().bannerText)
        assertFalse("the headphones answer does not carry to the next night", rt.headphonesConfirmed)
        listOf("legal", "complies", "compliant", "guarantee", "sleep better", "helps you sleep").forEach {
            assertFalse(it, QuietHours.bannerText(true, true, "6:00 AM").lowercase().contains(it))
        }
    }

    @Test
    fun `tick warns once per window and counts each night once`() {
        val clock = Clock(at(toronto, 2026, 7, 15, 21, 50)) // ten minutes before it starts
        val rt = runtime(clock, toronto)
        val first = rt.tick(serverRunning = true)
        assertEquals(at(toronto, 2026, 7, 15, 22, 0), first.warnStartMs)
        assertFalse(first.nightKept)
        assertNull("no second warning for the same window", rt.tick(true).warnStartMs)

        clock.now = at(toronto, 2026, 7, 15, 23, 0)
        assertTrue(rt.tick(true).nightKept)
        assertFalse("the same night is not counted twice", rt.tick(true).nightKept)
        clock.now = at(toronto, 2026, 7, 16, 3, 0)
        assertFalse("still the same night after midnight", rt.tick(true).nightKept)
        assertEquals(listOf(at(toronto, 2026, 7, 15, 22, 0)), rt.store.nights())

        // A night with no Campsite running is not "kept".
        clock.now = at(toronto, 2026, 7, 16, 23, 0)
        assertFalse(rt.tick(serverRunning = false).nightKept)
        assertEquals(1, rt.store.nights().size)
        assertTrue(rt.tick(serverRunning = true).nightKept)
        assertEquals(2, rt.store.nights().size)
    }

    @Test
    fun `settings are saved, sanitised and survive a fresh store`() {
        val storage = MemoryFamilyStorage()
        val store = QuietHoursStore(storage)
        assertFalse(store.settings().enabled)
        store.save(QuietSettings(true, 99_999, -5))
        val again = QuietHoursStore(storage).settings()
        assertTrue(again.enabled)
        assertEquals(24 * 60 - 1, again.startMinute)
        assertEquals(0, again.endMinute)
        store.markAsked()
        assertTrue(QuietHoursStore(storage).alreadyAsked())
        storage.map["family_quiet_v1"] = "{not json"
        assertFalse("a damaged file reads as the defaults", QuietHoursStore(storage).settings().enabled)
    }

    @Test
    fun `turning it on from the prompt sets the window and stops the prompt coming back`() {
        val clock = Clock(at(toronto, 2026, 7, 15, 21, 0))
        val rt = runtime(clock, toronto, saved = QuietSettings())
        assertTrue(rt.shouldPrompt())
        rt.turnOn(22 * 60, 6 * 60)
        assertTrue(rt.store.settings().enabled)
        assertFalse(rt.shouldPrompt())
    }

    @Test
    fun `nights are bounded and counted inside a trip's dates`() {
        var nights = emptyList<Long>()
        (1..100).forEach { nights = QuietNights.add(nights, it * 1000L) }
        assertEquals(QuietNights.MAX, nights.size)
        assertEquals(nights, QuietNights.add(nights, nights.last()))
        assertEquals(3, QuietNights.inRange(listOf(10L, 20L, 30L, 40L), 15L, 45L))
        assertEquals(2, QuietNights.inRange(listOf(10L, 20L, 30L, 40L), 15L, 35L))
        assertEquals(3, QuietNights.inRange(listOf(10L, 20L, 30L, 40L), 15L, 0L)) // still running
    }

    // ---- wording ----------------------------------------------------------------------------------

    @Test
    fun `the screens say to check the campground's posted hours and make no claims`() {
        val dir = "src/main/java/com/beeboentertainment/movie/campsite/quiet/"
        val card = File(dir + "QuietHoursCard.kt").readText()
        val music = File("src/main/java/com/beeboentertainment/movie/campsite/CampsiteMusicCard.kt").readText()
        assertTrue(card.contains("Check your campground's posted quiet hours"))
        assertTrue(music.contains("Check your campground's posted quiet hours"))
        assertTrue(QuietMusicPolicy.REFUSED_MESSAGE.contains("Check your campground's posted quiet hours"))
        val all = card + File(dir + "WindDown.kt").readText() + File(dir + "QuietMonitor.kt").readText() + QuietHours.bannerText(true, false, "6:00 AM")
        listOf("helps you sleep", "improve sleep", "insomnia", "anxiety", "clinically", "complies with", "meets your campground", "guarantee").forEach {
            assertFalse("claims \"$it\"", all.lowercase().contains(it))
        }
        assertTrue(card.contains("Not a sleep aid and not a treatment"))
    }

    @Test
    fun `quiet hours add no network, location or storage permissions`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertFalse(manifest.contains("RECORD_AUDIO"))
        val sources = File("src/main/java/com/beeboentertainment/movie/campsite/quiet").listFiles { f -> f.extension == "kt" }!!
        sources.forEach { f ->
            val code = f.readText().replace(Regex("""/\*[\s\S]*?\*/"""), " ").lines().joinToString("\n") { it.substringBefore("//") }
            listOf("HttpURLConnection", "OkHttp", "URL(", "Socket", "LocationManager", "ACCESS_FINE", "ACCESS_COARSE", "RECORD_AUDIO", "CAMERA").forEach {
                assertFalse("${f.name} uses $it", code.contains(it))
            }
        }
        assertNotNull(sources)
    }
}
