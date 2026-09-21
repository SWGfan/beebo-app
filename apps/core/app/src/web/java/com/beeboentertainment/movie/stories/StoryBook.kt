package com.beeboentertainment.movie.stories

import kotlinx.serialization.Serializable

@Serializable internal data class StoryBook(
    val title: String, val ageRange: String = "", val startPage: Int = 1,
    val characters: List<StoryCharacter> = emptyList(), val pages: List<StoryPage>,
    /**
     * True only for books that have a full-page illustration drawn for every page.
     *
     * The pictures live on the home computer, not in this APK, so this flag is what stops the
     * books without art from asking for images that do not exist. Default false: a book says so
     * for itself, and an older book file that predates artwork keeps working untouched.
     */
    val hasScenes: Boolean = false,
) {
    fun names(provided: Map<String, String>): Map<String, String> = characters.associate {
        it.token to (provided[it.token]?.trim()?.take(60)?.takeIf { name -> name.isNotEmpty() } ?: it.default)
    }
    fun personalize(text: String, provided: Map<String, String>): String {
        val values = names(provided)
        // One pass: a name containing a token is literal text, never a second substitution.
        return Regex("\\{\\{[A-Z0-9_]+\\}\\}").replace(text) { values[it.value] ?: it.value }
    }
    fun valid(): Boolean = pages.isNotEmpty() && pages.map { it.id }.distinct().size == pages.size &&
        pages.any { it.id == startPage } && pages.all { page ->
            page.choices.all { choice -> pages.any { it.id == choice.target } }
        }
}
@Serializable internal data class StoryCharacter(val token: String, val role: String, val default: String = "")
@Serializable internal data class StoryPage(val id: Int, val text: String, val isEnding: Boolean = false,
    val endingTitle: String = "", val choices: List<StoryChoice> = emptyList(),
    /**
     * A one-sentence description of this page's picture, for a screen reader. It carries the same
     * {{NAME}} tokens as the story text, so it is personalized through [StoryBook.personalize]
     * and a child hears the picture described using their own characters' names.
     */
    val alt: String = "")
@Serializable internal data class StoryChoice(val text: String, val target: Int)
@Serializable internal data class StoryIndex(val books: List<StoryInfo>)
@Serializable internal data class StoryInfo(val slug: String, val title: String, val blurb: String = "", val ageRange: String = "",
    /**
     * True for a book that lives on the home computer rather than inside this APK - one written
     * by the co-writer. Default false, so the bundled shelf decodes exactly as it always has.
     */
    val custom: Boolean = false)
