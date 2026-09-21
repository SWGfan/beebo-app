package com.beeboentertainment.auto.media

import android.os.Bundle
import android.os.SystemClock
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaConstants
import com.beeboentertainment.auto.data.ApiClient
import com.beeboentertainment.auto.data.MusicAlbumItem
import com.beeboentertainment.auto.data.MusicArtistItem
import com.beeboentertainment.auto.data.MusicTrackItem
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap

/**
 * The Music mediaId namespace for the car. Same rule as [MediaIds]: server ids are opaque and
 * ride along verbatim after a prefix, and nothing here ever decodes one.
 */
object MusicIds {
    const val TAB = "tab/music"
    const val ARTISTS = "music/artists"
    const val ALBUMS = "music/albums"
    const val PLAYLISTS = "music/playlists"

    /** Playable: everything in the library, shuffled. */
    const val SHUFFLE_ALL = "music/play/shuffle"

    fun artist(id: String) = "music/artist/$id"
    fun album(id: String) = "music/album/$id"

    /** Playable: one song. Tapping it plays the album (or artist) it came from, from there on. */
    fun track(trackId: String) = "music/play/track/$trackId"

    /** Playable: a whole album, from the top. */
    fun albumPlay(albumId: String) = "music/play/album/$albumId"

    /** Playable: everything by one artist. */
    fun artistPlay(artistId: String) = "music/play/artist/$artistId"

    fun parseArtist(mediaId: String): String? =
        mediaId.takeIf { it.startsWith("music/artist/") }?.removePrefix("music/artist/")?.ifEmpty { null }

    fun parseAlbum(mediaId: String): String? =
        mediaId.takeIf { it.startsWith("music/album/") }?.removePrefix("music/album/")?.ifEmpty { null }

    /** (kind, id) for a playable music id: "track", "album", "artist" or "shuffle" (id is ""). */
    fun parsePlayable(mediaId: String): Pair<String, String>? {
        if (mediaId == SHUFFLE_ALL) return "shuffle" to ""
        if (!mediaId.startsWith("music/play/")) return null
        val rest = mediaId.removePrefix("music/play/")
        val slash = rest.indexOf('/')
        if (slash <= 0) return null
        val kind = rest.substring(0, slash)
        val id = rest.substring(slash + 1)
        if (id.isEmpty() || kind !in setOf("track", "album", "artist")) return null
        return kind to id
    }

    fun isMusic(mediaId: String): Boolean =
        mediaId == TAB || mediaId.startsWith("music/")
}

/**
 * The Music part of the car's browse tree, and what a tap on a song actually plays.
 *
 * Shape (deliberately shallow - three taps from the road at most, and every list capped):
 *
 *   Music -> Shuffle everything        (playable)
 *         -> Artists -> artist -> album -> song
 *         -> Albums  -> album  -> song
 *         -> Playlists                 (a note until playlists exist)
 *
 * Tapping a song plays it AND queues the rest of its album behind it, which is what a car
 * player has to do: nobody is going to pick the next song at 70mph. PlaybackService's
 * onSetMediaItems asks [queueFor] for that queue.
 *
 * Lists are cached for a few minutes, with one lock per list so a slow album lookup cannot hold
 * up the artists list; the same pattern as [Catalog], for the same reason.
 */
class MusicBrowse(private val api: ApiClient) {

    private val artistsLock = Mutex()
    private val albumsLock = Mutex()
    private val albumLocks = ConcurrentHashMap<String, Mutex>()

    @Volatile private var artists: List<MusicArtistItem> = emptyList()
    @Volatile private var artistsAt = 0L
    @Volatile private var albums: List<MusicAlbumItem> = emptyList()
    @Volatile private var albumsAt = 0L
    private val albumTracks = ConcurrentHashMap<String, List<MusicTrackItem>>()
    private val albumTracksAt = ConcurrentHashMap<String, Long>()
    private val trackById = ConcurrentHashMap<String, MusicTrackItem>()

    // ------------------------------------------------------------------ tree

    fun tab(): MediaItem = browsable(MusicIds.TAB, "Music", style = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)

