package com.beeboentertainment.movie.campsite.tripclock

import com.beeboentertainment.movie.campsite.family.MemoryFamilyStorage
import com.beeboentertainment.movie.trip.MemoryTripPersistence
import com.beeboentertainment.movie.trip.MomentKind
import com.beeboentertainment.movie.trip.PackingSnapshot
import com.beeboentertainment.movie.trip.TripStore
import com.beeboentertainment.movie.trip.TripSummaryBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.GregorianCalendar
import java.util.TimeZone

class TripClockTest {

    private val toronto = TimeZone.getTimeZone("America/Toronto")
    private val la = TimeZone.getTimeZone("America/Los_Angeles")
    private val hour = 3_600_000L
    private val min = 60_000L

    private fun at(zone: TimeZone, y: Int, mo: Int, d: Int, h: Int, mi: Int = 0): Long =
        GregorianCalendar(zone).apply { clear(); set(y, mo - 1, d, h, mi, 0) }.timeInMillis

    private fun started(now: Long, lengthMin: Int, unit: KidUnit = KidUnit.EPISODES, nudge: Int = 30, distance: Int = 0) =
        TripClockLogic.start(now, now + lengthMin * min, distance, unit, nudge)

    // ---- starting and the countdown ---------------------------------------------------------------

    @Test
    fun `the clock counts down in human units and kid units`() {
        val t0 = 1_000_000_000L
        val s = started(t0, 140) // 2 h 20
        val v = TripClockLogic.view(s, t0, toronto)
        assertTrue(v.running)
        assertEquals(140 * min, v.remainingMs)
        assertEquals("2 hours 20 min", v.leftText)
        assertEquals("about 6 episodes", v.kidText) // 140 / 22 = 6.4
        assertEquals(0.0, v.fraction, 0.0001)
        val later = TripClockLogic.view(s, t0 + 70 * min, toronto)
        assertEquals(0.5, later.fraction, 0.0001)
        assertEquals("1 hour 10 min", later.leftText)
        assertEquals("about 3 episodes", later.kidText)
        assertEquals("about 20 songs", TripClockLogic.view(started(t0, 70, KidUnit.SONGS), t0, toronto).kidText) // 70 / 3.5
        assertEquals("", TripClockLogic.view(started(t0, 70, KidUnit.NONE), t0, toronto).kidText)
    }

    @Test
    fun `kid text handles the last minutes and a single unit`() {
        assertEquals("about 1 episode", TripClockLogic.kidText(20 * min, KidUnit.EPISODES))
        assertEquals("almost there!", TripClockLogic.kidText(5 * min, KidUnit.EPISODES))
        assertEquals("You're here!", TripClockLogic.kidText(0L, KidUnit.SONGS))
        assertEquals("about 1 song", TripClockLogic.kidText(200_000L, KidUnit.SONGS))
    }

    @Test
    fun `bad times are refused with a message a parent can read`() {
        val now = 5_000_000L
        fun refused(eta: Long, distance: Int = 0, nudge: Int = 30): String =
            try { TripClockLogic.start(now, eta, distance, KidUnit.EPISODES, nudge); "" } catch (e: IllegalArgumentException) { e.message.orEmpty() }
        assertTrue(refused(now).contains("later than now"))
        assertTrue(refused(now - hour).contains("later than now"))
        assertTrue(refused(now + 100 * hour).contains("three days"))
        assertTrue(refused(now + hour, distance = -1).isNotEmpty())
        assertTrue(refused(now + hour, distance = 30_000_000).isNotEmpty())
        assertTrue(refused(now + hour, nudge = 45).isNotEmpty())
        assertEquals("", refused(now + hour))
    }

    // ---- one-tap +15 --------------------------------------------------------------------------------

