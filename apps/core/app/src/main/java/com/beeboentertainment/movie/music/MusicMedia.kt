package com.beeboentertainment.movie.music

import android.content.Context
import android.media.MediaCodecList
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils

/** The Music player's settings: stream quality at home and away from home. */
object MusicPrefs {
    private const val FILE = "beebo_music"
    private const val K_AWAY = "away_quality"
    private const val K_HOME = "home_quality"
    private const val K_LEVEL = "volume_levelling"

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun awayQuality(context: Context): String =
        prefs(context).getString(K_AWAY, MusicStreamRules.DEFAULT_AWAY_QUALITY) ?: MusicStreamRules.DEFAULT_AWAY_QUALITY

    fun setAwayQuality(context: Context, q: String) = prefs(context).edit().putString(K_AWAY, q).apply()

    fun homeQuality(context: Context): String =
        prefs(context).getString(K_HOME, MusicStreamRules.DEFAULT_HOME_QUALITY) ?: MusicStreamRules.DEFAULT_HOME_QUALITY

    fun setHomeQuality(context: Context, q: String) = prefs(context).edit().putString(K_HOME, q).apply()

    /** Volume levelling from ReplayGain tags (MusicGain). On unless switched off. */
    fun levelling(context: Context): Boolean = prefs(context).getBoolean(K_LEVEL, true)

    fun setLevelling(context: Context, on: Boolean) = prefs(context).edit().putBoolean(K_LEVEL, on).apply()
}

/** Which audio formats this device decodes, asked once. */
object DeviceCodecs {
    @Volatile private var cached: List<String>? = null

    fun list(): List<String> = cached ?: runCatching {
        val mimes = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
            .filter { !it.isEncoder }
            .flatMap { it.supportedTypes.toList() }
        MusicStreamRules.codecsFor(mimes)
    }.getOrElse { MusicStreamRules.codecsFor(emptyList()) }.also { cached = it }
}

/** Songs as Media3 MediaItems: what the queue, the notification and the lock screen show. */
object MusicMedia {
    const val EXTRA_TRACK_ID = "beebo.music.trackId"
    const val EXTRA_ALBUM_ID = "beebo.music.albumId"
    const val EXTRA_ARTIST_ID = "beebo.music.artistId"
    const val EXTRA_HAS_LYRICS = "beebo.music.hasLyrics"

    fun item(track: MusicTrack, baseUrl: String? = BeeboApp.instance.session.baseUrl): MediaItem? {
        val url = UrlUtils.join(baseUrl, track.stream.ifBlank { "/api/music/track/${track.id}/stream" }) ?: return null
        val extras = Bundle().apply {
            putString(EXTRA_TRACK_ID, track.id)
            track.albumId?.let { putString(EXTRA_ALBUM_ID, it) }
            track.artistId?.let { putString(EXTRA_ARTIST_ID, it) }
            putBoolean(EXTRA_HAS_LYRICS, track.hasLyrics)
            track.gainDb?.let { putDouble(MusicGain.EXTRA_GAIN_DB, it) }
            track.albumGainDb?.let { putDouble(MusicGain.EXTRA_ALBUM_GAIN_DB, it) }
            track.gainPeak?.let { putDouble(MusicGain.EXTRA_GAIN_PEAK, it) }
            track.albumGainPeak?.let { putDouble(MusicGain.EXTRA_ALBUM_GAIN_PEAK, it) }
        }
        val art = UrlUtils.join(baseUrl, track.cover)?.let { Uri.parse(it) }
        val metadata = MediaMetadata.Builder()
            .setTitle(track.title)
            .setArtist(track.artist)
            .setAlbumTitle(track.album)
            .setAlbumArtist(track.albumArtist)
            .setArtworkUri(art)
            .setTrackNumber(track.trackNo)
            .setDiscNumber(track.discNo)
            .setRecordingYear(track.year)
            .setGenre(track.genre)
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .setExtras(extras)
            .build()
        return MediaItem.Builder()
            .setMediaId(track.id)
            .setUri(url)
            .setMediaMetadata(metadata)
            // Carried separately too: a controller hands items over without their URI.
            .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(Uri.parse(url)).build())
            .build()
    }

    fun trackId(item: MediaItem?): String? =
        item?.mediaMetadata?.extras?.getString(EXTRA_TRACK_ID) ?: item?.mediaId?.takeIf { it.isNotBlank() }
}
