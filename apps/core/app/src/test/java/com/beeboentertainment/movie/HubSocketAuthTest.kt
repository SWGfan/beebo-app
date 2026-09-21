package com.beeboentertainment.movie

import com.beeboentertainment.movie.party.RoomRole
import com.beeboentertainment.movie.party.roomUpgradeRequest
import com.beeboentertainment.movie.webrtc.signalUpgradeRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The hub sockets carry the login token in the Authorization header, never in the URL,
 * because URLs end up in proxy, tunnel and crash logs.
 */
class HubSocketAuthTest {

    private val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2N0LTEifQ.sig"

    @Test fun `room socket sends the token as a bearer header and keeps it out of the URL`() {
        val req = roomUpgradeRequest("https://hub.example.com", jwt, "Sam's Phone", RoomRole.HOST)

        assertEquals("Bearer $jwt", req.header("Authorization"))
        assertNull(req.url.queryParameter("token"))
        assertFalse(req.url.toString().contains(jwt))
        assertEquals("/room", req.url.encodedPath)
        assertEquals("Sam's Phone", req.url.queryParameter("name"))
        assertEquals("host", req.url.queryParameter("role"))
    }

    @Test fun `signalling socket sends the token as a bearer header and keeps it out of the URL`() {
        val req = signalUpgradeRequest("https://hub.example.com", jwt, "sess-1")

        assertEquals("Bearer $jwt", req.header("Authorization"))
        assertNull(req.url.queryParameter("token"))
        assertFalse(req.url.toString().contains(jwt))
        assertEquals("/signal", req.url.encodedPath)
        assertEquals("sess-1", req.url.queryParameter("session"))
    }
}