    @Test
    fun `plus fifteen pushes the arrival back, from now when already late`() {
        val t0 = 10_000_000L
        var s = started(t0, 60)
        s = TripClockLogic.adjust(s, TripClockLogic.ADJUST_STEP_MIN, t0 + 10 * min)
        assertEquals(t0 + 75 * min, s.etaMs)
        assertEquals(t0 + 60 * min, s.originalEtaMs)
        assertEquals(15 * min, TripClockLogic.view(s, t0 + 10 * min, toronto).delayMs)
        // 20 minutes late, then +15 means 15 minutes from now, not 15 past the stale estimate.
        val lateNow = t0 + 95 * min
        assertTrue(TripClockLogic.view(s, lateNow, toronto).late)
        val again = TripClockLogic.adjust(s, 15, lateNow)
        assertEquals(lateNow + 15 * min, again.etaMs)
        assertFalse(TripClockLogic.view(again, lateNow, toronto).late)
    }

    @Test
    fun `earlier never goes past a minute from now and arrival stops adjustments`() {
        val t0 = 10_000_000L
        val s = started(t0, 30)
        assertEquals(t0 + 20 * min + min, TripClockLogic.adjust(s, -60, t0 + 20 * min).etaMs)
        val arrived = TripClockLogic.arrive(s, t0 + 25 * min)
        assertEquals(arrived, TripClockLogic.adjust(arrived, 15, t0 + 26 * min))
        val v = TripClockLogic.view(arrived, t0 + 26 * min, toronto)
        assertTrue(v.arrived)
        assertEquals(1.0, v.fraction, 0.0)
        assertEquals(0L, v.remainingMs)
        assertEquals("", v.kidText)
    }

    // ---- daylight saving and time zones (fake clock) ----------------------------------------------

    @Test
    fun `across the spring clock change a 1 am departure to a 4 am arrival is two real hours`() {
        // Toronto, 2026-03-08: 02:00 does not exist. 01:00 to 04:00 on the wall clock is two hours.
        val depart = at(toronto, 2026, 3, 8, 1, 0)
        val eta = TripClockLogic.etaFromWallClock(depart, 4 * 60, toronto)
        assertEquals(2 * hour, eta - depart)
        val s = TripClockLogic.start(depart, eta, 0, KidUnit.EPISODES, 30)
        val threeAm = at(toronto, 2026, 3, 8, 3, 0) // one real hour after departing
        val v = TripClockLogic.view(s, threeAm, toronto)
        assertEquals(hour, v.remainingMs)
        assertEquals(0.5, v.fraction, 0.0001)
        assertEquals("4:00 AM", v.etaText)
    }

    @Test
    fun `across the autumn clock change a 1 30 am departure to a 3 am arrival is two and a half real hours`() {
        val depart = at(toronto, 2026, 11, 1, 0, 30) + hour // 01:30 EDT, the first time it happens
        val eta = TripClockLogic.etaFromWallClock(depart, 3 * 60, toronto)
        assertEquals(2 * hour + 30 * min, eta - depart)
        val s = TripClockLogic.start(depart, eta, 0, KidUnit.EPISODES, 30)
        assertEquals(2 * hour + 30 * min, TripClockLogic.view(s, depart, toronto).remainingMs)
    }

    @Test
    fun `an arrival time that has passed today means tomorrow's`() {
        val evening = at(toronto, 2026, 7, 15, 20, 0)
        assertEquals(at(toronto, 2026, 7, 16, 9, 0), TripClockLogic.etaFromWallClock(evening, 9 * 60, toronto))
        assertEquals(at(toronto, 2026, 7, 15, 22, 0), TripClockLogic.etaFromWallClock(evening, 22 * 60, toronto))
    }

    @Test
    fun `crossing a time zone changes how the arrival reads and never the countdown`() {
        val depart = at(toronto, 2026, 7, 15, 9, 0)
        val s = TripClockLogic.start(depart, depart + 3 * hour, 0, KidUnit.EPISODES, 30)
        val now = depart + hour
        val a = TripClockLogic.view(s, now, toronto)
        val b = TripClockLogic.view(s, now, la) // the phone has landed three time zones west
        assertEquals(a.remainingMs, b.remainingMs)
        assertEquals(a.fraction, b.fraction, 0.0)
        assertEquals("12:00 PM", a.etaText)
        assertEquals("9:00 AM", b.etaText)
    }

    // ---- activity nudges -------------------------------------------------------------------------------

