package com.beeboentertainment.movie.player

import androidx.media3.cast.DefaultMediaItemConverter
import androidx.media3.cast.MediaItemConverter
import androidx.media3.common.MediaItem
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaQueueItem
import com.google.android.gms.common.images.WebImage

/**
 * What the TV (and the phone's "casting to Main TV" card) shows about the video.
 *
 * Owner, 2026-09-17: while casting, the phone's cast card said "Default Media Receiver" with no
 * poster. Media3's DefaultMediaItemConverter sends a generic metadata block; this one sends a
 * proper MOVIE / TV_SHOW block with the title, the "TV episode" / "Movie" line and the poster as
 * a WebImage (twice: thumbnail and backdrop, which is what receivers and Android's cast card
 * pick from). Everything else - the stream, content type and the customData Media3 uses to turn
 * the queue item back into a MediaItem - is the default converter's, untouched.
 */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class CastMetadataConverter(
    private val base: MediaItemConverter = DefaultMediaItemConverter()
) : MediaItemConverter {

    override fun toMediaQueueItem(mediaItem: MediaItem): MediaQueueItem {
        val queueItem = base.toMediaQueueItem(mediaItem)
        val info = queueItem.media ?: return queueItem
        val meta = mediaItem.mediaMetadata
        val isEpisode = meta.subtitle?.toString()?.contains("episode", ignoreCase = true) == true
        val cast = MediaMetadata(if (isEpisode) MediaMetadata.MEDIA_TYPE_TV_SHOW else MediaMetadata.MEDIA_TYPE_MOVIE)
        val title = (meta.title ?: meta.displayTitle)?.toString()?.takeIf { it.isNotBlank() } ?: "Beebo Entertainment"
        cast.putString(MediaMetadata.KEY_TITLE, title)
        if (isEpisode) cast.putString(MediaMetadata.KEY_SERIES_TITLE, title)
        meta.subtitle?.toString()?.takeIf { it.isNotBlank() }?.let { cast.putString(MediaMetadata.KEY_SUBTITLE, it) }
        meta.artworkUri?.takeIf { CastArtwork.usable(it.toString()) }?.let { art ->
            cast.addImage(WebImage(art))
            cast.addImage(WebImage(art))
        }
        val media = MediaInfo.Builder(info.contentId ?: info.contentUrl ?: mediaItem.mediaId)
            .apply { info.contentUrl?.let { setContentUrl(it) } }
            .setStreamType(info.streamType)
            .apply { info.contentType?.let { setContentType(it) } }
            .setMetadata(cast)
            .apply { info.customData?.let { setCustomData(it) } }
            .apply { if (info.streamDuration > 0) setStreamDuration(info.streamDuration) }
            .build()
        return MediaQueueItem.Builder(media)
            .setAutoplay(queueItem.autoplay)
            .setStartTime(queueItem.startTime)
            .setPlaybackDuration(queueItem.playbackDuration)
            .setPreloadTime(queueItem.preloadTime)
            .apply { queueItem.customData?.let { setCustomData(it) } }
            .apply { queueItem.activeTrackIds?.let { setActiveTrackIds(it) } }
            .build()
    }

    override fun toMediaItem(mediaQueueItem: MediaQueueItem): MediaItem = base.toMediaItem(mediaQueueItem)
}
