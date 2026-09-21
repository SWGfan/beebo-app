package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.SurfNav
import org.junit.Assert.assertEquals
import org.junit.Test

/** Previous/Next stepping in Surf mode has to wrap at both ends. */
class SurfNavTest {

    @Test
    fun `previous at zero wraps to the last item`() {
        assertEquals(39, SurfNav.previous(0, 40))
    }

    @Test
    fun `next at the last item wraps to zero`() {
        assertEquals(0, SurfNav.next(39, 40))
    }

    @Test
    fun `stepping in the middle is boring and correct`() {
        assertEquals(4, SurfNav.next(3, 40))
        assertEquals(2, SurfNav.previous(3, 40))
    }

    @Test
    fun `single item pool always lands on itself`() {
        assertEquals(0, SurfNav.next(0, 1))
        assertEquals(0, SurfNav.previous(0, 1))
    }

    @Test
    fun `empty pool never divides by zero`() {
        assertEquals(0, SurfNav.next(0, 0))
        assertEquals(0, SurfNav.previous(0, 0))
        assertEquals(0, SurfNav.wrap(7, 0))
    }

    @Test
    fun `wrap normalises far out of range indices in both directions`() {
        assertEquals(1, SurfNav.wrap(41, 40))
        assertEquals(38, SurfNav.wrap(-2, 40))
        assertEquals(0, SurfNav.wrap(80, 40))
    }

    @Test
    fun `label is one based and handles the empty pool`() {
        assertEquals("1 of 40", SurfNav.label(0, 40))
        assertEquals("40 of 40", SurfNav.label(39, 40))
        assertEquals("0 of 0", SurfNav.label(0, 0))
    }

    @Test
    fun `start position uses the api start fraction`() {
        // the contract says the server returns 0.5
        assertEquals(3_600_000L, SurfNav.startPositionMs(7_200_000L, 0.5))
        assertEquals(0L, SurfNav.startPositionMs(-1L, 0.5))       // duration unknown yet
        assertEquals(0L, SurfNav.startPositionMs(1000L, 0.0))
    }

    @Test
    fun `start fraction is clamped so we never seek past the end`() {
        assertEquals(990L, SurfNav.startPositionMs(1000L, 5.0))
        assertEquals(0L, SurfNav.startPositionMs(1000L, -3.0))
    }
}
