package com.beeboentertainment.movie.stories

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class StoryBookTest {
    private val json=Json { ignoreUnknownKeys=true }
    private val sample=StoryBook("Example",characters=listOf(StoryCharacter("{{CHILD_NAME}}","Child","Alex"),StoryCharacter("{{FRIEND_NAME}}","Friend","Sam")),
        pages=listOf(StoryPage(1,"Hi {{CHILD_NAME}}",choices=listOf(StoryChoice("Go",2))),StoryPage(2,"The end",true)))

    @Test fun `personalized names are inserted literally and blanks keep defaults`() {
        assertEquals("Hi Alice & Bob with Sam",sample.personalize("Hi {{CHILD_NAME}} with {{FRIEND_NAME}}",mapOf("{{CHILD_NAME}}" to " Alice & Bob ","{{FRIEND_NAME}}" to "  ")))
        assertEquals("{{FRIEND_NAME}}",sample.personalize("{{CHILD_NAME}}",mapOf("{{CHILD_NAME}}" to "{{FRIEND_NAME}}")))
    }
    @Test fun `branching stories can converge but every target must exist`() {
        assertTrue(sample.valid())
        assertTrue(sample.copy(pages=sample.pages+StoryPage(3,"Other route",choices=listOf(StoryChoice("Also go",2)))).valid())
        assertFalse(sample.copy(pages=listOf(sample.pages.first())).valid())
        assertFalse(sample.copy(startPage=99).valid())
    }
    @Test fun `all seventeen original stories ship with complete navigable pages`() {
        val dir=File("src/web/assets/beebobook")
        val index=json.decodeFromString<StoryIndex>(File(dir,"index.json").readText())
        assertEquals(17,index.books.size)
        index.books.forEach { item ->
            val book=json.decodeFromString<StoryBook>(File(dir,item.slug+".json").readText())
            assertTrue(item.slug,book.valid())
            val reached=mutableSetOf<Int>()
            fun visit(id:Int) { if(!reached.add(id))return;book.pages.first{it.id==id}.choices.forEach{visit(it.target)} }
            visit(book.startPage)
            assertTrue(item.slug+" needs a reachable ending",book.pages.any{it.isEnding&&it.id in reached})
            val names=book.characters.associate { it.token to "Reader" }
            book.pages.forEach { page ->
                assertFalse(item.slug+" unresolved name",Regex("\\{\\{[A-Z0-9_]+\\}\\}").containsMatchIn(book.personalize(page.text,names)))
            }
        }
    }
}
