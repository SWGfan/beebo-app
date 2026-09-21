package com.beeboentertainment.auto.media

import com.beeboentertainment.auto.data.PlaylistPlayEntry
import com.beeboentertainment.auto.data.PlaylistPlayOrderResponse

/**
 * How a playlist starts in the car, and what it plays. Pure, so the unit tests cover it.
 *
 * A playlist folder shows "Play all", "Shuffle", "Resume" (when there is somewhere to resume)
 * and then its items. Every one of those rows is playable and expands, in onAddMediaItems, into
 * the rest of the playlist, so the car's player carries on from one item to the next by itself.
 */
data class PlaylistStart(val playlistId: String, val mode: Mode, val fromIndex: Int = 0) {
    enum class Mode(val token: String) { ORDER("order"), SHUFFLE("shuffle"), RESUME("resume"), FROM("from") }

    val shuffle: Boolean get() = mode == Mode.SHUFFLE
    val resume: Boolean get() = mode == Mode.RESUME

    /**
     * The entries to hand the player, in play order. FROM starts at the tapped row of the
     * playlist's own order; RESUME at the server's saved place; the others at the top. Entries
     * no longer in the library are skipped.
     */
    fun order(response: PlaylistPlayOrderResponse): List<PlaylistPlayEntry> {
        val start = when (mode) {
            Mode.FROM -> fromIndex
            Mode.RESUME -> response.startIndex
            else -> 0
        }
        val all = response.items
        // A row tapped from a list that has since shrunk plays nothing rather than the wrong title.
        if (mode == Mode.FROM && start !in all.indices) return emptyList()
        return all.drop(start.coerceIn(0, all.size)).filter { it.available && !it.stream.isNullOrBlank() }
    }

    fun mediaId(): String = when (mode) {
        Mode.FROM -> "plstart/$playlistId/from/$fromIndex"
        else -> "plstart/$playlistId/${mode.token}"
    }

    companion object {
        /** Parses a `plstart/...` id; null for anything else. Playlist ids never contain '/'. */
        fun parse(mediaId: String): PlaylistStart? {
            if (!mediaId.startsWith("plstart/")) return null
            val parts = mediaId.removePrefix("plstart/").split('/')
            val id = parts.getOrNull(0)?.takeIf { it.isNotBlank() } ?: return null
            return when (parts.getOrNull(1)) {
                "order" -> PlaylistStart(id, Mode.ORDER).takeIf { parts.size == 2 }
                "shuffle" -> PlaylistStart(id, Mode.SHUFFLE).takeIf { parts.size == 2 }
                "resume" -> PlaylistStart(id, Mode.RESUME).takeIf { parts.size == 2 }
                "from" -> parts.getOrNull(2)?.toIntOrNull()?.takeIf { it >= 0 && parts.size == 3 }
                    ?.let { PlaylistStart(id, Mode.FROM, it) }
                else -> null
            }
        }
    }
}