    @Test
    fun `an activity is suggested every interval until the parent answers`() {
        val t0 = 50_000_000L
        var s = started(t0, 180, nudge = 30)
        assertEquals(0, TripClockLogic.nudgeDue(s, t0 + 29 * min))
        assertEquals(1, TripClockLogic.nudgeDue(s, t0 + 30 * min))
        assertTrue(TripClockLogic.view(s, t0 + 31 * min, toronto).nudgeText.startsWith("30 min down"))
        s = TripClockLogic.acknowledgeNudge(s, t0 + 31 * min)
        assertEquals(0, TripClockLogic.nudgeDue(s, t0 + 40 * min))
        assertEquals(2, TripClockLogic.nudgeDue(s, t0 + 61 * min))
        assertTrue(TripClockLogic.view(s, t0 + 61 * min, toronto).nudgeText.startsWith("1 hour down"))
        // Off, hourly, and none once it has arrived or is late.
        assertEquals(0, TripClockLogic.nudgeDue(started(t0, 180, nudge = 0), t0 + 90 * min))
        assertEquals(0, TripClockLogic.nudgeDue(started(t0, 180, nudge = 60), t0 + 59 * min))
        assertEquals(1, TripClockLogic.nudgeDue(started(t0, 180, nudge = 60), t0 + 60 * min))
        assertEquals(0, TripClockLogic.nudgeDue(s, t0 + 181 * min))
        assertEquals(0, TripClockLogic.nudgeDue(TripClockLogic.arrive(s, t0 + 62 * min), t0 + 90 * min))
    }

    // ---- stops ---------------------------------------------------------------------------------------------

    @Test
    fun `stops are cleaned, bounded and placed along the road`() {
        val t0 = 1_000_000L
        var s = started(t0, 100)
        s = TripClockLogic.addStop(s, "a", "  Snack stop  ", t0 + 25 * min)
        assertEquals("Snack stop", s.stops.single().title)
        assertEquals(listOf(0.25), TripClockLogic.view(s, t0 + 30 * min, toronto).stopFractions)
        val long = TripClockLogic.addStop(s, "b", "x".repeat(200), t0 + 50 * min)
        assertEquals(TripClockLogic.MAX_TITLE, long.stops.last().title.length)
        try { TripClockLogic.addStop(s, "c", "   ", t0); throw AssertionError("blank name accepted") } catch (_: IllegalArgumentException) {}
        var many = s
        repeat(30) { many = TripClockLogic.addStop(many, "id$it", "Stop $it", t0 + it * min) }
        assertEquals(TripClockLogic.MAX_STOPS, many.stops.size)
        assertEquals(TripClockState(), TripClockLogic.addStop(TripClockState(), "z", "Nope", t0)) // no clock running
    }

    // ---- surviving a restart -------------------------------------------------------------------------------------

    @Test
    fun `the state survives the app being killed and a reboot`() {
        val disk = MemoryFamilyStorage()
        val t0 = 900_000_000L
        val first = TripClockStore(disk)
        first.update { started(t0, 120, KidUnit.SONGS, 60, 150_000) }
        first.update { TripClockLogic.addStop(it, "s1", "Fuel", t0 + 40 * min) }
        first.update { TripClockLogic.adjust(it, 15, t0 + 50 * min) }

        val reopened = TripClockStore(disk).state() // a new process, a new store, the same file
        assertTrue(reopened.running)
        assertEquals(t0 + 135 * min, reopened.etaMs)
        assertEquals("songs", reopened.kidUnit)
        assertEquals(listOf("Fuel"), reopened.stops.map { it.title })
        // A "reboot" is just a later wall-clock reading: the countdown is epoch-based, so it carries on.
        val v = TripClockLogic.view(reopened, t0 + 100 * min, toronto)
        assertEquals(35 * min, v.remainingMs)
        assertEquals("About 150 km in all. Not exact.", v.distanceText)

        TripClockStore(disk).clear()
        assertFalse(TripClockStore(disk).state().running)
        disk.map["family_tripclock_v1"] = "{broken"
        assertFalse("a damaged file reads as no clock", TripClockStore(disk).state().running)
    }

