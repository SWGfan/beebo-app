package com.beeboentertainment.movie.campsite.hunt

import com.beeboentertainment.movie.campsite.family.FakeClock
import com.beeboentertainment.movie.campsite.family.FamilyReply
import com.beeboentertainment.movie.trip.StoryResult
import com.beeboentertainment.movie.trip.TallyResult
import com.beeboentertainment.movie.trip.TripMomentSink
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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
import kotlin.random.Random

/** The hunt as a guest and the host phone see it: JSON views, limits, hostile names, and what a finished hunt leaves behind. */
class HuntServiceTest {

    private val clock = FakeClock()
    private var quiet = false
    private val trip = RecordingTrip()
    private val badges = RecordingBadges()

    private class RecordingTrip : TripMomentSink {
        val hunts = mutableListOf<TallyResult>()
        val tallies = mutableListOf<TallyResult>()
        override fun story(story: StoryResult) {}
        override fun tally(tally: TallyResult) { tallies += tally }
        override fun huntCard(tally: TallyResult) { hunts += tally }
    }

    private class RecordingBadges : HuntBadgeSink {
        val rounds = mutableListOf<Pair<Int, Boolean>>()
        override fun finished(found: Int, complete: Boolean) { rounds += found to complete }
    }

    private fun service() = HuntService(clock, Random(3), trip, badges, quiet = { quiet })

    private fun body(action: String, vararg extra: Pair<String, String>): JsonObject = buildJsonObject {
        put("action", action)
        extra.forEach { (k, v) -> if (v.toIntOrNull() != null && k == "team") put(k, v.toInt()) else put(k, v) }
    }

    private fun json(r: FamilyReply): JsonObject = r.body
    private fun JsonObject.str(key: String) = this[key]!!.jsonPrimitive.content
    private fun JsonObject.obj(key: String) = this[key]!!.jsonObject
    private fun JsonObject.items() = this["items"]!!.jsonArray.map { it.jsonObject }
    private fun JsonObject.board() = this["board"]!!.jsonArray.map { it.jsonObject }

    private fun settings(
        teams: Int = 0, approval: Boolean = false, timer: Int = 0, photos: Boolean = false, potd: Boolean = false,
        card: String = "camp-basics", band: HuntBand = HuntBand.MIDDLE, count: Int = 8,
    ) = HuntSettings(cardId = card, band = band, itemCount = count, teams = teams, timerMinutes = timer, approval = approval, photos = photos, photoOfDay = potd)

    private fun HuntService.join(token: String, name: String) = post(token, name, body("join"))

    private fun HuntService.itemIds(token: String): List<String> = get(token, "x").body.items().map { it.str("id") }

    // ---- idle and host errors --------------------------------------------------------------

    @Test fun withNoHuntTheGuestIsToldSoAndCannotPost() {
        val s = service()
        val view = json(s.get("a", "Ann"))
        assertEquals("idle", view.str("phase"))
        assertEquals(409, s.post("a", "Ann", body("join")).status)
        assertEquals(409, s.post("a", "Ann", body("tick", "item" to "cb-red")).status)
        assertNotNull(s.start())
        assertEquals(HuntHostState.NONE, s.hostState())
    }

    @Test fun anUnknownCardIsRefusedAndNothingIsOpened() {
        val s = service()
        assertEquals("That card is not available.", s.open(settings(card = "no-such-card")))
        assertEquals("idle", json(s.get("a", "Ann")).str("phase"))
    }

    @Test fun aBingoHuntOpensWithItsGridAndAListWithItsCount() {
        val s = service()
        assertNull(s.open(settings(card = "hike-bingo", band = HuntBand.OLDER)))
        s.join("a", "Ann")
        val bingo = json(s.get("a", "Ann"))
        assertEquals("bingo", bingo.obj("card").str("layout")); assertEquals("5", bingo.obj("card").str("grid"))
        assertEquals("25", bingo.str("total"))
        assertNull(s.open(settings(count = 12)))
        assertEquals("12", json(s.get("a", "Ann")).str("total"))
    }

    // ---- a whole hunt ----------------------------------------------------------------------

