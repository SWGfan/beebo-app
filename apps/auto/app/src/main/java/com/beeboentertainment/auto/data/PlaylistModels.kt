package com.beeboentertainment.auto.data

import kotlinx.serialization.Serializable

/*
 * /api/playlists wire models - only what the car's browse tree needs: the list, and a
 * playlist's play order (fresh stream tokens every time it is asked for).
 */

@Serializable
data class PlaylistRow(
    val id: String = "",
    val name: String = "",
    val smart: Boolean = false,
    val shared: Boolean = false,
    val itemCount: Int? = null,
)

@Serializable
data class PlaylistsListResponse(
    val ok: Boolean = false,
    val playlists: List<PlaylistRow> = emptyList(),
)

@Serializable
data class PlaylistPlayEntry(
    val entryId: String = "",
    val id: String = "",
    /** "movie" | "tv" */
    val kind: String = "movie",
    val title: String = "",
    val year: Int? = null,
    val quality: String? = null,
    val available: Boolean = true,
    val poster: String? = null,
    val stream: String? = null,
)

@Serializable
data class PlaylistPlayOrderResponse(
    val ok: Boolean = false,
    val items: List<PlaylistPlayEntry> = emptyList(),
    val startIndex: Int = 0,
    val shuffle: Boolean = false,
    val seed: Long = 0,
)

@Serializable
data class PlaylistProgressBody(val entryId: String, val index: Int, val shuffle: Boolean, val seed: Long)
