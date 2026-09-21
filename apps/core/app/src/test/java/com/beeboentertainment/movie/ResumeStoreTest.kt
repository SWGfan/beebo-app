package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.MemoryKeyValueStore
import com.beeboentertainment.movie.core.ResumeStore
import com.beeboentertainment.movie.core.formatBytes
import com.beeboentertainment.movie.core.formatMs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Resume positions are keyed by item id. The logic lives behind a KeyValueStore interface
 * precisely so it can be exercised without SharedPreferences.
 */
class ResumeStoreTest {

    private fun store() = ResumeStore(MemoryKeyValueStore())

    @Test
    fun `position is remembered per item id`() {
        val s = store()
        s.save("movieA", 600_000L, 7_200_000L)
        s.save("movieB", 120_000L, 3_600_000L)
        assertEquals(600_000L, s.position("movieA"))
        assertEquals(120_000L, s.position("movieB"))
        assertEquals(0L, s.position("neverWatched"))
    }

    @Test
    fun `key is namespaced so it cannot collide with other prefs`() {
        assertEquals("resume_abc123", ResumeStore.keyFor("abc123"))
    }

    @Test
    fun `the first thirty seconds are not worth remembering`() {
        val s = store()
        s.save("m", 5_000L, 7_200_000L)
        assertEquals(0L, s.position("m"))
        assertFalse(s.hasResume("m"))
    }

    @Test
    fun `restarting near the beginning clears an older mark`() {
        val s = store()
        s.save("m", 900_000L, 7_200_000L)
        assertTrue(s.hasResume("m"))
        s.save("m", 2_000L, 7_200_000L)   // user started over
        assertFalse(s.hasResume("m"))
    }

    @Test
    fun `finishing an item clears the mark`() {
        val s = store()
        s.save("m", 7_150_000L, 7_200_000L)   // within 90s of the end
        assertFalse(s.hasResume("m"))
    }

    @Test
    fun `unknown duration still stores a position`() {
        val s = store()
        s.save("m", 600_000L, 0L)
        assertEquals(600_000L, s.position("m"))
    }

    @Test
    fun `clear and clearAll work`() {
        val s = store()
        s.save("a", 600_000L, 0L)
        s.save("b", 600_000L, 0L)
        s.clear("a")
        assertFalse(s.hasResume("a"))
        assertTrue(s.hasResume("b"))
        s.clearAll()
        assertFalse(s.hasResume("b"))
    }

    @Test
    fun `blank ids are ignored rather than crashing`() {
        val s = store()
        s.save("", 600_000L, 0L)
        assertEquals(0L, s.position(""))
    }

    @Test
    fun `resume prompt formatting`() {
        assertEquals("0:00", formatMs(0L))
        assertEquals("4:07", formatMs(247_000L))
        assertEquals("1:23:45", formatMs(5_025_000L))
    }

    @Test
    fun `download size formatting`() {
        assertEquals("0 B", formatBytes(0L))
        assertEquals("512 B", formatBytes(512L))
        assertEquals("1.0 KB", formatBytes(1024L))
        assertEquals("1.4 GB", formatBytes(1_503_238_553L))
    }
}
