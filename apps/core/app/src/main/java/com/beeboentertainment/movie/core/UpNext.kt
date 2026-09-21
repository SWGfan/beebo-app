package com.beeboentertainment.movie.core

/**
 * "Play the next one automatically."
 *
 * What counts as "next" is decided by ONE place — the server's GET /api/upnext — so the website,
 * the desktop app and the phone can never disagree about it. This file therefore holds only the
 * presentation rules; there is deliberately no client-side derivation from the episode list any
 * more. It covers both kinds: TV rolls to the next episode (across season boundaries), movies to
 * the next part of their collection.
 */
object UpNextResolver {

    /** How long the "Up next" card counts down before playing by itself. */
    const val COUNTDOWN_SECONDS = 10

    /** "Up next: The Wire — S1E3" */
    fun upNextLabel(title: String?): String = "Up next: ${title.orEmpty()}"

    /** "Playing in 7s…" */
    fun countdownLabel(secondsRemaining: Int): String = "Playing in ${secondsRemaining}s…"

    /**
     * Shown when TMDB knows about a next episode / collection part that the library hasn't got.
     * The server hands us a ready-made title, so this only has to wrap it.
     */
    fun missingMessage(title: String?): String {
        val name = title?.trim().orEmpty()
        return if (name.isEmpty()) "The next one isn't in your library yet. Reported to the admin."
        else "$name isn't in your library yet. Reported to the admin."
    }
}
