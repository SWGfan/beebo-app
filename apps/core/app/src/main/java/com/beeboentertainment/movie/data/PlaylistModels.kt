package com.beeboentertainment.movie.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/*
 * /api/playlists/... - the server's playlistApi.js contract. Every field has a default so a newer
 * server that adds keys (or an older one missing some) never breaks parsing.
 */

@Serializable
data class PlaylistSummary(
    val id: String = "",
    val name: String = "",
    val kind: String = "manual",
    val smart: Boolean = false,
    val shared: Boolean = false,
    val template: String? = null,
    val mine: Boolean = false,
    val canEdit: Boolean = false,
    val ownerName: String? = null,
    val itemCount: Int? = null,
    val updatedAt: Long = 0,
    /** Smart playlists only: the rules exactly as the server stores them. */
    val rules: JsonObject? = null
)

@Serializable
data class PlaylistTemplate(val id: String = "", val name: String = "")

@Serializable
data class PlaylistsResponse(
    val ok: Boolean = false,
    val playlists: List<PlaylistSummary> = emptyList(),
    val templates: List<PlaylistTemplate> = emptyList(),
    val canShare: Boolean = false
)

/** One playable row. `stream` and `poster` are server-relative. */
@Serializable
data class PlaylistEntry(
    val entryId: String = "",
    val type: String = "movie",
    val id: String = "",
    /** "movie" | "tv" - what the player and /api/upnext call it. */
    val kind: String = "movie",
    val title: String = "",
    val showKey: String? = null,
    val showName: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val year: Int? = null,
    val durationSeconds: Double? = null,
    val quality: String? = null,
    val watched: Boolean = false,
    val percent: Int = 0,
    val resumeSeconds: Double = 0.0,
    val available: Boolean = true,
    val poster: String? = null,
    val stream: String? = null
)

@Serializable
data class PlaylistProgress(
    val entryId: String = "",
    val index: Int = 0,
    val shuffle: Boolean = false,
    val seed: Long = 0,
    val at: Long = 0
)

@Serializable
data class PlaylistDetailResponse(
    val ok: Boolean = false,
    val playlist: PlaylistSummary = PlaylistSummary(),
    val items: List<PlaylistEntry> = emptyList(),
    val count: Int = 0,
    val skipped: Int = 0,
    val added: Int? = null,
    val removed: Int? = null,
    val progress: PlaylistProgress? = null
)

@Serializable
data class PlaylistPlayResponse(
    val ok: Boolean = false,
    val playlist: PlaylistSummary = PlaylistSummary(),
    val items: List<PlaylistEntry> = emptyList(),
    val startIndex: Int = 0,
    val shuffle: Boolean = false,
    val seed: Long = 0,
    val skipped: Int = 0
)

@Serializable
data class PlaylistPreviewResponse(
    val ok: Boolean = false,
    val count: Int = 0,
    val items: List<PlaylistEntry> = emptyList()
)

@Serializable
data class PlaylistExpandResponse(
    val ok: Boolean = false,
    val items: List<PlaylistEntry> = emptyList()
)

/** One rule field as the server describes it (GET /api/playlists/fields). */
@Serializable
data class PlaylistField(
    val label: String = "",
    val ops: List<String> = emptyList(),
    val value: String = "text",
    val options: List<String> = emptyList()
)

@Serializable
data class PlaylistFieldsResponse(
    val ok: Boolean = false,
    val fields: Map<String, PlaylistField> = emptyMap(),
    val sorts: List<String> = emptyList()
)

/** What "add" means: a film, an episode, a whole show or one season. */
@Serializable
data class PlaylistItemRef(
    val type: String,
    val id: String? = null,
    val showKey: String? = null,
    val season: Int? = null,
    val title: String? = null
)

@Serializable
data class PlaylistCreateRequest(
    val name: String? = null,
    val smart: Boolean? = null,
    val template: String? = null,
    val shared: Boolean? = null,
    val rules: JsonElement? = null,
    val add: List<PlaylistItemRef>? = null
)

@Serializable
data class PlaylistUpdateRequest(
    val name: String? = null,
    val shared: Boolean? = null,
    val rules: JsonElement? = null
)

@Serializable
data class PlaylistAddItemsRequest(val items: List<PlaylistItemRef>, val position: Int? = null)

@Serializable
data class PlaylistRemoveItemsRequest(val entryIds: List<String>)

@Serializable
data class PlaylistMoveRequest(val entryId: String, val toIndex: Int)

@Serializable
data class PlaylistProgressRequest(val entryId: String, val index: Int, val shuffle: Boolean, val seed: Long)

@Serializable
data class PlaylistPreviewRequest(val rules: JsonElement)

@Serializable
data class PlaylistExpandRequest(val items: List<PlaylistItemRef>)
