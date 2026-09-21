package com.beeboentertainment.auto.data

import kotlinx.serialization.Serializable

/*
 * The /api/music contract (desktop/apps/desktop/electron/musicApi.js), the part the car needs:
 * artists, albums and songs. Every field defaults, so an older or newer computer never breaks
 * the browse tree.
 *
 * Song streams are asked for with ?tokens=1, so each `stream` carries its own short-lived media
 * token exactly like the film and episode streams this app already plays.
 */

@Serializable
data class MusicArtistItem(
    val id: String = "",
    val name: String = "",
    val albumCount: Int = 0,
    val trackCount: Int = 0,
    val cover: String? = null,
)

@Serializable
data class MusicAlbumItem(
    val id: String = "",
    val title: String = "",
    val artist: String = "",
    val artistId: String? = null,
    val year: Int? = null,
    val trackCount: Int = 0,
    val duration: Double? = null,
    val cover: String? = null,
)

@Serializable
data class MusicTrackItem(
    val id: String = "",
    val title: String = "",
    val artist: String = "",
    val album: String = "",
    val albumId: String? = null,
    val artistId: String? = null,
    val trackNo: Int? = null,
    val discNo: Int? = null,
    val duration: Double? = null,
    val cover: String? = null,
    val stream: String = "",
)

@Serializable
data class MusicStatusResponse(
    val ok: Boolean = false,
    val configured: Boolean = false,
    val scanning: Boolean = false,
    val trackCount: Int = 0,
    val albumCount: Int = 0,
    val artistCount: Int = 0,
)

@Serializable
data class MusicArtistsResponse(val ok: Boolean = false, val items: List<MusicArtistItem> = emptyList())

@Serializable
data class MusicAlbumsResponse(val ok: Boolean = false, val items: List<MusicAlbumItem> = emptyList())

@Serializable
data class MusicArtistResponse(
    val ok: Boolean = false,
    val artist: MusicArtistItem? = null,
    val albums: List<MusicAlbumItem> = emptyList(),
)

@Serializable
data class MusicTrackResponse(val ok: Boolean = false, val track: MusicTrackItem? = null)

@Serializable
data class MusicAlbumResponse(
    val ok: Boolean = false,
    val album: MusicAlbumItem? = null,
    val tracks: List<MusicTrackItem> = emptyList(),
)

@Serializable
data class MusicTracksResponse(
    val ok: Boolean = false,
    val total: Int = 0,
    val items: List<MusicTrackItem> = emptyList(),
)
