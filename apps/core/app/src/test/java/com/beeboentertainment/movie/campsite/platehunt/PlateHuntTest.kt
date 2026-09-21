package com.beeboentertainment.movie.campsite.platehunt

import com.beeboentertainment.movie.badges.BADGES
import com.beeboentertainment.movie.badges.BadgeInputs
import com.beeboentertainment.movie.badges.badgeEarned
import com.beeboentertainment.movie.campsite.CampsiteGames
import com.beeboentertainment.movie.campsite.CampsiteLocalGames
import com.beeboentertainment.movie.campsite.CampsitePagePacks
import com.beeboentertainment.movie.campsite.CampsiteGameGate
import com.beeboentertainment.movie.campsite.games.CampsiteGame
import com.beeboentertainment.movie.campsite.games.CampsiteGameCatalog
import com.beeboentertainment.movie.campsite.games.GameCategory
import com.beeboentertainment.movie.campsite.games.GameMove
import com.beeboentertainment.movie.campsite.games.MatchContext
import com.beeboentertainment.movie.party.games.TriviaQuestion
import com.beeboentertainment.movie.trip.MemoryTripPersistence
import com.beeboentertainment.movie.trip.MomentKind
import com.beeboentertainment.movie.trip.PackingSnapshot
import com.beeboentertainment.movie.trip.TallyResult
import com.beeboentertainment.movie.trip.TripMomentSink
import com.beeboentertainment.movie.trip.TripStore
import com.beeboentertainment.movie.trip.TripStoreSink
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.random.Random

class PlateHuntTest {

    // ---- the lists ----------------------------------------------------------------------

    @Test
    fun `the lists have exactly the right counts`() {
        assertEquals(51, PlateRegions.USA.size) // 50 states + DC
        assertEquals(13, PlateRegions.CANADA.size) // 10 provinces + 3 territories
        assertEquals(26, PlateRegions.ALPHABET.size)
        assertEquals(64, PlateRegions.items(PlateRegionId.BOTH).size)
        assertEquals(51, PlateRegions.items(PlateRegionId.USA).size)
        assertEquals(13, PlateRegions.items(PlateRegionId.CANADA).size)
        assertEquals(26, PlateRegions.items(PlateRegionId.ALPHABET).size)
    }

    @Test
    fun `every entry has a unique name and a unique abbreviation in every region`() {
        PlateRegionId.values().forEach { region ->
            val items = PlateRegions.items(region)
            assertEquals(region.name + " names", items.size, items.map { it.name }.toSet().size)
            assertEquals(region.name + " abbreviations", items.size, items.map { it.abbr }.toSet().size)
            assertTrue(items.all { it.name.isNotBlank() && it.abbr.isNotBlank() })
        }
        assertTrue(PlateRegions.USA.any { it.name == "District of Columbia" && it.abbr == "DC" })
        assertEquals(setOf("YT", "NT", "NU"), PlateRegions.CANADA.map { it.abbr }.filter { it in setOf("YT", "NT", "NU") }.toSet())
    }

    @Test
    fun `the alphabet is found in order and a plate hunt is not`() {
        assertTrue(PlateRegions.ordered(PlateRegionId.ALPHABET))
        assertFalse(PlateRegions.ordered(PlateRegionId.USA))
        assertEquals("letters", PlateRegions.noun(PlateRegionId.ALPHABET))
        assertEquals("jurisdictions", PlateRegions.noun(PlateRegionId.BOTH))
    }

    // ---- registered in the catalog -------------------------------------------------------

    @Test
    fun `the game is registered once with a unique wire id and the right shape`() {
        val ids = CampsiteGameCatalog.ALL.map { it.id }
        assertEquals("game ids must be unique", ids.size, ids.toSet().size)
        assertEquals(1, ids.count { it == "plates" })
        val game = CampsiteGameCatalog["plates"]!!
        assertEquals(GameCategory.OUTDOORS, game.category)
        assertFalse(game.needsGuests)
        assertTrue(game.playsSolo)
        assertEquals(1, game.seats.min)
        assertFalse(game.ranked)
        assertFalse(game.tournamentReady)
        assertEquals("Play on this phone", CampsiteGameGate.labelFor(game.needsGuests, game.playsSolo))
        assertEquals("Play vs computer", CampsiteGameGate.labelFor(false))
    }

