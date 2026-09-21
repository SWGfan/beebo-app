package com.beeboentertainment.movie.music

import kotlinx.serialization.Serializable

/*
 * The /api/music contract (desktop/apps/desktop/electron/musicApi.js). Every field has a default
 * so an older or newer server never breaks decoding. Ids are stable hex strings: a song's id is
 * what a playlist stores.
 */

@Serializable
data class MusicStatus(
    val ok: Boolean = false,
    val configured: Boolean = false,
    val scanning: Boolean = false,
    val trackCount: Int = 0,
    val albumCount: Int = 0,
    val artistCount: Int = 0
)

@Serializable
data class MusicArtist(
    val id: String = "",
    val name: String = "",
    val albumCount: Int = 0,
    val trackCount: Int = 0,
    val cover: String? = null
)

@Serializable
data class MusicAlbum(
    val id: String = "",
    val title: String = "",
    val artist: String = "",
    val artistId: String? = null,
    val year: Int? = null,
    val genre: String? = null,
    val trackCount: Int = 0,
    val discCount: Int = 1,
    val duration: Double? = null,
    val cover: String? = null,
    val addedAt: Long? = null
)

@Serializable
data class MusicTrack(
    val id: String = "",
    val title: String = "",
    val artist: String = "",
    val album: String = "",
    val albumArtist: String? = null,
    val albumId: String? = null,
    val artistId: String? = null,
    val trackNo: Int? = null,
    val discNo: Int? = null,
    val year: Int? = null,
    val genre: String? = null,
    val duration: Double? = null,
    val codec: String? = null,
    val lossless: Boolean = false,
    val bitrate: Long? = null,
    val sampleRate: Int? = null,
    val bitsPerSample: Int? = null,
    /** ReplayGain from the file's own tags (dB and linear peak); null when it has none. */
    val gainDb: Double? = null,
    val albumGainDb: Double? = null,
    val gainPeak: Double? = null,
    val albumGainPeak: Double? = null,
    val cover: String? = null,
    val hasLyrics: Boolean = false,
    val stream: String = ""
)

@Serializable
data class MusicArtistsResponse(val ok: Boolean = false, val items: List<MusicArtist> = emptyList())

@Serializable
data class MusicArtistResponse(val ok: Boolean = false, val artist: MusicArtist? = null, val albums: List<MusicAlbum> = emptyList())

@Serializable
data class MusicAlbumsResponse(val ok: Boolean = false, val items: List<MusicAlbum> = emptyList())

@Serializable
data class MusicAlbumResponse(val ok: Boolean = false, val album: MusicAlbum? = null, val tracks: List<MusicTrack> = emptyList())

@Serializable
data class MusicTracksResponse(val ok: Boolean = false, val total: Int = 0, val offset: Int = 0, val items: List<MusicTrack> = emptyList())

@Serializable
data class MusicSearchResponse(
    val ok: Boolean = false,
    val artists: List<MusicArtist> = emptyList(),
    val albums: List<MusicAlbum> = emptyList(),
    val tracks: List<MusicTrack> = emptyList()
)

@Serializable
data class MusicLyrics(
    val source: String? = null,
    val synced: Boolean = false,
    val text: String = "",
    /** The raw LRC when synced; parsed on the phone by LrcParser. */
    val lrc: String? = null
)

@Serializable
data class MusicLyricsResponse(val ok: Boolean = false, val lyrics: MusicLyrics? = null)
