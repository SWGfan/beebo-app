package com.beeboentertainment.movie.campsite.hunt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** One hunt: solo, everyone together, teams, host approval, the timer, and the rules that keep it fair. */
class HuntSessionTest {

    private var now = 1_000_000L

    private fun items(n: Int = 6): List<HuntItem> =
        (1..n).map { HuntItem("i$it", "Find thing $it", if (it <= 4) HuntBand.LITTLE else HuntBand.MIDDLE) }

    private fun session(
        settings: HuntSettings = HuntSettings(),
        n: Int = 6,
        layout: HuntLayout = HuntLayout.LIST,
        grid: Int = 0,
    ): HuntSession {
        val card = HuntCard("test", "Test card", "x", "blurb", layout, "where", items(n))
        return HuntSession(settings, card, items(n), grid, "Photograph something round.", now)
    }

    private fun running(settings: HuntSettings = HuntSettings(), vararg who: String): HuntSession {
        val s = session(settings)
        who.forEach { assertNull(s.join(it, it.uppercase(), now)) }
        assertNull(s.start(now))
        return s
    }

    // ---- lobby -----------------------------------------------------------------------------

    @Test fun aHuntNeedsAPlayerBeforeItStarts() {
        val s = session()
        assertNotNull(s.start(now))
        assertEquals(HuntPhase.LOBBY, s.phase)
        assertNull(s.join("a", "Ann", now))
        assertNull(s.start(now))
        assertEquals(HuntPhase.RUNNING, s.phase)
        assertNotNull("a second start is refused", s.start(now))
    }

    @Test fun nobodyCanTickBeforeTheStart() {
        val s = session()
        s.join("a", "Ann", now)
        assertNotNull(s.tick("a", "i1", now))
        assertEquals(0, s.rows(now).single().found)
    }

    @Test fun joiningTwiceKeepsOnePlayerAndDuplicateNamesGetANumber() {
        val s = session()
        assertNull(s.join("a", "Ann", now)); assertNull(s.join("a", "Other", now))
        assertNull(s.join("b", "Ann", now))
        assertEquals(2, s.playerCount)
        assertEquals("Ann", s.nameOf("a")); assertEquals("Ann 2", s.nameOf("b"))
    }

    @Test fun aHuntHoldsAtMostTwentyFourPlayers() {
        val s = session()
        (1..HuntSession.MAX_PLAYERS).forEach { assertNull(s.join("t$it", "P$it", now)) }
        assertEquals("This hunt is full.", s.join("extra", "Late", now))
        assertFalse(s.hasPlayer("extra"))
        // Somebody already in still gets back in.
        assertNull(s.join("t1", "P1", now))
    }

    @Test fun teamsAreChosenInTheLobbyAndFixedAfterwards() {
        val s = session(HuntSettings(teams = 3))
        s.join("a", "Ann", now); s.join("b", "Ben", now); s.join("c", "Cy", now); s.join("d", "Di", now)
        // New players go to the smallest team, so the teams stay balanced.
        assertEquals(listOf(0, 1, 2, 0), listOf("a", "b", "c", "d").map { s.teamOf(it) })
        assertNull(s.setTeam("d", 2, now))
        assertEquals(2, s.teamOf("d"))
        assertNotNull(s.setTeam("d", 3, now)); assertNotNull(s.setTeam("d", -1, now))
        s.start(now)
        assertNotNull(s.setTeam("d", 1, now))
        assertEquals(2, s.teamOf("d"))
        // No team to choose in solo or together.
        assertNotNull(session(HuntSettings(teams = 0)).also { it.join("a", "A", now) }.setTeam("a", 0, now))
        assertNotNull(session(HuntSettings(teams = 1)).also { it.join("a", "A", now) }.setTeam("a", 0, now))
    }

    // ---- solo ------------------------------------------------------------------------------

    @Test fun inSoloEveryPlayerHasTheirOwnList() {
        val s = running(HuntSettings(teams = 0), "a", "b")
        assertNull(s.tick("a", "i1", now)); assertNull(s.tick("a", "i2", now)); assertNull(s.tick("b", "i1", now))
        val rows = s.rows(now).associateBy { it.name }
        assertEquals(2, rows.getValue("A").found)
        assertEquals(1, rows.getValue("B").found)
        assertEquals(listOf("found", "found", "none"), s.itemsFor("a").take(3).map { it.state })
        assertEquals(listOf("found", "none", "none"), s.itemsFor("b").take(3).map { it.state })
    }