    // ---- driving the real games service --------------------------------------------------

    private var seq = 0

    /** A fake clock. Every action moves it on by [step], so a long run of taps is not tripped by the rate limit. */
    private var clockMs = 100_000L
    private var step = 400L

    private fun act(g: CampsiteGames, token: String, action: String, vararg fields: Pair<String, JsonElement>): Int {
        clockMs += step
        val round = g.handle(token).body["room"]?.jsonObject?.get("round") ?: JsonPrimitive(0)
        return g.handle(token, buildJsonObject {
            put("action", action); put("actionId", "a${seq++}"); put("round", round)
            fields.forEach { (k, v) -> put(k, v) }
        }).status
    }

    private fun room(g: CampsiteGames, token: String): JsonObject = g.handle(token).body.getValue("room").jsonObject
    private fun plates(g: CampsiteGames, token: String): JsonObject = room(g, token).getValue("plates").jsonObject
    private fun cell(i: Int) = "cell" to JsonPrimitive(i)
    private fun ints(a: JsonElement): List<Int> = a.jsonArray.map { it.jsonPrimitive.int }

    private fun games(now: () -> Long = { clockMs }, trip: TripMomentSink = TripMomentSink.None,
                      badges: PlateBadgeSink = PlateBadgeSink.None) =
        CampsiteGames(random = Random(7), now = now, botClockEnabled = false, trip = trip, plates = badges)

    /** Two players in a plates room, Ann (the leader) and Ben. */
    private fun start(g: CampsiteGames, setup: String): Pair<String, String> {
        val ann = g.join("Ann")!!
        val ben = g.join("Ben")!!
        listOf(ann, ben).forEach { assertEquals(200, act(g, it, "enter", "game" to JsonPrimitive("plates"))) }
        assertEquals(200, act(g, ann, "start", "text" to JsonPrimitive(setup)))
        return ann to ben
    }

    @Test
    fun `team mode one tap ticks it for everyone and shows who spotted it`() {
        val g = games()
        val (ann, ben) = start(g, "region=usa;mode=team")
        assertEquals(200, act(g, ann, "spot", cell(4)))
        val p = plates(g, ben)
        assertEquals("Ann", p.getValue("team").jsonArray[4].jsonPrimitive.content)
        assertEquals(1, p.getValue("found").jsonPrimitive.int)
        // A second tap on a plate that is already found is not an error and does not steal it.
        assertEquals(200, act(g, ben, "spot", cell(4)))
        assertEquals("Ann", plates(g, ann).getValue("team").jsonArray[4].jsonPrimitive.content)
        assertEquals(1, plates(g, ann).getValue("found").jsonPrimitive.int)
    }

    @Test
    fun `a player can take back their own tick, the leader can take back any, others cannot`() {
        val g = games()
        val (ann, ben) = start(g, "region=usa;mode=team")
        assertEquals(200, act(g, ben, "spot", cell(9)))
        // Ann is not the spotter but she is the leader, so she may.
        assertEquals(200, act(g, ann, "unspot", cell(9)))
        assertEquals("", plates(g, ben).getValue("team").jsonArray[9].jsonPrimitive.content)
        // Ann ticks one; Ben is neither its spotter nor the leader.
        assertEquals(200, act(g, ann, "spot", cell(2)))
        assertEquals(409, act(g, ben, "unspot", cell(2)))
        // Ben ticks and takes back his own.
        assertEquals(200, act(g, ben, "spot", cell(3)))
        assertEquals(200, act(g, ben, "unspot", cell(3)))
        assertEquals(1, plates(g, ann).getValue("found").jsonPrimitive.int)
    }

