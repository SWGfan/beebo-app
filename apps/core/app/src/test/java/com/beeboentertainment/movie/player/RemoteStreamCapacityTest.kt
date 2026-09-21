package com.beeboentertainment.movie.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RemoteStreamCapacityTest {
    @Test fun `capacity response shows the household viewing-spots message`() {
        assertEquals(
            RemoteStreamCapacity.MESSAGE,
            RemoteStreamCapacity.messageFor(429, mapOf("X-Beebo-Remote-Error" to listOf("away_stream_limit"))),
        )
    }

    @Test fun `a generic 429 never claims household viewing spots are full`() {
        assertNull(RemoteStreamCapacity.messageFor(429, mapOf("Retry-After" to listOf("60"))))
    }

    @Test fun `the capacity header without 429 is not treated as an admission refusal`() {
        assertNull(RemoteStreamCapacity.messageFor(503, mapOf("x-beebo-remote-error" to listOf("away_stream_limit"))))
    }

    @Test fun `a different remote error is not treated as capacity`() {
        assertNull(RemoteStreamCapacity.messageFor(429, mapOf("x-beebo-remote-error" to listOf("region_busy"))))
    }
}