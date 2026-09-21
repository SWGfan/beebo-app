package com.beeboentertainment.movie.music

import com.beeboentertainment.movie.music.MusicQueueLogic.PreviousAction
import com.beeboentertainment.movie.music.MusicQueueLogic.Repeat
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class MusicQueueLogicTest {

    @Test
    fun `repeat cycles off, all, one and maps to Media3`() {
        assertEquals(Repeat.ALL, MusicQueueLogic.nextRepeat(Repeat.OFF))
        assertEquals(Repeat.ONE, MusicQueueLogic.nextRepeat(Repeat.ALL))
        assertEquals(Repeat.OFF, MusicQueueLogic.nextRepeat(Repeat.ONE))
        for (r in Repeat.entries) assertEquals(r, MusicQueueLogic.fromMedia3(MusicQueueLogic.toMedia3(r)))
        // androidx.media3.common.Player.REPEAT_MODE_OFF / ONE / ALL
        assertEquals(0, MusicQueueLogic.toMedia3(Repeat.OFF))
        assertEquals(1, MusicQueueLogic.toMedia3(Repeat.ONE))
        assertEquals(2, MusicQueueLogic.toMedia3(Repeat.ALL))
        assertEquals(Repeat.OFF, MusicQueueLogic.fromMedia3(99))
    }

    @Test
    fun `shuffle plays the chosen song first and every song exactly once`() {
        repeat(50) { seed ->
            val order = MusicQueueLogic.shuffledOrder(12, first = 7, random = Random(seed))
            assertEquals(7, order[0])
            assertEquals((0 until 12).toList(), order.sorted())
        }
        // Different seeds really do give different orders.
        val orders = (0 until 20).map { MusicQueueLogic.shuffledOrder(10, 0, Random(it)).toList() }.toSet()
        assertTrue(orders.size > 10)
        // Same seed, same order (Media3's shuffle order is rebuilt from it).
        assertArrayEquals(MusicQueueLogic.shuffledOrder(10, 3, Random(42)), MusicQueueLogic.shuffledOrder(10, 3, Random(42)))
    }

    @Test
    fun `shuffle edge cases`() {
        assertArrayEquals(IntArray(0), MusicQueueLogic.shuffledOrder(0, 0))
        assertArrayEquals(intArrayOf(0), MusicQueueLogic.shuffledOrder(1, 0))
        val noFirst = MusicQueueLogic.shuffledOrder(5, first = -1, random = Random(1))
        assertEquals((0 until 5).toList(), noFirst.sorted())
    }

    @Test
    fun `up next follows the play order and wraps only with repeat all`() {
        val order = intArrayOf(2, 0, 3, 1)
        assertEquals(listOf(3, 1), MusicQueueLogic.upNext(order, current = 0, repeat = Repeat.OFF))
        assertEquals(listOf(3, 1), MusicQueueLogic.upNext(order, current = 0, repeat = Repeat.ONE))
        assertEquals(listOf(3, 1, 2), MusicQueueLogic.upNext(order, current = 0, repeat = Repeat.ALL))
        assertEquals(listOf(3), MusicQueueLogic.upNext(order, current = 0, repeat = Repeat.ALL, limit = 1))
        assertEquals(emptyList<Int>(), MusicQueueLogic.upNext(order, current = 1, repeat = Repeat.OFF))
        assertEquals(listOf(2, 0, 3), MusicQueueLogic.upNext(order, current = 1, repeat = Repeat.ALL))
        assertEquals(emptyList<Int>(), MusicQueueLogic.upNext(order, current = 9, repeat = Repeat.ALL))
    }

    @Test
    fun `next and previous with each repeat mode`() {
        val order = MusicQueueLogic.straightOrder(3)
        // End of the queue.
        assertNull(MusicQueueLogic.nextIndex(order, 2, Repeat.OFF, auto = true))
        assertEquals(0, MusicQueueLogic.nextIndex(order, 2, Repeat.ALL, auto = true))
        // Repeat one: the song ending plays again, but Next moves on.
        assertEquals(1, MusicQueueLogic.nextIndex(order, 1, Repeat.ONE, auto = true))
        assertEquals(2, MusicQueueLogic.nextIndex(order, 1, Repeat.ONE, auto = false))
        assertNull(MusicQueueLogic.nextIndex(order, 2, Repeat.ONE, auto = false))
        // Previous.
        assertNull(MusicQueueLogic.previousIndex(order, 0, Repeat.OFF))
        assertEquals(2, MusicQueueLogic.previousIndex(order, 0, Repeat.ALL))
        assertEquals(0, MusicQueueLogic.previousIndex(order, 1, Repeat.OFF))
        // In shuffled order.
        val shuffled = intArrayOf(1, 2, 0)
        assertEquals(2, MusicQueueLogic.nextIndex(shuffled, 1, Repeat.OFF, auto = true))
        assertEquals(1, MusicQueueLogic.previousIndex(shuffled, 2, Repeat.OFF))
    }

    @Test
    fun `previous restarts a song a few seconds in`() {
        assertEquals(PreviousAction.PREVIOUS, MusicQueueLogic.previousAction(1_000, hasPrevious = true))
        assertEquals(PreviousAction.PREVIOUS, MusicQueueLogic.previousAction(3_000, hasPrevious = true))
        assertEquals(PreviousAction.RESTART, MusicQueueLogic.previousAction(3_001, hasPrevious = true))
        assertEquals(PreviousAction.RESTART, MusicQueueLogic.previousAction(500, hasPrevious = false))
    }

    @Test
    fun `play next stacks behind earlier play next songs, add to queue goes last`() {
        assertEquals(3, MusicQueueLogic.playNextIndex(current = 2, size = 10, playNextCount = 0))
        assertEquals(5, MusicQueueLogic.playNextIndex(current = 2, size = 10, playNextCount = 2))
        assertEquals(10, MusicQueueLogic.playNextIndex(current = 9, size = 10, playNextCount = 4))
        assertEquals(0, MusicQueueLogic.playNextIndex(current = -1, size = 0, playNextCount = 0))
        assertEquals(10, MusicQueueLogic.addToQueueIndex(10))
    }

    @Test
    fun `durations`() {
        assertEquals("3:05", MusicQueueLogic.formatDuration(185.4))
        assertEquals("0:00", MusicQueueLogic.formatDuration(0.0))
        assertEquals("1:02:03", MusicQueueLogic.formatDuration(3723.0))
        assertEquals("", MusicQueueLogic.formatDuration(null))
        assertEquals("42 min", MusicQueueLogic.formatLength(42 * 60.0))
        assertEquals("1 hr 5 min", MusicQueueLogic.formatLength(65 * 60.0))
        assertEquals("", MusicQueueLogic.formatLength(0.0))
    }

    @Test
    fun `stream options - codecs, quality and which urls get them`() {
        assertEquals(listOf("mp3", "aac", "pcm"), MusicStreamRules.codecsFor(emptyList()))
        assertEquals(
            listOf("mp3", "aac", "flac", "opus", "vorbis", "pcm"),
            MusicStreamRules.codecsFor(listOf("audio/opus", "audio/FLAC", "audio/vorbis", "video/avc", "audio/mp4a-latm"))
        )
        assertEquals("original", MusicStreamRules.qualityFor(away = false, homeQuality = "original", awayQuality = "low"))
        assertEquals("low", MusicStreamRules.qualityFor(away = true, homeQuality = "original", awayQuality = "low"))
        assertEquals("original", MusicStreamRules.qualityFor(away = true, homeQuality = "original", awayQuality = "nonsense"))

        val base = "https://nick.beebo.tv"
        val id = "0123456789abcdef0123"
        assertTrue(MusicStreamRules.isMusicStream("$base/api/music/track/$id/stream", base))
        assertTrue(MusicStreamRules.isMusicStream("$base/api/music/track/$id/stream?codecs=mp3", "$base/"))
        assertFalse(MusicStreamRules.isMusicStream("https://evil.example/api/music/track/$id/stream", base))
        assertFalse(MusicStreamRules.isMusicStream("$base/tvfile?id=x", base))
        assertFalse(MusicStreamRules.isMusicStream("$base/api/music/track/$id/lyrics", base))
        assertFalse(MusicStreamRules.isMusicStream("$base/api/music/track/$id/stream", null))

        val url = "$base/api/music/track/$id/stream"
        assertEquals("$url?codecs=mp3%2Caac", MusicStreamRules.withOptions(url, listOf("mp3", "aac"), "original"))
        val once = MusicStreamRules.withOptions(url, listOf("mp3", "aac"), "low")
        assertEquals("$url?codecs=mp3%2Caac&quality=low", once)
        assertEquals(once, MusicStreamRules.withOptions(once, listOf("mp3", "aac"), "low"), "resolving twice changes nothing")
        assertEquals("$url?format=opus&quality=medium", MusicStreamRules.withOptions("$url?format=opus&quality=low", emptyList(), "medium"))
    }

    private fun assertEquals(expected: Any?, actual: Any?, message: String) = org.junit.Assert.assertEquals(message, expected, actual)
}