    @Test fun aSecondTapOnSomethingFoundIsNotAnErrorAndChangesNothing() {
        val s = running(HuntSettings(), "a")
        assertNull(s.tick("a", "i1", now))
        now += 5_000
        assertNull(s.tick("a", "i1", now))
        val row = s.rows(now).single()
        assertEquals(1, row.found)
        assertEquals("the time of the first find stands", 1_000_000L, row.lastAt)
    }

    @Test fun anUnknownItemOrAnUnjoinedGuestIsRefused() {
        val s = running(HuntSettings(), "a")
        assertEquals("That is not on this hunt.", s.tick("a", "nope", now))
        assertEquals("Join the hunt first.", s.tick("stranger", "i1", now))
        assertEquals("Join the hunt first.", s.untick("stranger", "i1", now))
    }

    @Test fun pointsFollowTheBandAndARankedLeaderboardShowsThem() {
        val s = running(HuntSettings(), "a", "b")
        s.tick("a", "i1", now)              // little: 1
        s.tick("b", "i5", now + 1)          // middle: 2
        val rows = s.rows(now)
        assertEquals(listOf("B", "A"), rows.map { it.name })
        assertEquals(listOf(2, 1), rows.map { it.points })
        assertEquals(listOf(1, 2), rows.map { it.rank })
    }

    @Test fun withApointsTieTheEarlierFindWins() {
        val s = running(HuntSettings(), "a", "b")
        s.tick("b", "i1", now + 10)
        s.tick("a", "i2", now + 50)
        assertEquals(listOf("B", "A"), s.rows(now).map { it.name })
        s.end(now + 100)
        assertEquals(listOf("B"), s.winners(now).map { it.name })
    }

    // ---- teams and together ----------------------------------------------------------------

    @Test fun aTeamShareOneListAndAFindByAnyMemberCountsOnce() {
        val s = running(HuntSettings(teams = 2), "a", "b", "c", "d")
        // a and c are on Red (0), b and d on Blue (1).
        assertNull(s.tick("a", "i1", now))
        assertNull(s.tick("c", "i1", now))           // teammate taps the same item: nothing changes
        assertNull(s.tick("c", "i2", now))
        val red = s.rows(now).first { it.name == "Team Red" }
        val blue = s.rows(now).first { it.name == "Team Blue" }
        assertEquals(2, red.found); assertEquals(0, blue.found)
        assertEquals(2, red.members)
        val cView = s.itemsFor("c")
        assertEquals("A", cView[0].by); assertFalse(cView[0].mine)
        assertEquals("C", cView[1].by); assertTrue(cView[1].mine)
        // Blue's list is separate: it can find the same item.
        assertNull(s.tick("b", "i1", now))
        assertEquals(1, s.rows(now).first { it.name == "Team Blue" }.found)
    }

    @Test fun anotherTeamsListIsNeverInAPlayersView() {
        val s = running(HuntSettings(teams = 2), "a", "b")
        s.tick("a", "i3", now)
        assertEquals("none", s.itemsFor("b").first { it.item.id == "i3" }.state)
        assertEquals("", s.itemsFor("b").first { it.item.id == "i3" }.by)
    }

    @Test fun everyoneTogetherIsOneSharedListAndOneRow() {
        val s = running(HuntSettings(teams = 1), "a", "b", "c")
        s.tick("a", "i1", now); s.tick("b", "i2", now); s.tick("c", "i1", now)
        val rows = s.rows(now)
        assertEquals(1, rows.size)
        assertEquals("Everyone", rows.single().name)
        assertEquals(3, rows.single().members)
        assertEquals(2, rows.single().found)
        assertEquals(-1, s.teamOf("a"))
    }

    @Test fun anEmptyTeamIsNotOnTheBoardAndWhoFoundWhatIsCounted() {
        val s = running(HuntSettings(teams = 4), "a", "b")
        assertEquals(2, s.rows(now).size)
        s.tick("a", "i1", now); s.tick("a", "i5", now)
        assertEquals(listOf("A" to 3, "B" to 0), s.contributions())
    }

    // ---- approval --------------------------------------------------------------------------

    private val approving = HuntSettings(approval = true)

