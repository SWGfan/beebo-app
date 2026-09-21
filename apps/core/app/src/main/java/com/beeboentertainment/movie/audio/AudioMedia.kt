package com.beeboentertainment.movie.audio

import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.server.SafeText

/** Skip lengths for spoken audio, kept where the service and the screens can both read them. */
object AudioPrefs {
    private const val FILE = "beebo_audio"
    private const val K_BACK = "skip_back"
    private const val K_FORWARD = "skip_forward"

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun skipBackSeconds(context: Context): Int = clamp(prefs(context).getInt(K_BACK, SpokenSeek.DEFAULT_BACK_SEC))
    fun skipForwardSeconds(context: Context): Int = clamp(prefs(context).getInt(K_FORWARD, SpokenSeek.DEFAULT_FORWARD_SEC))

    fun set(context: Context, back: Int, forward: Int) {
        prefs(context).edit().putInt(K_BACK, clamp(back)).putInt(K_FORWARD, clamp(forward)).apply()
    }

    /** The server allows 5 to 120 seconds. */
    fun clamp(seconds: Int): Int = seconds.coerceIn(5, 120)
}

/**
 * Spoken-word and radio items as Media3 MediaItems: what the queue, the notification and the lock
 * screen show. The address is joined onto this server's own address and must be a server-relative
 * path of the right kind (nothing else is ever sent the bearer token); the bearer token itself is
 * added by the service just before the request, never put in the address.
 */
object AudioMedia {

    fun item(
        kind: AudioKind,
        mediaId: String,
        streamPath: String,
        baseUrl: String?,
        title: String,
        subtitle: String,
        artworkUrl: String?,
        extras: Bundle,
    ): MediaItem? {
        val safePath = SafeText.serverPathOrNull(streamPath, AudioStreamRules.pathPrefix(kind)) ?: return null
        val url = UrlUtils.join(baseUrl, safePath) ?: return null
        if (AudioStreamRules.kindOf(url, UrlUtils.normalizeBaseUrl(baseUrl)) != kind) return null
        extras.putString(AudioExtras.KIND, kind.id)
        val metadata = MediaMetadata.Builder()
            .setTitle(SafeText.clean(title, 200))
            .setArtist(SafeText.clean(subtitle, 200))
            .setAlbumTitle(SafeText.clean(subtitle, 200))
            .setArtworkUri(artworkUrl?.let { Uri.parse(it) })
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setMediaType(
                when (kind) {
                    AudioKind.AUDIOBOOK -> MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER
                    AudioKind.PODCAST -> MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE
                    AudioKind.RADIO -> MediaMetadata.MEDIA_TYPE_RADIO_STATION
                    AudioKind.MUSIC -> MediaMetadata.MEDIA_TYPE_MUSIC
                }
            )
            .setExtras(extras)
            .build()
        return MediaItem.Builder()
            .setMediaId(mediaId)
            .setUri(url)
            .setMediaMetadata(metadata)
            // Carried separately too: a controller hands items over without their URI.
            .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(Uri.parse(url)).build())
            .build()
    }

    fun kindOf(item: MediaItem?): AudioKind = AudioKind.fromId(item?.mediaMetadata?.extras?.getString(AudioExtras.KIND))
    fun itemId(item: MediaItem?): String? = item?.mediaMetadata?.extras?.getString(AudioExtras.ITEM_ID)

    /** Cover art: this server's own pictures only, joined on the server address. */
    fun serverArt(baseUrl: String?, path: String?, prefix: String): String? =
        SafeText.serverPathOrNull(path, prefix)?.let { UrlUtils.join(baseUrl, it) }
}