    @Test
    fun `nothing saved can hold a location`() {
        val disk = MemoryFamilyStorage()
        val store = TripClockStore(disk)
        store.update { started(1_000_000L, 90, distance = 200_000) }
        store.update { TripClockLogic.addStop(it, "s", "Snack", 1_500_000L) }
        val saved = disk.map.values.joinToString(" ").lowercase()
        listOf("lat", "lng", "lon", "gps", "location", "coord", "position").forEach { assertFalse("saved state mentions $it", saved.contains(it)) }
        // And the model has no such field at all.
        val fields = TripClockState::class.java.declaredFields.map { it.name.lowercase() } + ClockStop::class.java.declaredFields.map { it.name.lowercase() }
        listOf("lat", "lng", "latitude", "longitude", "location").forEach { assertFalse("field $it", fields.any { f -> f.contains(it) }) }
    }

    // ---- optional GPS progress (in memory only) ---------------------------------------------------------

    @Test
    fun `gps progress adds up movement, ignores jitter, bad fixes and impossible jumps`() {
        val p = PathProgress(totalMeters = 10_000)
        assertNull(PathProgress(0).fraction())
        assertFalse(p.onFix(45.0, -75.0, 200f, 0L)) // the first fix only sets the start
        assertFalse("a wobble of a few metres", p.onFix(45.0001, -75.0, 100f, 10_000L))
        assertTrue(p.onFix(45.02, -75.0, 200f, 60_000L)) // about 2.2 km north in a minute
        val km = p.metres / 1000.0
        assertTrue("about 2.2 km: $km", km in 2.0..2.5)
        assertEquals(p.metres / 10_000.0, p.fraction()!!, 0.0001)
        assertFalse("poor accuracy is not trusted", p.onFix(45.05, -75.0, 5_000f, 120_000L))
        assertFalse("a jump no car can make", p.onFix(60.0, -75.0, 200f, 121_000L))
        assertTrue("and it is not counted", p.metres / 1000.0 < 2.6)
        assertFalse("invalid values", p.onFix(120.0, 0.0, 10f, 130_000L))
        // Keep driving south at about 37 m/s, far past the typed route length: progress is capped at the whole way.
        var lat = 60.0
        repeat(20) { i -> lat -= 0.1; p.onFix(lat, -75.0, 200f, 421_000L + i * 300_000L) }
        assertTrue("well past 10 km travelled: ${p.metres}", p.metres > 10_000.0)
        assertEquals(1.0, p.fraction()!!, 0.0)
        p.reset()
        assertEquals(0.0, p.metres, 0.0)
    }

    @Test
    fun `the view uses gps progress when given and time otherwise`() {
        val t0 = 1_000_000L
        val s = started(t0, 100)
        val byTime = TripClockLogic.view(s, t0 + 50 * min, toronto)
        assertEquals("time", byTime.source)
        val byGps = TripClockLogic.view(s, t0 + 50 * min, toronto, pathFraction = 0.8)
        assertEquals("distance", byGps.source)
        assertEquals(0.8, byGps.fraction, 0.0001)
        assertEquals(byTime.remainingMs, byGps.remainingMs) // the countdown is still the parent's estimate
    }

    @Test
    fun `the gps code is only ever on the screen, in memory, coarse, and removed when the screen stops`() {
        val dir = "src/main/java/com/beeboentertainment/movie/campsite/tripclock/"
        val screen = File(dir + "TripClockScreen.kt").readText()
        assertTrue(screen.contains("ACCESS_COARSE_LOCATION"))
        assertFalse("no fine location", screen.contains("ACCESS_FINE_LOCATION"))
        assertFalse("framework LocationManager only, no Play services", screen.contains("FusedLocation") || screen.contains("com.google.android.gms"))
        assertTrue(screen.contains("Lifecycle.Event.ON_STOP"))
        assertTrue(screen.contains("removeUpdates"))
        assertTrue("off every time the screen opens", screen.contains("var gpsOn by remember { mutableStateOf(false) }"))
        // No other file in the package asks for a location or touches the network.
        File(dir).listFiles { f -> f.extension == "kt" && f.name != "TripClockScreen.kt" }!!.forEach { f ->
            val code = f.readText().replace(Regex("""/\*[\s\S]*?\*/"""), " ").lines().joinToString("\n") { it.substringBefore("//") }
            listOf("LocationManager", "requestLocationUpdates", "HttpURLConnection", "OkHttp", "URL(", "Socket").forEach {
                assertFalse("${f.name} uses $it", code.contains(it))
            }
        }
        assertFalse("PathProgress is never written to disk", File(dir + "PathProgress.kt").readText().contains("SharedPreferences"))
    }