    @Test fun withApprovalATickOnlyCountsAfterTheHostSaysYes() {
        val s = running(approving, "a")
        s.tick("a", "i1", now)
        assertEquals(0, s.rows(now).single().points)
        assertEquals(1, s.rows(now).single().pending)
        assertEquals("pending", s.itemsFor("a").first().state)
        val queue = s.pendingQueue()
        assertEquals(1, queue.size)
        assertEquals("Find thing 1", queue.single().itemText); assertEquals("A", queue.single().who)
        assertNull(s.approve(queue.single().entityKey, "i1", now))
        assertEquals(1, s.rows(now).single().points)
        assertEquals("found", s.itemsFor("a").first().state)
        assertTrue(s.pendingQueue().isEmpty())
    }

    @Test fun theHostCanTurnAFindDownAndTheGuestCanTryAgain() {
        val s = running(approving, "a")
        s.tick("a", "i1", now)
        val key = s.pendingQueue().single().entityKey
        s.remove(key, "i1", now)
        assertEquals("none", s.itemsFor("a").first().state)
        assertNull(s.tick("a", "i1", now))
        assertEquals("That find is not waiting.", s.approve(key, "i2", now))
    }

    @Test fun aGuestCanTakeBackAPendingFindButNotOneTheHostChecked() {
        val s = running(approving, "a", "b")
        s.tick("a", "i1", now)
        assertNull(s.untick("a", "i1", now))
        assertEquals("none", s.itemsFor("a").first().state)
        s.tick("a", "i1", now)
        s.approve(s.pendingQueue().single().entityKey, "i1", now)
        assertEquals("Your grown-up already checked that one.", s.untick("a", "i1", now))
        assertEquals("found", s.itemsFor("a").first().state)
    }

    @Test fun withoutApprovalAGuestCanUndoAtAnyTimeButOnlyTheirOwnFind() {
        val s = running(HuntSettings(teams = 1), "a", "b")
        s.tick("a", "i1", now)
        assertEquals("Only the person who found it can take it back.", s.untick("b", "i1", now))
        assertEquals("found", s.itemsFor("b").first().state)
        assertNull(s.untick("a", "i1", now))
        assertEquals("none", s.itemsFor("b").first().state)
        assertNull("undoing something not found is harmless", s.untick("a", "i2", now))
    }

    @Test fun aTeamCannotFloodTheHostsQueue() {
        val s = session(HuntSettings(approval = true), n = 10)
        s.join("a", "A", now); s.start(now)
        (1..HuntSession.MAX_PENDING).forEach { assertNull(s.tick("a", "i$it", now)) }
        assertEquals("Wait for your grown-up to check the finds you have sent.", s.tick("a", "i7", now))
        assertEquals(HuntSession.MAX_PENDING, s.pendingQueue().size)
        // Once the host clears one there is room again.
        val first = s.pendingQueue().first()
        assertNull(s.approve(first.entityKey, first.itemId, now))
        assertNull(s.tick("a", "i7", now))
    }

    @Test fun approveAllCountsEverythingWaiting() {
        val s = running(approving, "a", "b")
        s.tick("a", "i1", now); s.tick("a", "i2", now); s.tick("b", "i3", now)
        assertEquals(3, s.approveAll(now))
        assertEquals(0, s.approveAll(now))
        assertEquals(listOf(2, 1), s.rows(now).map { it.found })
    }

    @Test fun findsStillWaitingWhenTheHuntEndsDoNotCount() {
        val s = running(approving, "a")
        s.tick("a", "i1", now)
        s.end(now + 10)
        assertEquals(HuntPhase.DONE, s.phase)
        assertEquals(0, s.rows(now).single().points)
        assertEquals(emptyList<HuntRow>(), s.winners(now))
        assertNotNull("approving after the end is refused", s.approve("p:a", "i1", now))
    }

    // ---- ending ----------------------------------------------------------------------------

    @Test fun theTimerEndsTheHuntByItselfAtTheRightMoment() {
        val s = running(HuntSettings(timerMinutes = 10), "a")
        assertEquals(600_000L, s.remainingMs(now))
        now += 599_000
        assertNull(s.tick("a", "i1", now))
        assertEquals(1_000L, s.remainingMs(now))
        now += 1_000
        assertEquals("The hunt has finished.", s.tick("a", "i2", now))
        assertEquals(HuntPhase.DONE, s.phase)
        assertTrue(s.timedOut); assertFalse(s.stoppedByHost)
        assertEquals("the end time is the timer's, not the moment somebody looked", 1_000_000L + 600_000L, s.endedAt)
        assertEquals(1, s.rows(now).single().found)
        assertEquals(-1L, s.remainingMs(now))
    }

