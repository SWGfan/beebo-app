package com.beeboentertainment.movie.player

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import com.beeboentertainment.movie.core.MediaMetadataBuilder
import com.beeboentertainment.movie.core.MimeGuess
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.UpNextItem

/**
 * One place that turns a library item into a MediaItem.
 *
 * Both the Activity (its own ⏮ / ⏭ buttons and the PiP remote actions) and the service (the
 * notification, lock screen and headset buttons) move between episodes, and they must produce
 * byte-identical items — same mime type, same media id, same metadata extras — or the resume
 * marks and watch history would key off different things depending on which button was pressed.
 */
@UnstableApi
object MediaItemFactory {

    /** Build from an /api/upnext item (next or previous). Returns null without a usable URL. */
    fun forUpNextItem(baseUrl: String?, item: UpNextItem): MediaItem? {
        val uri = UrlUtils.join(baseUrl, item.stream) ?: return null
        val posterUrl = UrlUtils.join(baseUrl, item.poster)
        return build(
            uri = uri,
            itemId = item.id,
            kind = item.kind,
            title = item.title,
            posterUrl = posterUrl,
            offline = false
        )
    }

    fun build(
        uri: String,
        itemId: String,
        kind: String,
        title: String,
        posterUrl: String?,
        offline: Boolean
    ): MediaItem {
        val spec = MediaMetadataBuilder.forItem(title, posterUrl, kind, offline = offline)
        val metadata = MediaMetadata.Builder()
            .setTitle(spec.title)
            .setDisplayTitle(spec.title)
            .setArtist(spec.subtitle)
            .setSubtitle(spec.subtitle)
            .apply { spec.artworkUri?.let { setArtworkUri(Uri.parse(it)) } }
            .setExtras(PlaybackService.Extras.bundle(itemId.ifBlank { uri }, spec.kind))
            .build()

        return MediaItem.Builder()
            .setUri(uri)
            .setMimeType(MimeGuess.forStreamUrl(uri, title))
            .setMediaId(itemId.ifBlank { uri })
            .setMediaMetadata(metadata)
            .build()
    }
}
