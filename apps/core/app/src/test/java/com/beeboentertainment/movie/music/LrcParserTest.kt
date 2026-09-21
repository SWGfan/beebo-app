package com.beeboentertainment.movie.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LrcParserTest {

    @Test
    fun `timestamps in every common form`() {
        val l = LrcParser.parse(
            """
            [00:01]one
            [00:02.5]two
            [00:03.25]three
            [00:04.125]four
            [00:05:50]five
            [1:00:00.00]an hour in
            """.trimIndent()
        )
        assertTrue(l.synced)
        assertEquals(listOf(1_000L, 2_500L, 3_250L, 4_125L, 5_500L, 3_600_000L), l.lines.map { it.timeMs })
        assertEquals(listOf("one", "two", "three", "four", "five", "an hour in"), l.lines.map { it.text })
    }

    @Test
    fun `several stamps on one line, out of order, metadata ignored, BOM and CRLF`() {
        val l = LrcParser.parse("﻿[ar:Artist]\r\n[ti:Title]\r\n[00:30.00][00:10.00]Chorus\r\n[00:20.00]Verse\r\n")
        assertEquals(listOf(10_000L to "Chorus", 20_000L to "Verse", 30_000L to "Chorus"), l.lines.map { it.timeMs to it.text })
        assertEquals("Chorus\nVerse\nChorus", l.text)
    }

    @Test
    fun `offset shifts every line, never below zero`() {
        val l = LrcParser.parse("[offset:+1500]\n[00:01.00]early\n[00:10.00]later")
        assertEquals(1500L, l.offsetMs)
        assertEquals(listOf(0L, 8_500L), l.lines.map { it.timeMs })
        val back = LrcParser.parse("[offset:-500]\n[00:01.00]x")
        assertEquals(1_500L, back.lines[0].timeMs)
    }

    @Test
    fun `enhanced word stamps are removed and blank instrumental lines kept`() {
        val l = LrcParser.parse("[00:01.00]<00:01.00>Hello <00:01.50>there\n[00:03.00]\n[00:04.00]End")
        assertEquals(listOf("Hello there", "", "End"), l.lines.map { it.text })
    }

    @Test
    fun `plain lyrics are unsynced text`() {
        val l = LrcParser.parse("\nFirst line\n\nSecond verse\n")
        assertFalse(l.synced)
        assertTrue(l.lines.isEmpty())
        assertEquals("First line\n\nSecond verse", l.text)
        assertFalse(LrcParser.parse(null).synced)
        assertEquals("", LrcParser.parse("").text)
    }

    @Test
    fun `a bracket that is not a timestamp stays a lyric`() {
        val l = LrcParser.parse("[00:01.00]real\n[Chorus]")
        // "[Chorus]" has no colon, so it is neither a time nor a tag; with synced lines present it is dropped.
        assertEquals(listOf("real"), l.lines.map { it.text })
        val plain = LrcParser.parse("[Chorus]\nla la")
        assertEquals("[Chorus]\nla la", plain.text)
    }

    @Test
    fun `active line follows the position`() {
        val lines = LrcParser.parse("[00:01.00]a\n[00:02.00]b\n[00:02.00]b2\n[00:05.00]c").lines
        assertEquals(-1, LrcParser.activeIndex(lines, 0))
        assertEquals(-1, LrcParser.activeIndex(lines, 999))
        assertEquals(0, LrcParser.activeIndex(lines, 1_000))
        assertEquals(2, LrcParser.activeIndex(lines, 2_000))
        assertEquals(2, LrcParser.activeIndex(lines, 4_999))
        assertEquals(3, LrcParser.activeIndex(lines, 60_000))
        assertEquals(-1, LrcParser.activeIndex(emptyList(), 5))
    }
}