    @Test fun aGuestJoinsThePlayerSeesTheListAndTheirTicksScore() {
        val s = service()
        assertNull(s.open(settings()))
        val joined = json(s.join("tok-a", "Ann"))
        assertEquals("lobby", joined.str("phase"))
        assertEquals("Ann", joined.obj("me").str("name"))
        assertTrue("the list is not sent before the start", joined.items().isEmpty())
        assertNull(s.start())
        val running = json(s.get("tok-a", "Ann"))
        assertEquals("running", running.str("phase"))
        assertEquals(8, running.items().size)
        val first = running.items().first()
        assertEquals("none", first.str("state"))
        val ticked = json(s.post("tok-a", "Ann", body("tick", "item" to first.str("id"))))
        assertEquals("found", ticked.items().first { it.str("id") == first.str("id") }.str("state"))
        assertEquals("1", ticked.obj("me").str("found"))
        assertEquals("1", ticked.obj("me").str("rank"))
        assertTrue(ticked.board().single().str("you").toBoolean())
    }

    @Test fun aPostFromSomebodyNotYetJoinedJoinsThemFirst() {
        val s = service()
        s.open(settings()); s.join("tok-a", "Ann"); s.start()
        val id = s.itemIds("tok-a").first()
        val reply = s.post("tok-b", "Ben", body("tick", "item" to id))
        assertEquals(200, reply.status)
        assertEquals("Ben", reply.body.obj("me").str("name"))
        assertEquals("1", reply.body.obj("me").str("found"))
    }

    @Test fun theViewNeverCarriesATokenAnotherTeamsListOrAnythingPrivate() {
        val s = service()
        s.open(settings(teams = 2))
        s.join("secret-token-a", "Ann"); s.join("secret-token-b", "Ben")
        s.start()
        val aItems = s.itemIds("secret-token-a")
        s.post("secret-token-a", "Ann", body("tick", "item" to aItems.first()))
        val forB = json(s.get("secret-token-b", "Ben"))
        assertEquals("none", forB.items().first { it.str("id") == aItems.first() }.str("state"))
        val everything = listOf(forB, json(s.get("secret-token-a", "Ann")), json(s.get("nobody", "X"))).joinToString("|")
        assertFalse(everything.contains("secret-token"))
        assertFalse(everything.contains("p:") || everything.contains("t:0"))
        // A spectator gets the board but no list.
        val spectator = json(s.get("nobody", "X"))
        assertTrue(spectator.items().isEmpty())
        assertEquals(2, spectator.board().size)
    }

