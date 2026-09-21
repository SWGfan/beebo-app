package com.beeboentertainment.movie.livetv

import kotlinx.serialization.Serializable

/*
 * The Live TV routes under /api/livetv (electron/liveTv/index.js, docs LIVE-TV). The channels come from
 * the owner's own antenna and tuner; Beebo supplies no channel lists or guide data. Names and
 * programme titles are third-party text (they come from the broadcast and the guide file), so
 * everything is cleaned before it is shown. Times are epoch milliseconds.
 */

@Serializable
data class LiveStatus(
    val ok: Boolean = false,
    val enabled: Boolean = false,
    val channelCount: Int = 0,
    val drmHidden: Int = 0,
    val drmNote: String = "",
    val isAdmin: Boolean = false,
    val quality: String = "",
    val timeshiftMinutes: Int = 0,
)

@Serializable
data class Programme(
    val title: String = "",
    val subTitle: String = "",
    val start: Long = 0,
    val stop: Long = 0,
    val isNew: Boolean = false,
)

@Serializable
data class LiveChannel(
    /** The stable id a watch request names. */
    val key: String = "",
    val number: String = "",
    val name: String = "",
    val hd: Boolean = false,
    val hidden: Boolean = false,
    val favourite: Boolean = false,
    val now: Programme? = null,
    val next: Programme? = null,
    /** True when the guide has programmes for this channel. */
    val guide: Boolean = false,
)

@Serializable
data class ChannelsResponse(
    val ok: Boolean = false,
    val channels: List<LiveChannel> = emptyList(),
    val hasGuide: Boolean = false,
    val drmHidden: Int = 0,
    val drmNote: String = "",
)

@Serializable
data class GuideProgramme(
    val start: Long = 0,
    val stop: Long = 0,
    val title: String = "",
    val subTitle: String = "",
    val isNew: Boolean = false,
    val season: Int? = null,
    val episode: Int? = null,
)

@Serializable
data class GuideRow(
    val channel: String = "",
    val number: String = "",
    val name: String = "",
    val favourite: Boolean = false,
    val programmes: List<GuideProgramme> = emptyList(),
)

@Serializable
data class GuideResponse(
    val ok: Boolean = false,
    val from: Long = 0,
    val to: Long = 0,
    val hasGuide: Boolean = false,
    val rows: List<GuideRow> = emptyList(),
)

@Serializable
data class WatchChannel(val key: String = "", val number: String = "", val name: String = "")

@Serializable
data class WatchResponse(
    val ok: Boolean = false,
    /** Server-relative playlist address; only /livetv/hls/ paths are ever played. It carries a signed ticket: never logged. */
    val url: String = "",
    val ticket: String = "",
    val live: Boolean = true,
    val quality: String = "",
    val channel: WatchChannel = WatchChannel(),
    val timeshiftMinutes: Int = 0,
    val now: Programme? = null,
)

@Serializable
data class FavouriteResponse(val ok: Boolean = false, val favourite: Boolean = false)