    // ---- the Trip Journal tie-ins ----------------------------------------------------------------------------------

    private class Rig(val now: LongArray = longArrayOf(1_000_000L)) {
        val disk = MemoryTripPersistence()
        var ids = 0
        val trips = TripStore(disk, clock = { now[0] }, newId = { "id${ids++}" })
        val controller = TripClockController(TripClockStore(MemoryFamilyStorage()), trips, nowMs = { now[0] }, newId = { "c${ids++}" })
        fun advance(ms: Long) { now[0] += ms }
    }

    @Test
    fun `starting the clock begins a trip with a departed moment, or attaches to the running one`() {
        val rig = Rig()
        assertNull(rig.trips.active())
        rig.controller.start(rig.now[0] + 2 * hour, 0, KidUnit.EPISODES, 30)
        val trip = rig.trips.active()!!
        assertEquals(listOf(MomentKind.DEPARTED), trip.moments.map { it.kind })
        assertEquals("Road trip", trip.name)

        // Already on a trip (started from the Campsite card): the clock attaches and makes no second one.
        val other = Rig()
        val existing = other.trips.start("Lake weekend", listOf("Ana"), emptySet(), PackingSnapshot())!!
        other.controller.start(other.now[0] + hour, 0, KidUnit.SONGS, 0)
        assertEquals(1, other.trips.all().size)
        assertEquals(existing.id, other.trips.active()!!.id)
        assertEquals("Lake weekend", other.trips.active()!!.name)
    }

    @Test
    fun `arriving writes one arrived moment and does not end the trip`() {
        val rig = Rig()
        rig.controller.start(rig.now[0] + hour, 0, KidUnit.EPISODES, 30)
        rig.advance(50 * min)
        rig.controller.arrive()
        rig.controller.arrive()
        val trip = rig.trips.active()!!
        assertTrue("the trip is still running: the family is at camp now", trip.running)
        assertEquals(1, trip.moments.count { it.kind == MomentKind.ARRIVED })
        assertEquals(rig.now[0], trip.moments.single { it.kind == MomentKind.ARRIVED }.at)
        assertTrue(rig.controller.state().arrivedAtMs > 0L)
    }

    @Test
    fun `stops appear in the recap, and a position is dropped unless the trip opted in`() {
        val rig = Rig()
        rig.controller.start(rig.now[0] + 3 * hour, 100_000, KidUnit.EPISODES, 30)
        rig.advance(40 * min)
        rig.controller.addStop("Snack stop", 45.5, -75.7) // GPS was on and gave a position
        val kept = rig.trips.active()!!.moments.single { it.kind == MomentKind.STOP }
        assertEquals("Snack stop", kept.title)
        assertNull("saveLocation is off, so the position is dropped", kept.lat)
        assertNull(kept.lng)

        rig.trips.setSaveLocation(true)
        rig.advance(20 * min)
        rig.controller.addStop("Fuel", 45.6, -75.8)
        val fuel = rig.trips.active()!!.moments.last { it.kind == MomentKind.STOP }
        assertEquals(45.6, fuel.lat!!, 0.0)
        // Turning the switch off erases what was kept.
        rig.trips.setSaveLocation(false)
        assertTrue(rig.trips.active()!!.moments.filter { it.kind == MomentKind.STOP }.all { it.lat == null && it.lng == null })

        rig.controller.arrive()
        val summary = TripSummaryBuilder.build(rig.trips.active()!!, emptyList(), emptyList(), emptySet(), now = rig.now[0])
        assertEquals(listOf("Snack stop", "Fuel"), summary.stops.map { it.title })
        assertTrue(summary.arrivedAt > 0L)
        assertFalse(summary.isEmpty)
    }