    @Test
    fun `race mode never leaks another player's list`() {
        val g = games()
        val (ann, ben) = start(g, "region=usa;mode=race")
        assertEquals(200, act(g, ann, "spot", cell(3)))
        assertEquals(200, act(g, ann, "spot", cell(7)))
        assertEquals(listOf(3, 7), ints(plates(g, ann).getValue("mine")))
        val bens = plates(g, ben)
        assertEquals(emptyList<Int>(), ints(bens.getValue("mine")))
        assertEquals(0, bens.getValue("team").jsonArray.size)
        assertEquals(0, bens.getValue("found").jsonPrimitive.int)
        // He can see how far along she is, as a count, and nothing else about her list.
        val progress = bens.getValue("progress").jsonArray.map { it.jsonObject }
        assertEquals(2, progress.single { it.getValue("name").jsonPrimitive.content == "Ann" }.getValue("found").jsonPrimitive.int)
        assertFalse(bens.toString().contains("[3,7]"))
    }

    @Test
    fun `a spectator with no viewer sees no race list at all`() {
        val ctx = TestCtx()
        val match = PlateHuntGame.create(listOf("a", "b"), "region=canada;mode=race", ctx)
        match.apply(GameMove("a", "spot", buildJsonObject { put("cell", 2) }))
        val view = match.view(null).getValue("plates").jsonObject
        assertEquals(emptyList<Int>(), ints(view.getValue("mine")))
        assertEquals(0, view.getValue("found").jsonPrimitive.int)
        assertEquals(listOf(2), ints(match.view("a").getValue("plates").jsonObject.getValue("mine")))
    }

    @Test
    fun `the leader can take back a tick in a race, another player cannot`() {
        val g = games()
        val (ann, ben) = start(g, "region=usa;mode=race")
        val annId = g.handle(ann).body.getValue("you").jsonPrimitive.content
        val benId = g.handle(ben).body.getValue("you").jsonPrimitive.content
        assertEquals(200, act(g, ben, "spot", cell(9)))
        assertEquals(409, act(g, ben, "unspot", cell(9), "player" to JsonPrimitive(annId)))
        assertEquals(200, act(g, ann, "unspot", cell(9), "player" to JsonPrimitive(benId)))
        assertEquals(emptyList<Int>(), ints(plates(g, ben).getValue("mine")))
    }

    @Test
    fun `the first player to finish a race list wins`() {
        val g = games()
        val (ann, ben) = start(g, "region=alphabet;mode=race")
        val annId = g.handle(ann).body.getValue("you").jsonPrimitive.content
        (0..24).forEach { assertEquals(200, act(g, ann, "spot", cell(it))) }
        assertEquals(200, act(g, ben, "spot", cell(0)))
        assertEquals("playing", room(g, ann).getValue("phase").jsonPrimitive.content)
        assertEquals(200, act(g, ann, "spot", cell(25)))
        val r = room(g, ben)
        assertEquals("done", r.getValue("phase").jsonPrimitive.content)
        assertEquals(annId, r.getValue("winner").jsonPrimitive.content)
        assertEquals(409, act(g, ben, "spot", cell(1)))
    }

    @Test
    fun `the alphabet has to be found in order and only the latest letter can be taken back`() {
        val g = games()
        val (ann, ben) = start(g, "region=alphabet;mode=team")
        assertEquals(409, act(g, ann, "spot", cell(1))) // B before A
        assertEquals(200, act(g, ann, "spot", cell(0)))
        assertEquals(200, act(g, ben, "spot", cell(1)))
        assertEquals(2, plates(g, ann).getValue("next").jsonPrimitive.int)
        assertEquals(409, act(g, ann, "unspot", cell(0))) // A is not the latest
        assertEquals(200, act(g, ann, "unspot", cell(1)))
        assertEquals(1, plates(g, ann).getValue("next").jsonPrimitive.int)
    }

