package com.beeboentertainment.auto.party

import com.beeboentertainment.auto.webrtc.SignalingClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which hub closes end a room/signalling attempt, and what the user is told. */
class RoomFailureTest {

    @Test
    fun unauthorizedAndBadRequestAreTerminal() {
        assertNotNull(RoomClient.closeProblem(4001, null))
        assertTrue(RoomClient.closeProblem(4002, "missing name")!!.contains("missing name"))
    }

    @Test
    fun transportDropsAndNormalClosesReconnect() {
        assertNull(RoomClient.closeProblem(0, null))
        assertNull(RoomClient.closeProblem(1000, null))
        assertNull(RoomClient.closeProblem(1006, null))
    }

    @Test
    fun backoffDoublesAndCaps() {
        assertEquals(1_000, RoomClient.backoffMs(1))
        assertEquals(2_000, RoomClient.backoffMs(2))
        assertEquals(30_000, RoomClient.backoffMs(6))
        assertEquals(30_000, RoomClient.backoffMs(50))
        assertEquals(1_000, RoomClient.backoffMs(0))
    }

    @Test
    fun signallingClosesReadAsSentences() {
        assertTrue(SignalingClient.describeClose(4004, "pc offline", null).contains("isn't connected"))
        assertTrue(SignalingClient.describeClose(4001, "unauthorized", null).contains("Sign in again"))
        assertTrue(SignalingClient.describeClose(4002, "bad request", "missing session id").contains("missing session id"))
        assertTrue(SignalingClient.describeClose(1011, "", null).isNotBlank())
    }

    @Test
    fun syncBeatCarriesTheTitleAndOldBeatsStillDecode() {
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true; explicitNulls = false }
        assertEquals(
            """{"type":"sync","positionMs":5,"playing":true,"videoId":"movie:1"}""",
            json.encodeToString(OutSync(positionMs = 5, playing = true, videoId = "movie:1")),
        )
        assertEquals(
            """{"type":"sync","positionMs":5,"playing":false}""",
            json.encodeToString(OutSync(positionMs = 5, playing = false)),
        )
        // Every envelope names its type; the hub drops anything without one.
        assertTrue(json.encodeToString(OutControl(action = "play", positionMs = 1)).startsWith("""{"type":"control""""))
        assertEquals("""{"type":"bye"}""", json.encodeToString(OutBye()))
        val old = json.decodeFromString<SyncMsg>("""{"type":"sync","positionMs":9,"playing":true,"from":"h"}""")
        assertNull(old.videoId)
    }
}
