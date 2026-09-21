package com.beeboentertainment.movie.campsite.games

/**
 * The optional settings a table game reads out of its setup string.
 *
 * WHY A SETUP STRING. The engine already hands every game the leader's setup text when
 * a round starts, and a tournament hands it an empty one. So the table games take
 * their options from there - "level=hard;size=5;clock=5" - and every option has a
 * default, which is what a tournament heat (or an old guest page that sends nothing)
 * gets. No new field on the wire, no change to the service.
 *
 * Nothing here can hurt anybody: unknown keys are ignored, values are clamped, and a
 * setup string is only ever accepted from the room leader in the first place.
 */
internal class TableOptions private constructor(private val values: Map<String, String>) {

    fun text(key: String, default: String): String = values[key] ?: default

    fun int(key: String, default: Int, range: IntRange): Int =
        (values[key]?.toIntOrNull() ?: default).coerceIn(range)

    /** How hard the computer players in this match try. */
    val level: BotLevel get() = BotLevel.of(values["level"])

    companion object {
        fun parse(setup: String): TableOptions {
            if (setup.length > 200) return TableOptions(emptyMap())
            val map = linkedMapOf<String, String>()
            setup.split(';', '&', ',').forEach { part ->
                val eq = part.indexOf('=')
                if (eq <= 0) return@forEach
                val key = part.substring(0, eq).trim().lowercase()
                val value = part.substring(eq + 1).trim().lowercase()
                if (key.length <= 12 && value.length <= 12 && key.all { it.isLetter() }) map[key] = value
            }
            return TableOptions(map)
        }
    }
}

/**
 * Computer player strength. Three names on the wire, used by every table game; a game
 * with only two sensible levels treats [MEDIUM] and [HARD] alike.
 */
internal enum class BotLevel(val wire: String, val label: String) {
    EASY("easy", "Easy"),
    MEDIUM("medium", "Medium"),
    HARD("hard", "Hard");

    companion object {
        fun of(text: String?): BotLevel = entries.firstOrNull { it.wire == text } ?: MEDIUM
    }
}