    @Test
    fun `finishing a team round settles it with the count`() {
        val g = games()
        val (ann, ben) = start(g, "region=usa;mode=team")
        assertEquals(200, act(g, ben, "spot", cell(1)))
        assertEquals(409, act(g, ben, "finish")) // only the leader finishes
        assertEquals(200, act(g, ann, "finish"))
        assertEquals("done", room(g, ann).getValue("phase").jsonPrimitive.content)
        assertEquals(409, act(g, ann, "spot", cell(2)))
    }

    @Test
    fun `a bad setup is refused before anything starts`() {
        val g = games()
        val ann = g.join("Ann")!!
        assertEquals(200, act(g, ann, "enter", "game" to JsonPrimitive("plates")))
        listOf("region=mars", "mode=fast", "colour=red", "region=usa;mode=team;x", "x".repeat(200)).forEach {
            assertEquals(it, 409, act(g, ann, "start", "text" to JsonPrimitive(it)))
        }
        assertEquals("lobby", room(g, ann).getValue("phase").jsonPrimitive.content)
        assertEquals(200, act(g, ann, "start")) // empty means the defaults
        assertEquals("usa", plates(g, ann).getValue("region").jsonPrimitive.content)
        assertEquals("team", plates(g, ann).getValue("mode").jsonPrimitive.content)
    }

    @Test
    fun `taps are rate limited per player and recover`() {
        step = 0L // taps arrive at the same instant
        val g = games()
        val (ann, ben) = start(g, "region=usa;mode=team")
        repeat(PlateHuntGame.RATE_MAX / 2) { i ->
            assertEquals(200, act(g, ann, "spot", cell(i)))
            assertEquals(200, act(g, ann, "unspot", cell(i)))
        }
        assertEquals(409, act(g, ann, "spot", cell(40))) // the 13th tap inside three seconds
        assertEquals(200, act(g, ben, "spot", cell(40))) // another player is not affected
        clockMs += PlateHuntGame.RATE_WINDOW_MS + 1
        assertEquals(200, act(g, ann, "spot", cell(41)))
    }

    @Test
    fun `a hostile nickname is capped and carried as data`() {
        val g = games()
        val evil = g.join("<script>alert(1)</script>".repeat(4))!!
        assertTrue(g.name(evil)!!.length <= 24)
        assertEquals(200, act(g, evil, "enter", "game" to JsonPrimitive("plates")))
        assertEquals(200, act(g, evil, "start", "text" to JsonPrimitive("region=usa;mode=team")))
        assertEquals(200, act(g, evil, "spot", cell(0)))
        // It travels only inside a JSON string; the page draws it with textContent (see the page checks below).
        val name = plates(g, evil).getValue("team").jsonArray[0].jsonPrimitive.content
        assertTrue(name.startsWith("<script>"))
        assertEquals(name, Json.parseToJsonElement(plates(g, evil).toString()).jsonObject.getValue("team").jsonArray[0].jsonPrimitive.content)
    }

    // ---- solo on the host phone: no server, no network ---------------------------------------

    @Test
    fun `it plays alone on the host phone through the local engine with no computer player`() {
        val sink = RecordingSink()
        val local = CampsiteLocalGames(botClock = false, trip = sink)
        try {
            assertTrue(local.open("plates", withComputer = true))
            val room = local.snapshot().getValue("room").jsonObject
            assertEquals(0, room.getValue("bots").jsonPrimitive.int)
            fun post(body: JsonObject) = Json.parseToJsonElement(local.post(body.toString())).jsonObject
            // A round number is what stops a stale tap landing on a new round, so read it fresh each time.
            fun round() = local.snapshot().getValue("room").jsonObject.getValue("round").jsonPrimitive.int
            val started = post(buildJsonObject { put("action", "start"); put("actionId", "s1"); put("round", round()); put("text", "region=canada;mode=team") })
            assertEquals(200, started.getValue("status").jsonPrimitive.int)
            listOf(0, 1, 2).forEachIndexed { i, c ->
                val r = post(buildJsonObject { put("action", "spot"); put("actionId", "p$i"); put("round", round()); put("cell", c) })
                assertEquals(200, r.getValue("status").jsonPrimitive.int)
            }
            val fin = post(buildJsonObject { put("action", "finish"); put("actionId", "f"); put("round", round()) })
            assertEquals(200, fin.getValue("status").jsonPrimitive.int)
            assertEquals("Spotted 3 of 13 jurisdictions", sink.tallies.single().text)
        } finally { local.close() }
    }

