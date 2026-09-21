package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.DemoLibrary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class DemoLibraryTest {

    @Test
    fun `has films and shows with unique ids and names`() {
        val t = DemoLibrary.titles
        assertTrue(t.size >= 8)
        assertEquals(t.size, t.map { it.id }.toSet().size)
        assertEquals(t.size, t.map { it.name.lowercase() }.toSet().size)
        assertTrue(t.any { it.kind == DemoLibrary.Kind.FILM })
        assertTrue(t.any { it.kind == DemoLibrary.Kind.SHOW })
    }

    @Test
    fun `every title is complete and its poster colours are opaque`() {
        DemoLibrary.titles.forEach {
            assertTrue(it.name, it.name.isNotBlank() && it.synopsis.length > 20 && it.genre.isNotBlank())
            assertTrue(it.name, it.length > 0 && it.year in 1900..2100)
            assertEquals(it.name, 0xFFL, it.colorTop ushr 24)
            assertEquals(it.name, 0xFFL, it.colorBottom ushr 24)
        }
    }

    @Test
    fun `filter keeps films first for All and splits by kind`() {
        val all = DemoLibrary.filter(null)
        assertEquals(DemoLibrary.titles.size, all.size)
        val firstShow = all.indexOfFirst { it.kind == DemoLibrary.Kind.SHOW }
        assertTrue(all.drop(firstShow).all { it.kind == DemoLibrary.Kind.SHOW })
        assertTrue(DemoLibrary.filter(DemoLibrary.Kind.FILM).all { it.kind == DemoLibrary.Kind.FILM })
        assertTrue(DemoLibrary.filter(DemoLibrary.Kind.SHOW).all { it.kind == DemoLibrary.Kind.SHOW })
    }

    @Test
    fun `detail line reads naturally`() {
        val film = DemoLibrary.titles.first { it.id == "f1" }
        assertEquals("2019 · Drama · 1 h 52 min", DemoLibrary.detailLine(film))
        val show = DemoLibrary.titles.first { it.id == "s3" }
        assertEquals("2023 · Mystery · 1 season", DemoLibrary.detailLine(show))
        assertEquals("2021 · Drama · 2 seasons", DemoLibrary.detailLine(DemoLibrary.titles.first { it.id == "s1" }))
    }

    @Test
    fun `it is clearly labelled as a sample and never says it plays`() {
        assertEquals("Sample", DemoLibrary.LABEL)
        assertTrue(DemoLibrary.EXPLANATION.contains("made-up"))
        assertTrue(DemoLibrary.CANT_PLAY.contains("don't play"))
    }

    @Test
    fun `demo mode shows the sample library on Home and Browse`() {
        val main = File("src/main/java/com/beeboentertainment/movie/ui/MainActivity.kt").readText()
        assertTrue(main.contains("DemoLibraryScreen("))
        val setup = File("src/main/java/com/beeboentertainment/movie/ui/screens/SetupScreen.kt").readText()
        assertFalse("no bundled sample video exists, so don't promise one", setup.contains("sample video"))
    }
}
