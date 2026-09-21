package com.beeboentertainment.movie

import com.beeboentertainment.movie.data.SessionStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A new install starts with an empty Home box: the app ships no one's home server address.
 * (An existing install keeps the address it saved; that lives in the phone's own storage.)
 */
class NoOwnerAddressTest {

    @Test
    fun `no default server address in SessionStore`() {
        val names = SessionStore::class.java.declaredFields.map { it.name } +
            SessionStore.Companion::class.java.declaredFields.map { it.name }
        assertTrue(names.none { it.contains("DEFAULT_BASE_URL") })
    }

    @Test
    fun `no personal home address or handle anywhere in the app's sources`() {
        val forbidden = listOf(
            Regex("""(?i)beeboentertainment\.duckdns\.org"""),
            Regex("""(?i)[a-z0-9-]+\.duckdns\.org"""),

            Regex("""(?i)workers\.dev"""),
        )
        val src = File("src")
        assertTrue("run from the app module", src.isDirectory)
        val found = mutableListOf<String>()
        src.listFiles()!!.filter { it.isDirectory && !it.name.startsWith("test") && !it.name.startsWith("androidTest") }
            .forEach { set ->
                set.walkTopDown().filter { it.isFile && it.extension in setOf("kt", "xml", "json", "html", "js") }.forEach { f ->
                    val text = f.readText()
                    forbidden.forEach { r -> r.find(text)?.let { found += "${f.path}: ${it.value}" } }
                }
            }
        assertEquals(emptyList<String>(), found)
    }
}