    @Test fun teamRowsShowMembersAndTheSameHuntEndsForEveryoneAtOnce() {
        val s = service()
        s.open(settings(teams = 2))
        s.join("a", "Ann"); s.join("b", "Ben"); s.start()
        val v = json(s.get("a", "Ann"))
        assertEquals("teams", v.str("mode"))
        assertEquals(listOf("Red", "Blue"), v["teamNames"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(setOf("Team Red", "Team Blue"), v.board().map { it.str("name") }.toSet())
        s.end()
        assertEquals("done", json(s.get("a", "Ann")).str("phase"))
        assertEquals("done", json(s.get("b", "Ben")).str("phase"))
    }

    @Test fun approvalFlowsThroughTheServiceAndOnlyApprovedFindsCount() {
        val s = service()
        s.open(settings(approval = true)); s.join("a", "Ann"); s.start()
        val ids = s.itemIds("a")
        val pending = json(s.post("a", "Ann", body("tick", "item" to ids[0])))
        assertEquals("pending", pending.items()[0].str("state"))
        assertEquals("0", pending.obj("me").str("points"))
        assertEquals("1", pending.obj("me").str("pending"))
        val host = s.hostState()
        assertEquals(1, host.pending.size)
        assertNull(s.approve(host.pending.single().entityKey, host.pending.single().itemId))
        assertEquals("found", json(s.get("a", "Ann")).items()[0].str("state"))
        s.post("a", "Ann", body("tick", "item" to ids[1])); s.post("a", "Ann", body("tick", "item" to ids[2]))
        assertEquals(2, s.approveAll())
        s.remove("p:a", ids[2])
        assertEquals("none", json(s.get("a", "Ann")).items()[2].str("state"))
    }

    @Test fun theTimerRunsOutOnItsOwnAndTheFirstLookAfterwardsSeesItFinished() {
        val s = service()
        s.open(settings(timer = 10)); s.join("a", "Ann"); s.start()
        val id = s.itemIds("a").first()
        s.post("a", "Ann", body("tick", "item" to id))
        val mid = json(s.get("a", "Ann"))
        assertEquals("600000", mid.str("remainingMs"))
        clock.advance(10 * 60_000L + 5)
        val after = json(s.get("a", "Ann"))
        assertEquals("done", after.str("phase"))
        assertEquals("true", after.obj("ended").str("timedOut"))
        assertEquals("600000", after.obj("ended").str("durationMs"))
        assertEquals(1, trip.hunts.size)
        assertEquals(409, s.post("a", "Ann", body("tick", "item" to s.itemIds("a").getOrElse(1) { "x" })).status)
    }

    // ---- hostile input ---------------------------------------------------------------------

    @Test fun hostileNicknamesReachNobodyAsMarkup() {
        val s = service()
        s.open(settings(teams = 0))
        val hostile = listOf("<img src=x onerror=alert(1)>", "<script>alert(1)</script>", "\"><svg onload=alert(1)>", "shit", "5h1t", "me@x.com")
        hostile.forEachIndexed { i, name -> s.join("t$i", name) }
        s.start()
        val view = json(s.get("t0", "x")).toString()
        assertFalse(view.contains("<")); assertFalse(view.contains(">")); assertFalse(view.contains("onerror=alert(1)>"))
        val names = json(s.get("t0", "x")).board().map { it.str("name") }
        assertTrue("rude and contact names become Camper", names.count { it.startsWith("Camper") } >= 3)
        assertEquals("names are unique", names.size, names.toSet().size)
        assertFalse(names.any { it.lowercase().contains("shit") || it.contains("@") })
    }

    @Test fun wrongTypedOrHugeFieldsAreRefusedNotTrusted() {
        val s = service()
        s.open(settings()); s.join("a", "Ann"); s.start()
        assertEquals(409, s.post("a", "Ann", body("tick", "item" to "x".repeat(500))).status)
        assertEquals(409, s.post("a", "Ann", buildJsonObject { put("action", "tick"); put("item", 5) }).status)
        assertEquals(409, s.post("a", "Ann", buildJsonObject { put("action", "tick") }).status)
        assertEquals(409, s.post("a", "Ann", body("format-the-phone")).status)
        assertEquals(409, s.post("a", "Ann", buildJsonObject { put("action", 7) }).status)
        assertEquals(409, s.post("a", "Ann", buildJsonObject {}).status)
        assertEquals("nothing was ticked", "0", json(s.get("a", "Ann")).obj("me").str("found"))
    }

    // ---- rate limits -----------------------------------------------------------------------

    @Test fun writesAreLimitedPerGuestAndRecoverWithTime() {
        val s = service()
        s.open(settings()); s.join("a", "Ann")
        val statuses = (1..25).map { s.post("a", "Ann", body("join")).status }
        assertEquals(19, statuses.count { it == 200 })      // one write (the join above) is already used
        assertEquals(6, statuses.count { it == 429 })
        assertEquals("another guest is unaffected", 200, s.post("b", "Ben", body("join")).status)
        clock.advance(10_001)
        assertEquals(200, s.post("a", "Ann", body("join")).status)
    }

    @Test fun ticksAreLimitedMoreTightlyThanOtherWrites() {
        val s = service()
        s.open(settings(count = 20)); s.join("a", "Ann"); s.start()
        val ids = s.itemIds("a")
        val statuses = ids.take(12).map { s.post("a", "Ann", body("tick", "item" to it)).status }
        assertEquals(10, statuses.count { it == 200 })
        assertEquals(2, statuses.count { it == 429 })
        clock.advance(10_001)
        assertEquals(200, s.post("a", "Ann", body("tick", "item" to ids[11])).status)
    }

    @Test fun readsAreLimitedToSixtyPerTenSeconds() {
        val s = service()
        s.open(settings())
        val statuses = (1..70).map { s.get("a", "Ann").status }
        assertEquals(60, statuses.count { it == 200 }); assertEquals(10, statuses.count { it == 429 })
        assertEquals(200, s.get("b", "Ben").status)
    }

    @Test fun aFullHuntRefusesTheTwentyFifthAndShowsThemTheBoard() {
        val s = service()
        s.open(settings())
        (1..HuntSession.MAX_PLAYERS).forEach { assertEquals(200, s.join("t$it", "P$it").status) }
        val refused = s.join("late", "Late")
        assertEquals(409, refused.status)
        assertEquals("This hunt is full.", refused.body.str("error"))
        assertEquals(HuntSession.MAX_PLAYERS, json(s.get("late", "Late")).board().size)
    }

    // ---- what a finished hunt leaves behind ------------------------------------------------

    @Test fun aFinishedHuntWritesOneCountsOnlyTripLineAndTwoBadgeNumbers() {
        val s = service()
        s.open(settings(count = 8)); s.join("a", "Ann"); s.join("b", "Ben"); s.start()
        val ids = s.itemIds("a")
        ids.take(5).forEach { s.post("a", "Ann", body("tick", "item" to it)); clock.advance(3_000) }
        s.end()
        s.end(); s.get("a", "Ann"); s.hostState()
        assertEquals("written once however often it is looked at", 1, trip.hunts.size)
        val line = trip.hunts.single()
        assertEquals(5, line.found); assertEquals(8, line.total)
        assertTrue(line.text, line.text.contains("Camp Basics") && line.text.contains("5 of 8") && line.text.contains("2 players"))
        assertEquals(listOf("Ann", "Ben"), line.names)
        assertTrue("no item text in the line", HuntCards.CAMP_BASICS.items.none { line.text.contains(it.text) || line.title.contains(it.text) })
        assertTrue(trip.tallies.isEmpty())
        assertEquals(listOf(5 to false), badges.rounds)
    }

    @Test fun findingEverythingIsACompleteCardForTheBadge() {
        val s = service()
        s.open(settings(count = 8)); s.join("a", "Ann"); s.start()
        s.itemIds("a").forEach { s.post("a", "Ann", body("tick", "item" to it)); clock.advance(2_000) }
        assertEquals("done", json(s.get("a", "Ann")).str("phase"))
        assertEquals(listOf(8 to true), badges.rounds)
        assertTrue(trip.hunts.single().text.contains("8 of 8"))
    }

    @Test fun togetherAndTeamHuntsSayTheirOwnWords() {
        val together = service()
        together.open(settings(teams = 1)); together.join("a", "Ann"); together.start()
        together.post("a", "Ann", body("tick", "item" to together.itemIds("a").first())); together.end()
        assertTrue(trip.hunts.last().text, trip.hunts.last().text.contains("together"))
        val teams = service()
        teams.open(settings(teams = 2)); teams.join("a", "Ann"); teams.join("b", "Ben"); teams.start()
        teams.post("a", "Ann", body("tick", "item" to teams.itemIds("a").first())); teams.end()
        assertTrue(trip.hunts.last().text, trip.hunts.last().text.contains("2 teams"))
    }

    @Test fun aHuntWithNothingFoundWritesNothing() {
        val s = service()
        s.open(settings()); s.join("a", "Ann"); s.start(); s.end()
        assertTrue(trip.hunts.isEmpty()); assertTrue(badges.rounds.isEmpty())
        // Leaving a hunt in the lobby, or closing it, writes nothing either.
        s.open(settings()); s.close()
        assertTrue(trip.hunts.isEmpty())
    }

    @Test fun closingAFinishedHuntKeepsItsRecordAndStartingANewOneWritesAgain() {
        val s = service()
        s.open(settings()); s.join("a", "Ann"); s.start()
        s.post("a", "Ann", body("tick", "item" to s.itemIds("a").first()))
        s.end(); s.close()
        assertEquals(1, trip.hunts.size)
        assertEquals("idle", json(s.get("a", "Ann")).str("phase"))
        clock.advance(1_000)
        s.open(settings()); s.join("a", "Ann"); s.start()
        s.post("a", "Ann", body("tick", "item" to s.itemIds("a").first())); s.end()
        assertEquals(2, trip.hunts.size)
        assertTrue("each hunt has its own id", trip.hunts[0].id != trip.hunts[1].id)
    }

    @Test fun anAbandonedRunningHuntStillRecordsWhatWasFoundWhenItIsClosed() {
        val s = service()
        s.open(settings(timer = 10)); s.join("a", "Ann"); s.start()
        s.post("a", "Ann", body("tick", "item" to s.itemIds("a").first()))
        clock.advance(11 * 60_000L)
        s.close()
        assertEquals(1, trip.hunts.size)
    }

    @Test fun aSinkThatThrowsCannotBreakTheHunt() {
        val boom = object : TripMomentSink {
            override fun story(story: StoryResult) {}
            override fun huntCard(tally: TallyResult) { error("disk full") }
        }
        val badBadges = object : HuntBadgeSink { override fun finished(found: Int, complete: Boolean) { error("prefs") } }
        val s = HuntService(clock, Random(1), boom, badBadges)
        s.open(settings()); s.join("a", "Ann"); s.start()
        s.post("a", "Ann", body("tick", "item" to s.itemIds("a").first()))
        s.end()
        assertEquals("done", json(s.get("a", "Ann")).str("phase"))
    }

    // ---- photo of the day, quiet hours ------------------------------------------------------

    @Test fun thePhotoOfTheDayHasAPromptAndOnlyEverCountsAYes() {
        val s = service()
        s.open(settings(photos = true, potd = true)); s.join("a", "Ann"); s.join("b", "Ben")
        val lobby = json(s.get("a", "Ann"))
        assertEquals("true", lobby.str("photoOfDay"))
        assertTrue(HuntPhotoPrompts.ALL.contains(lobby.str("photoPrompt")))
        s.start()
        val said = json(s.post("a", "Ann", body("potd")))
        assertEquals("1", said.str("photoCount"))
        assertEquals("true", said.obj("me").str("photoDone"))
        assertEquals("false", json(s.get("b", "Ben")).obj("me").str("photoDone"))
        // No field anywhere could carry a picture, a file name or a place.
        val all = said.toString().lowercase()
        listOf("blob", "data:image", "base64", "filename", "exif", "gps", "lat\"", "lng\"", "latitude", "longitude").forEach { assertFalse(it, all.contains(it)) }
        assertEquals(1, s.hostState().photoCount)
    }

    @Test fun withoutTheOptionThereIsNoPromptAndAYesIsRefused() {
        val s = service()
        s.open(settings(photos = true, potd = false)); s.join("a", "Ann"); s.start()
        val v = json(s.get("a", "Ann"))
        assertEquals("", v.str("photoPrompt"))
        assertEquals(409, s.post("a", "Ann", body("potd")).status)
        // A photo-of-the-day request without photos on is switched off at the source.
        s.open(settings(photos = false, potd = true)); s.join("a", "Ann")
        assertEquals("false", json(s.get("a", "Ann")).str("photoOfDay"))
    }

    @Test fun theQuietHoursFlagReachesEveryViewSoThePageCanStaySilent() {
        val s = service()
        assertEquals("false", json(s.get("a", "Ann")).str("quiet"))
        quiet = true
        assertEquals("true", json(s.get("a", "Ann")).str("quiet"))
        s.open(settings()); s.join("a", "Ann")
        assertEquals("true", json(s.get("a", "Ann")).str("quiet"))
    }

    // ---- host state ------------------------------------------------------------------------

    @Test fun theHostStateShowsTheLobbyTheRunningHuntAndTheEnd() {
        val s = service()
        s.open(settings(teams = 2, timer = 20))
        s.join("a", "Ann"); s.join("b", "Ben")
        var host = s.hostState()
        assertEquals(HuntPhase.LOBBY, host.phase)
        assertEquals("Camp Basics", host.cardTitle)
        assertEquals(2, host.players.size)
        s.start()
        clock.advance(65_000)
        host = s.hostState()
        assertEquals(HuntPhase.RUNNING, host.phase)
        assertEquals(20 * 60_000L - 65_000, host.remainingMs)
        assertEquals(65_000L, host.elapsedMs)
        s.post("a", "Ann", body("tick", "item" to s.itemIds("a").first()))
        s.end()
        host = s.hostState()
        assertEquals(HuntPhase.DONE, host.phase)
        assertTrue(host.stoppedByHost)
        assertEquals(listOf("Team Red"), host.winners.map { it.name })
        assertTrue(host.contributions.any { it.first == "Ann" && it.second > 0 })
    }

    @Test fun bodiesAreJsonPrimitivesOnly() {
        // The test helper builds every body from strings and ints, and the service reads only those two kinds.
        val s = service()
        s.open(settings(teams = 2)); s.join("a", "Ann")
        val reply = s.post("a", "Ann", buildJsonObject { put("action", "team"); put("team", JsonPrimitive("1")) })
        assertEquals(409, reply.status)                       // a string where a number belongs is not trusted
        assertEquals(200, s.post("a", "Ann", body("team", "team" to "1")).status)
    }
}
