package com.beeboentertainment.auto.party

import com.beeboentertainment.auto.party.ViewerSync.Local
import com.beeboentertainment.auto.party.ViewerSync.Plan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewerSyncTest {

    private val film = "movie:42"
    private val playing = Local(positionMs = 60_000, playWhenReady = true, videoId = film)
    private val paused = playing.copy(playWhenReady = false)

    @Test
    fun smallDriftIsLeftAlone() {
        val plan = ViewerSync.onSync(playing, 60_200, true, film, audioDelayMs = 0, blocked = false)
        assertTrue(plan.isNoop)
    }

    @Test
    fun largeDriftSeeksToTheHost() {
        val plan = ViewerSync.onSync(playing, 64_000, true, film, audioDelayMs = 0, blocked = false)
        assertEquals(Plan(seekToMs = 64_000), plan)
    }

    @Test
    fun positiveAudioDelayPullsThePictureBack() {
        assertEquals(59_700, ViewerSync.target(60_000, 300))
        assertEquals(60_300, ViewerSync.target(60_000, -300))
        assertEquals(0, ViewerSync.target(100, 500))
        // 60_000 local vs host 60_600 with 400ms delay -> target 60_200, drift 200: no seek.
        assertTrue(ViewerSync.onSync(playing, 60_600, true, film, 400, false).isNoop)
    }

    @Test
    fun syncMatchesThePlayState() {
        assertEquals(true, ViewerSync.onSync(paused, 60_000, true, film, 0, false).play)
        assertEquals(false, ViewerSync.onSync(playing, 60_000, false, film, 0, false).play)
    }

    @Test
    fun blockedViewerIsPausedAndNeverStarted() {
        val sync = ViewerSync.onSync(playing, 90_000, true, film, 0, blocked = true)
        assertEquals(Plan(play = false), sync)
        assertTrue(ViewerSync.onSync(paused, 90_000, true, film, 0, blocked = true).isNoop)
        val play = ViewerSync.onControl(paused, "play", 90_000, null, 0, blocked = true)!!
        assertTrue(play.play != true)
    }

    @Test
    fun aNewTitleInABeatLoadsItOnce() {
        val other = "tv:7"
        assertEquals(other, ViewerSync.onSync(playing, 0, true, other, 0, false).loadVideoId)
        val resolving = playing.copy(pendingVideoId = other)
        assertNull(ViewerSync.onSync(resolving, 0, true, other, 0, false).loadVideoId)
        // Older hosts send no videoId: never unload what's playing.
        assertNull(ViewerSync.onSync(playing, 60_000, true, null, 0, false).loadVideoId)
    }

    @Test
    fun controlsApply() {
        assertEquals(Plan(seekToMs = 10_000), ViewerSync.onControl(playing, "seek", 10_000, null, 0, false))
        assertEquals(Plan(play = true), ViewerSync.onControl(paused, "play", 60_100, null, 0, false))
        assertEquals(Plan(seekToMs = 5_000, play = false), ViewerSync.onControl(playing, "pause", 5_000, null, 0, false))
        assertEquals("tv:9", ViewerSync.onControl(playing, "load", 0, "tv:9", 0, false)!!.loadVideoId)
        assertNull("games share the room and are ignored", ViewerSync.onControl(playing, "game", 3, "{}", 0, false))
    }

    @Test
    fun onlyHostsDriveTheParty() {
        val roster = listOf(
            RoomMember("h", "Car phone", "host"),
            RoomMember("v", "Tablet", "viewer"),
            RoomMember("me", "Me", "viewer"),
        )
        assertTrue(ViewerSync.acceptsFrom("h", "me", roster))
        assertFalse(ViewerSync.acceptsFrom("v", "me", roster))
        assertFalse(ViewerSync.acceptsFrom("me", "me", roster))
        // No host listed (older build or roster not in yet): accept others, as before.
        assertTrue(ViewerSync.acceptsFrom("v", "me", roster.filter { it.role != "host" }))
    }
}