    @Test fun withNoTimerTheHuntRunsUntilTheHostEndsIt() {
        val s = running(HuntSettings(timerMinutes = 0), "a")
        now += 10L * 3_600_000
        assertEquals(HuntPhase.RUNNING, s.phase)
        assertEquals(-1L, s.remainingMs(now))
        s.end(now)
        assertTrue(s.stoppedByHost); assertFalse(s.timedOut)
        assertNotNull(s.tick("a", "i1", now))
    }

    @Test fun theHuntEndsWhenEveryoneHasFoundEverything() {
        val s = running(HuntSettings(), "a", "b")
        (1..6).forEach { s.tick("a", "i$it", now) }
        assertEquals("one player finishing does not end it for the others", HuntPhase.RUNNING, s.phase)
        (1..5).forEach { s.tick("b", "i$it", now) }
        assertEquals(HuntPhase.RUNNING, s.phase)
        s.tick("b", "i6", now + 3)
        assertEquals(HuntPhase.DONE, s.phase)
        assertTrue(s.allFinished)
        assertTrue(s.rows(now).all { it.done })
    }

    @Test fun aTeamHuntEndsWhenEveryTeamIsDone() {
        val s = running(HuntSettings(teams = 2), "a", "b")
        (1..6).forEach { s.tick("a", "i$it", now) }
        assertEquals(HuntPhase.RUNNING, s.phase)
        (1..6).forEach { s.tick("b", "i$it", now) }
        assertEquals(HuntPhase.DONE, s.phase)
    }

    @Test fun nobodyCanJoinAFinishedHuntButAGuestAlreadyInCanStillBeSeen() {
        val s = running(HuntSettings(), "a")
        s.end(now)
        assertEquals("This hunt has finished.", s.join("late", "Late", now))
        assertTrue(s.hasPlayer("a"))
    }

    @Test fun aGuestWhoJoinsInTheMiddleTakesUpTheirTeamsListOrStartsEmptyInSolo() {
        val teams = running(HuntSettings(teams = 2), "a", "b")
        teams.tick("a", "i1", now)
        assertNull(teams.join("late", "Late", now))
        assertEquals("Red and Blue have one player each, so the first team gets the newcomer", 0, teams.teamOf("late"))
        assertEquals("found", teams.itemsFor("late").first().state)
        val solo = running(HuntSettings(teams = 0), "a")
        solo.tick("a", "i1", now)
        assertNull(solo.join("late", "Late", now))
        assertEquals(0, solo.itemsFor("late").count { it.state != "none" })
    }

    // ---- bingo -----------------------------------------------------------------------------

    @Test fun aBingoHuntScoresSquaresAndLines() {
        val card = HuntCard("b", "Bingo", "x", "b", HuntLayout.BINGO, "w", items(9))
        val s = HuntSession(HuntSettings(), card, items(9), 3, "p", now)
        s.join("a", "Ann", now); s.start(now)
        listOf("i1", "i2", "i3").forEach { s.tick("a", it, now) }
        val row = s.rows(now).single()
        assertEquals(1, row.lines)
        assertEquals(3 + 2, row.points)
        assertEquals(9 + 8 * 2, s.maxPoints)
    }

    // ---- photo of the day ------------------------------------------------------------------

    @Test fun thePhotoOfTheDayIsOnlyAYesFromAPlayerAndNeedsTheOption() {
        val off = running(HuntSettings(photos = true, photoOfDay = false), "a")
        assertEquals("There is no photo of the day in this hunt.", off.photoTaken("a", now))
        val s = session(HuntSettings(photos = true, photoOfDay = true))
        s.join("a", "Ann", now)
        assertEquals("The photo of the day opens when the hunt starts.", s.photoTaken("a", now))
        s.start(now)
        assertNull(s.photoTaken("a", now)); assertNull(s.photoTaken("a", now))
        assertEquals(1, s.photoCount)
        assertTrue(s.photoDoneBy("a")); assertFalse(s.photoDoneBy("b"))
        assertEquals("Join the hunt first.", s.photoTaken("stranger", now))
    }
}