    // ---- the Trip Journal tie-in ---------------------------------------------------------

    private class RecordingSink : TripMomentSink {
        val tallies = mutableListOf<TallyResult>()
        override fun story(story: com.beeboentertainment.movie.trip.StoryResult) {}
        override fun tally(tally: TallyResult) { tallies += tally }
    }

    private class RecordingBadges : PlateBadgeSink {
        val rounds = mutableListOf<PlateSummary>()
        override fun finished(summary: PlateSummary) { rounds += summary }
    }

    @Test
    fun `a finished round writes one tally, a round nobody spotted in writes none`() {
        val sink = RecordingSink()
        val g = games(trip = sink)
        val (ann, _) = start(g, "region=usa;mode=team")
        assertEquals(200, act(g, ann, "finish"))
        assertTrue("nothing spotted, nothing to remember", sink.tallies.isEmpty())

        assertEquals(200, act(g, ann, "start", "text" to JsonPrimitive("region=both;mode=team")))
        listOf(0, 5, 10).forEach { assertEquals(200, act(g, ann, "spot", cell(it))) }
        assertEquals(200, act(g, ann, "finish"))
        val t = sink.tallies.single()
        assertEquals("Spotted 3 of 64 jurisdictions", t.text)
        assertEquals(3, t.found)
        assertEquals(64, t.total)
        assertEquals(listOf("Ann", "Ben"), t.names)
    }

    @Test
    fun `the real sink keeps the tally on a running trip and does nothing without one, and never a location`() {
        val disk = MemoryTripPersistence()
        val store = TripStore(disk, clock = { 5_000L }, newId = { "t1" })
        val sink = TripStoreSink(store)
        val tally = TallyResult("r1", "Plate hunt", "Spotted 34 of 64 jurisdictions", 34, 64, listOf("Ann"))
        sink.tally(tally)
        assertNull("no trip running, nothing written", disk.text)

        store.start("Lake", emptyList(), emptySet(), PackingSnapshot())
        store.setSaveLocation(true) // even the location opt-in cannot put a coordinate on a tally
        sink.tally(tally)
        sink.tally(tally) // the same round is kept once
        val moments = store.active()!!.moments.filter { it.kind == MomentKind.TALLY }
        assertEquals(1, moments.size)
        assertEquals("Spotted 34 of 64 jurisdictions", moments.single().text)
        assertNull(moments.single().lat)
        assertNull(moments.single().lng)
    }

    @Test
    fun `the round reads no location, camera or microphone anywhere`() {
        val sources = listOf("PlateHuntGame.kt", "PlateRegions.kt", "PlateHuntRecords.kt")
            .map { File("src/main/java/com/beeboentertainment/movie/campsite/platehunt/$it").readText() }
        sources.forEach { text ->
            val code = text.replace(Regex("""/\*[\s\S]*?\*/"""), " ").lines().joinToString("\n") { it.substringBefore("//") }
            listOf("LocationManager", "ACCESS_", "getLastKnownLocation", "CAMERA", "RECORD_AUDIO", "URL(", "HttpURLConnection", "Socket").forEach {
                assertFalse("uses $it", code.contains(it))
            }
        }
        val js = File("src/main/assets/campsite-platehunt.js").readText()
        listOf("geolocation", "getUserMedia", "mediaDevices", "capture=", "XMLHttpRequest", "fetch(", "WebSocket", "localStorage", "indexedDB").forEach {
            assertFalse("page uses $it", js.contains(it))
        }
    }