    /** The browsable item for a music id this tree knows, or null. */
    suspend fun itemFor(mediaId: String): MediaItem? = when {
        mediaId == MusicIds.TAB -> tab()
        mediaId == MusicIds.ARTISTS -> browsable(mediaId, "Artists")
        mediaId == MusicIds.ALBUMS -> browsable(mediaId, "Albums")
        mediaId == MusicIds.PLAYLISTS -> browsable(mediaId, "Playlists")
        MusicIds.parseArtist(mediaId) != null -> {
            val id = MusicIds.parseArtist(mediaId)!!
            artists.firstOrNull { it.id == id }?.let { artistFolder(it) } ?: browsable(mediaId, "Artist")
        }
        MusicIds.parseAlbum(mediaId) != null -> {
            val id = MusicIds.parseAlbum(mediaId)!!
            albums.firstOrNull { it.id == id }?.let { albumFolder(it) } ?: browsable(mediaId, "Album")
        }
        else -> null
    }

    suspend fun children(parentId: String, notice: (String) -> MediaItem): List<MediaItem> = when {
        parentId == MusicIds.TAB -> {
            val status = api.musicStatus()
            when {
                !status.configured -> listOf(notice("No music yet - choose a Music folder on the Beebo computer"))
                status.trackCount == 0 && status.scanning -> listOf(notice("Beebo is still reading your music"))
                status.trackCount == 0 -> listOf(notice("No songs found in your Music folder"))
                else -> listOf(
                    playable(MusicIds.SHUFFLE_ALL, "Shuffle everything", "${status.trackCount} songs", null),
                    browsable(MusicIds.ARTISTS, "Artists", "${status.artistCount} artists"),
                    browsable(MusicIds.ALBUMS, "Albums", "${status.albumCount} albums"),
                    browsable(MusicIds.PLAYLISTS, "Playlists"),
                )
            }
        }

        parentId == MusicIds.ARTISTS -> loadArtists().take(MAX_FLAT).map { artistFolder(it) }

        parentId == MusicIds.ALBUMS -> loadAlbums().take(MAX_FLAT).map { albumFolder(it) }

        // Playlists live on the phone for now. When they arrive, this is the one place to list
        // them: their songs are /api/music track ids, which queueFor already plays.
        parentId == MusicIds.PLAYLISTS ->
            listOf(notice("Playlists you make in the Beebo app will show up here"))

        MusicIds.parseArtist(parentId) != null -> {
            val id = MusicIds.parseArtist(parentId)!!
            val r = api.musicArtist(id)
            r.albums.ifEmpty { emptyList() }.take(MAX_FLAT).let { list ->
                listOf(playable(MusicIds.artistPlay(id), "Play everything", r.artist?.name, r.artist?.cover)) +
                    list.map { albumFolder(it) }
            }
        }

        MusicIds.parseAlbum(parentId) != null -> {
            val id = MusicIds.parseAlbum(parentId)!!
            loadAlbumTracks(id).take(MAX_FLAT).map { songRow(it) }
        }

        else -> emptyList()
    }

    // -------------------------------------------------------------- playback

    /**
     * What a tap plays: the song and everything after it in its album, a whole album or artist
     * from the top, or the whole library shuffled. Returns the queue and where in it to start.
     */
    suspend fun queueFor(mediaId: String): Pair<List<MediaItem>, Int>? {
        val (kind, id) = MusicIds.parsePlayable(mediaId) ?: return null
        return when (kind) {
            "track" -> {
                val track = trackById[id] ?: api.musicTrack(id)?.also { trackById[id] = it } ?: return null
                val album = track.albumId?.let { runCatching { loadAlbumTracks(it) }.getOrNull() }.orEmpty()
                val list = album.ifEmpty { listOf(track) }
                val start = list.indexOfFirst { it.id == id }.coerceAtLeast(0)
                list.mapNotNull { playableItem(it) } to start
            }
            "album" -> loadAlbumTracks(id).mapNotNull { playableItem(it) } to 0
            "artist" -> api.musicTracks(artistId = id).items.also { remember(it) }.mapNotNull { playableItem(it) } to 0
            "shuffle" -> api.musicTracks().items.also { remember(it) }.shuffled().take(MAX_QUEUE).mapNotNull { playableItem(it) } to 0
            else -> null
        }
    }

    /** One playable item for the car, for ids it hands back without a URI. */
    suspend fun resolvePlayable(mediaId: String): MediaItem? {
        val (list, start) = queueFor(mediaId) ?: return null
        return list.getOrNull(start)
    }