    @Test
    fun `stops with no trip running are simply not recorded`() {
        val rig = Rig()
        rig.controller.start(rig.now[0] + hour, 0, KidUnit.EPISODES, 30)
        val id = rig.trips.active()!!.id
        rig.trips.end(emptySet(), PackingSnapshot(), emptyList())
        assertNull(rig.trips.active())
        rig.controller.addStop("Late stop")
        assertEquals(listOf(MomentKind.DEPARTED, MomentKind.HOME), rig.trips.trip(id)!!.moments.map { it.kind })
        assertEquals("the clock still shows it", 1, rig.controller.state().stops.size)
    }

    @Test
    fun `recap and slides carry the road section only when there is something in it`() {
        val rig = Rig()
        rig.controller.start(rig.now[0] + hour, 0, KidUnit.EPISODES, 30)
        val bare = TripSummaryBuilder.build(rig.trips.active()!!, emptyList(), emptyList(), emptySet(), now = rig.now[0])
        val plain = com.beeboentertainment.movie.trip.TripSlides.build(bare, emptyList(), now = rig.now[0])
        assertFalse(plain.any { it.kind == com.beeboentertainment.movie.trip.SlideKind.ROAD })
        rig.controller.addStop("Snack")
        val busy = TripSummaryBuilder.build(rig.trips.active()!!, emptyList(), emptyList(), emptySet(), now = rig.now[0], quietNights = 2)
        val road = com.beeboentertainment.movie.trip.TripSlides.build(busy, emptyList(), now = rig.now[0])
            .single { it.kind == com.beeboentertainment.movie.trip.SlideKind.ROAD }
        assertTrue(road.lines.any { it.startsWith("Stop: Snack") })
        assertTrue(road.lines.contains("Quiet hours kept: 2 nights"))
    }

    // ---- wording ------------------------------------------------------------------------------------------------------

    @Test
    fun `the estimate-only line is always there and the screens make no navigation or safety claim`() {
        assertEquals("Estimate only. Use your navigation app for directions.", TripClockView.DISCLAIMER)
        val dir = "src/main/java/com/beeboentertainment/movie/campsite/tripclock/"
        val screen = File(dir + "TripClockScreen.kt").readText()
        val page = TripClockGuestPage.html()
        assertTrue(screen.contains("TripClockView.DISCLAIMER"))
        assertTrue(page.contains("Estimate only. Use your navigation app for directions."))
        assertTrue(page.contains("Never for the driver"))
        listOf("turn-by-turn", "emergency", "rescue", "safe to drive", "traffic data", "live traffic", "guaranteed").forEach {
            assertFalse("claims $it", (screen + page).lowercase().contains(it))
        }
    }

    @Test
    fun `touch targets on the host screen are at least 48 dp`() {
        val screen = File("src/main/java/com/beeboentertainment/movie/campsite/tripclock/TripClockScreen.kt").readText()
        val buttons = Regex("""\b(Button|OutlinedButton|FilterChip)\(""").findAll(screen).count()
        val minimums = Regex("""heightIn\(min = (\d+)\.dp\)""").findAll(screen).map { it.groupValues[1].toInt() }.toList()
        assertTrue("every button sets a minimum height", minimums.size >= buttons - 3)
        assertTrue(minimums.all { it >= 48 })
    }

    @Test
    fun `the guest page draws with textContent only, needs no internet and is read-only`() {
        val page = TripClockGuestPage.html()
        listOf("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(").forEach { assertFalse(it, page.contains(it)) }
        assertTrue(page.contains("textContent"))
        assertFalse("nothing comes from anywhere else", Regex("""(src|href)="https?://""").containsMatchIn(page) || page.contains("@import"))
        assertFalse("read-only: the page never posts", page.contains("method:'POST'") || page.contains("method: 'POST'") || page.contains("<form"))
        assertNotEquals("", page)
    }
}