    // ---- badges ----------------------------------------------------------------------------

    @Test
    fun `two badges were added and no existing id changed`() {
        val ids = BADGES.map { it.id }
        assertEquals(listOf("first_movie", "trivia_5", "packed", "bingo", "veteran"), ids.take(5))
        assertTrue("plate_spotter_20" in ids)
        assertTrue("alphabet_complete" in ids)
        assertEquals(ids.size, ids.toSet().size)
        val none = BadgeInputs(0, 0, false, false, 0)
        assertFalse(badgeEarned("plate_spotter_20", none))
        assertFalse(badgeEarned("plate_spotter_20", none.copy(platesSpotted = 19)))
        assertTrue(badgeEarned("plate_spotter_20", none.copy(platesSpotted = 20)))
        assertTrue(badgeEarned("alphabet_complete", none.copy(alphabetComplete = true)))
    }

    @Test
    fun `finished rounds feed the badge counters, alphabet only when every letter was found`() {
        val badges = RecordingBadges()
        val g = games(badges = badges)
        val ann = g.join("Ann")!!
        assertEquals(200, act(g, ann, "enter", "game" to JsonPrimitive("plates")))
        assertEquals(200, act(g, ann, "start", "text" to JsonPrimitive("region=alphabet;mode=team")))
        (0..25).forEach { assertEquals(200, act(g, ann, "spot", cell(it))) }
        val done = badges.rounds.single()
        assertEquals(PlateRegionId.ALPHABET, done.region)
        assertTrue(done.complete)
        assertEquals(26, done.found)

        assertEquals(200, act(g, ann, "start", "text" to JsonPrimitive("region=usa;mode=team")))
        (0..3).forEach { assertEquals(200, act(g, ann, "spot", cell(it))) }
        assertEquals(200, act(g, ann, "finish"))
        assertEquals(4, badges.rounds.last().found)
        assertFalse(badges.rounds.last().complete)
    }

    // ---- strings and the page --------------------------------------------------------------

    private val deny = listOf(
        // slogans and nicknames printed on plates
        "live free or die", "sunshine state", "land of lincoln", "great lakes state", "garden state", "empire state",
        "lone star", "show me state", "peach state", "aloha state", "last frontier", "grand canyon state",
        "natural state", "golden state", "centennial state", "constitution state", "first state", "diamond state",
        "gem state", "hoosier", "hawkeye", "sunflower state", "bluegrass", "pelican state", "pine tree state",
        "old line state", "bay state", "gopher", "magnolia state", "big sky", "cornhusker", "silver state",
        "land of enchantment", "tar heel", "peace garden", "buckeye", "sooner state", "beaver state", "keystone state",
        "ocean state", "palmetto", "mount rushmore", "volunteer state", "beehive", "green mountain", "old dominion",
        "evergreen state", "mountain state", "dairyland", "equality state", "yours to discover", "living skies",
        "beautiful british columbia", "friendly manitoba",
        // seals and pictures
        "seal", "coat of arms", "emblem", "photo of a plate",
        // brands and other people's marks
        "google", "waze", "wordle", "pictionary", "mad libs", "heads up", "jackbox", "junior ranger", "smokey",
        "leave no trace", "nasa", "usgs", "arrowhead",
    )

    @Test
    fun `no string in the game or its page has a slogan, a seal or a brand in it`() {
        val js = File("src/main/assets/campsite-platehunt.js").readText()
        val strings = PlateHuntStrings.ALL +
            PlateRegions.USA.map { it.name } + PlateRegions.CANADA.map { it.name } + js
        strings.forEach { s ->
            deny.forEach { d -> assertFalse("\"$d\" found in: ${s.take(80)}", s.lowercase().contains(d)) }
        }
    }