    private fun playableItem(t: MusicTrackItem): MediaItem? {
        val url = api.absolute(t.stream) ?: return null
        return MediaItem.Builder()
            .setMediaId(MusicIds.track(t.id))
            .setUri(url)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(t.title)
                    .setArtist(t.artist)
                    .setAlbumTitle(t.album)
                    .setTrackNumber(t.trackNo)
                    .setArtworkUri(ArtworkUris.forServerPath(t.cover))
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                    .build()
            )
            .build()
    }

    // --------------------------------------------------------------- loaders

    private suspend fun loadArtists(): List<MusicArtistItem> {
        if (artists.isNotEmpty() && fresh(artistsAt)) return artists
        artistsLock.withLock {
            if (artists.isNotEmpty() && fresh(artistsAt)) return artists
            artists = api.musicArtists().items
            artistsAt = SystemClock.elapsedRealtime()
            return artists
        }
    }

    private suspend fun loadAlbums(): List<MusicAlbumItem> {
        if (albums.isNotEmpty() && fresh(albumsAt)) return albums
        albumsLock.withLock {
            if (albums.isNotEmpty() && fresh(albumsAt)) return albums
            albums = api.musicAlbums().items
            albumsAt = SystemClock.elapsedRealtime()
            return albums
        }
    }

    /**
     * An album's songs. Refetched once the media tokens in their stream URLs are old enough to
     * be worth replacing (they last 12 hours), the same rule the film side uses.
     */
    private suspend fun loadAlbumTracks(albumId: String): List<MusicTrackItem> {
        val cached = albumTracks[albumId]
        if (cached != null && fresh(albumTracksAt[albumId] ?: 0L, STREAM_TTL_MS)) return cached
        albumLocks.computeIfAbsent(albumId) { Mutex() }.withLock {
            val now = albumTracks[albumId]
            if (now != null && fresh(albumTracksAt[albumId] ?: 0L, STREAM_TTL_MS)) return now
            val tracks = api.musicAlbum(albumId).tracks
            remember(tracks)
            albumTracks[albumId] = tracks
            albumTracksAt[albumId] = SystemClock.elapsedRealtime()
            return tracks
        }
    }

    private fun remember(tracks: List<MusicTrackItem>) {
        tracks.forEach { trackById[it.id] = it }
    }

    private fun fresh(at: Long, ttl: Long = LIST_TTL_MS): Boolean =
        at != 0L && SystemClock.elapsedRealtime() - at < ttl

    // --------------------------------------------------------------- rows

    private fun artistFolder(a: MusicArtistItem): MediaItem = browsable(
        MusicIds.artist(a.id), a.name,
        subtitle = if (a.albumCount == 1) "1 album" else "${a.albumCount} albums",
        posterPath = a.cover,
        style = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
    )

    private fun albumFolder(a: MusicAlbumItem): MediaItem = browsable(
        MusicIds.album(a.id), a.title,
        subtitle = listOfNotNull(a.artist.ifBlank { null }, a.year?.toString()).joinToString(" · ").ifBlank { null },
        posterPath = a.cover,
        style = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM,
    )

    private fun songRow(t: MusicTrackItem): MediaItem =
        playable(MusicIds.track(t.id), t.title, t.artist.ifBlank { null }, t.cover)

    private fun browsable(
        id: String,
        title: String,
        subtitle: String? = null,
        posterPath: String? = null,
        style: Int? = null,
    ): MediaItem {
        val extras = Bundle().apply {
            style?.let { putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, it) }
            putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
        }
        return MediaItem.Builder()
            .setMediaId(id)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setArtworkUri(ArtworkUris.forServerPath(posterPath))
                    .setIsBrowsable(true)
                    .setIsPlayable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS)
                    .setExtras(extras)
                    .build()
            )
            .build()
    }

    private fun playable(mediaId: String, title: String, subtitle: String?, posterPath: String?): MediaItem =
        MediaItem.Builder()
            .setMediaId(mediaId)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setArtist(subtitle)
                    .setArtworkUri(ArtworkUris.forServerPath(posterPath))
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                    .build()
            )
            .build()

    private companion object {
        const val LIST_TTL_MS = 10 * 60 * 1000L
        const val STREAM_TTL_MS = 60 * 60 * 1000L // the media token in a stream URL lasts 12h
        const val MAX_FLAT = 200
        const val MAX_QUEUE = 300
    }
}
