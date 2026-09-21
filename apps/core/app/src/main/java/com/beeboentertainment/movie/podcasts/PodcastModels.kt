package com.beeboentertainment.movie.podcasts

import kotlinx.serialization.Serializable

/*
 * The podcast routes under /api/podcasts (electron/podcastApi.js, docs PODCASTS-AND-RADIO). An
 * episode is addressed by its key ("<12 hex show id>.<16 hex episode id>"). Shows and episodes
 * are third-party text and pictures: everything is cleaned before it is shown, artwork loads only
 * over https, and show notes are shown as plain text.
 */

@Serializable
data class PodcastStatus(val ok: Boolean = false, val shows: Int = 0)

@Serializable
data class ShowDto(
    val id: String = "",
    val title: String = "",
    val author: String = "",
    val description: String = "",
    val image: String = "",
    val explicit: Boolean = false,
    val episodeCount: Int = 0,
    val unplayed: Int = 0,
    val error: String = "",
    val pending: Boolean = false,
    val subscribed: Boolean = false,
    val autoDownload: Int = 0,
)

@Serializable
data class EpisodeDto(
    val key: String = "",
    val feedId: String = "",
    val feedTitle: String = "",
    val title: String = "",
    val publishedAt: Long = 0,
    val durationSec: Double = 0.0,
    val summary: String = "",
    val image: String = "",
    val season: Int? = null,
    val episode: Int? = null,
    val explicit: Boolean = false,
    val sizeBytes: Long = 0,
    val downloaded: Boolean = false,
    val hasSilenceVariant: Boolean = false,
    val played: Boolean = false,
    val progressSec: Double = 0.0,
    val inQueue: Boolean = false,
    val hasChapters: Boolean = false,
    /** Server-relative audio address; only /api/podcasts/ paths are ever used. */
    val stream: String = "",
    val notesHtml: String = "",
)

@Serializable
data class SubscriptionsResponse(val ok: Boolean = false, val shows: List<ShowDto> = emptyList())

@Serializable
data class ShowResponse(val ok: Boolean = false, val feed: ShowDto = ShowDto(), val total: Int = 0, val offset: Int = 0, val episodes: List<EpisodeDto> = emptyList())

@Serializable
data class EpisodesResponse(val ok: Boolean = false, val episodes: List<EpisodeDto> = emptyList())

@Serializable
data class EpisodeResponse(val ok: Boolean = false, val episode: EpisodeDto = EpisodeDto())

@Serializable
data class SearchHit(
    val title: String = "",
    val author: String = "",
    val feedUrl: String = "",
    val artwork: String? = null,
    val genre: String = "",
    val episodeCount: Int? = null,
    val feedId: String = "",
    val subscribed: Boolean = false,
)

@Serializable
data class PodcastSearchResponse(val ok: Boolean = false, val results: List<SearchHit> = emptyList())

@Serializable
data class SubscribeResponse(val ok: Boolean = false, val show: ShowDto = ShowDto())

@Serializable
data class ChapterItem(val start: Double = 0.0, val end: Double? = null, val title: String = "", val hidden: Boolean = false)

@Serializable
data class ChaptersResponse(val ok: Boolean = false, val source: String = "none", val chapters: List<ChapterItem> = emptyList())

@Serializable
data class SilenceInfo(val ready: Boolean = false, val status: String = "none")

@Serializable
data class DownloadInfo(
    val downloaded: Boolean = false,
    val size: Long = 0,
    /** none, queued, downloading, downloaded, failed */
    val status: String = "none",
    val error: String = "",
    val silence: SilenceInfo = SilenceInfo(),
)

@Serializable
data class DownloadResponse(val ok: Boolean = false, val download: DownloadInfo = DownloadInfo())

@Serializable
data class PodcastPrefs(val speed: Double = 1.0, val skipSilence: Boolean = false, val speedByFeed: Map<String, Double> = emptyMap())

@Serializable
data class PodcastPrefsResponse(val ok: Boolean = false, val prefs: PodcastPrefs = PodcastPrefs())

@Serializable
data class ProgressAnswer(val ok: Boolean = false, val played: Boolean = false, val progressSec: Double = 0.0)