    @Test
    fun `passengers only never the driver is on the game, the round and the page`() {
        assertTrue(PlateHuntStrings.BLURB.contains("never the driver"))
        assertTrue(PlateHuntStrings.PROMPT.contains("never the driver"))
        assertTrue(PlateHuntStrings.DRIVER_NOTE.contains("never the driver"))
        val js = File("src/main/assets/campsite-platehunt.js").readText()
        assertTrue(js.split("never the driver").size - 1 >= 3)
        val g = games()
        val (ann, _) = start(g, "region=usa;mode=team")
        assertTrue(plates(g, ann).getValue("note").jsonPrimitive.content.contains("never the driver"))
    }

    @Test
    fun `the page script draws guest text with textContent only and is pasted into the games page`() {
        val js = File("src/main/assets/campsite-platehunt.js").readText()
        listOf("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "</script").forEach {
            assertFalse("page script uses $it", js.contains(it))
        }
        val html = File("src/main/assets/campsite-games.html").readText()
        assertEquals("the page carries the pack marker exactly once", 1, html.split(CampsitePagePacks.MARKER).size - 1)
        val packed = CampsitePagePacks.apply(html, listOf(js))
        assertFalse(packed.contains(CampsitePagePacks.MARKER))
        assertTrue(packed.contains("PACK_A.draw.plates"))
        assertTrue(packed.indexOf("PACK_A.draw.plates") < packed.lastIndexOf("poll();"))
        // The hooks the page needs are all in the base page.
        assertTrue(html.contains("const PACK_A = {lobby:{}, draw:{}};"))
        assertTrue(html.contains("PACK_A.lobby[r.game]"))
        assertTrue(html.contains("PACK_A.draw[r.game]"))
        // An older page with no marker is left alone.
        assertEquals("<html></html>", CampsitePagePacks.apply("<html></html>", listOf(js)))
    }

    // ---- a match with no server (spectator and direct checks) ---------------------------------

    private class TestCtx : MatchContext {
        override val random: Random = Random(1)
        var clock = 1_000L
        override fun now(): Long = clock
        override fun nameOf(playerId: String): String = playerId.uppercase()
        override fun leader(): String = "a"
        override fun nextRound() {}
        override fun trivia(count: Int): List<TriviaQuestion> = emptyList()
    }

    @Test
    fun `the summary counts the best list in a race and the shared list in a team round`() {
        val ctx = TestCtx()
        val race = PlateHuntGame.create(listOf("a", "b"), "region=usa;mode=race", ctx) as PlateHuntReporting
        val move = { who: String, c: Int -> GameMove(who, "spot", buildJsonObject { put("cell", c) }) }
        val m = race as com.beeboentertainment.movie.campsite.games.GameMatch
        m.apply(move("a", 1)); m.apply(move("a", 2)); m.apply(move("b", 3))
        val s = race.plateSummary()
        assertEquals(2, s.found)
        assertFalse(s.team)
        assertEquals(mapOf("a" to 2, "b" to 1), s.perPlayer)
        assertNotNull(PlateHuntRecords.tally("x", s, listOf("A")))
        assertEquals("Best list: 2 of 51 jurisdictions", PlateHuntRecords.tally("x", s, listOf("A"))!!.text)
        assertNull(PlateHuntRecords.tally("x", s.copy(found = 0), listOf("A")))
    }

    @Test
    fun `an unknown player or action is refused`() {
        val ctx = TestCtx()
        val m = PlateHuntGame.create(listOf("a"), "region=usa;mode=team", ctx)
        assertThrowsIae { m.apply(GameMove("stranger", "spot", buildJsonObject { put("cell", 1) })) }
        assertThrowsIae { m.apply(GameMove("a", "explode", buildJsonObject { })) }
        assertThrowsIae { m.apply(GameMove("a", "spot", buildJsonObject { put("cell", 99) })) }
        assertThrowsIae { m.apply(GameMove("a", "spot", buildJsonObject { })) }
    }

    private fun assertThrowsIae(block: () -> Unit) {
        try { block(); throw AssertionError("expected IllegalArgumentException") } catch (_: IllegalArgumentException) {}
    }
}
