package com.beeboentertainment.movie.podcasts

import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.server.ServerJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The podcast routes, over the shared bearer client. Feed addresses are never logged. */
class PodcastClient(private val json: ServerJson) {

    private fun enc(s: String) = UrlUtils.encode(s)

    suspend fun status(): PodcastStatus = json.get("/api/podcasts/status", PodcastStatus.serializer())
    suspend fun subscriptions(): SubscriptionsResponse = json.get("/api/podcasts/subscriptions", SubscriptionsResponse.serializer())
    suspend fun latest(limit: Int = 40): EpisodesResponse = json.get("/api/podcasts/latest?limit=$limit", EpisodesResponse.serializer())
    suspend fun continueListening(): EpisodesResponse = json.get("/api/podcasts/continue", EpisodesResponse.serializer())
    suspend fun queue(): EpisodesResponse = json.get("/api/podcasts/queue", EpisodesResponse.serializer())

    suspend fun show(id: String, unplayedOnly: Boolean = false, offset: Int = 0, limit: Int = 60): ShowResponse =
        json.get(
            "/api/podcasts/show/${enc(id)}" + UrlUtils.query(
                "unplayed" to (if (unplayedOnly) "1" else null), "offset" to offset.takeIf { it > 0 }?.toString(), "limit" to limit.toString()
            ),
            ShowResponse.serializer()
        )

    suspend fun episode(key: String): EpisodeResponse = json.get("/api/podcasts/episode/${enc(key)}", EpisodeResponse.serializer())
    suspend fun chapters(key: String): ChaptersResponse = json.get("/api/podcasts/episode/${enc(key)}/chapters", ChaptersResponse.serializer())

    suspend fun search(q: String, country: String? = null): PodcastSearchResponse =
        json.get("/api/podcasts/search" + UrlUtils.query("q" to q, "country" to country), PodcastSearchResponse.serializer())

    /** Follow a show by its feed address. */
    suspend fun follow(feedUrl: String): SubscribeResponse =
        json.post("/api/podcasts/subscriptions", buildJsonObject { put("url", feedUrl) }, SubscribeResponse.serializer())

    suspend fun unfollow(showId: String): JsonElement =
        json.delete("/api/podcasts/subscriptions/${enc(showId)}", JsonElement.serializer())

    suspend fun refresh(showId: String): JsonElement =
        json.post("/api/podcasts/refresh", buildJsonObject { put("showId", showId) }, JsonElement.serializer())

    suspend fun queueAdd(key: String, next: Boolean): EpisodesResponse =
        json.post("/api/podcasts/queue", buildJsonObject { put("episode", key); if (next) put("next", true) }, EpisodesResponse.serializer())

    suspend fun queueRemove(key: String): EpisodesResponse = json.delete("/api/podcasts/queue/${enc(key)}", EpisodesResponse.serializer())
    suspend fun queueClear(): EpisodesResponse = json.post("/api/podcasts/queue/clear", null, EpisodesResponse.serializer())

    suspend fun saveProgress(key: String, positionSec: Double, durationSec: Double): ProgressAnswer =
        json.post("/api/podcasts/episode/${enc(key)}/progress", buildJsonObject { put("position", positionSec); put("duration", durationSec) }, ProgressAnswer.serializer())

    suspend fun markPlayed(key: String, played: Boolean): ProgressAnswer =
        json.post("/api/podcasts/episode/${enc(key)}/played", buildJsonObject { put("played", played) }, ProgressAnswer.serializer())

    suspend fun downloadInfo(key: String): DownloadResponse = json.get("/api/podcasts/episode/${enc(key)}/download", DownloadResponse.serializer())
    suspend fun download(key: String): DownloadResponse = json.post("/api/podcasts/episode/${enc(key)}/download", null, DownloadResponse.serializer())
    suspend fun removeDownload(key: String): JsonElement = json.delete("/api/podcasts/episode/${enc(key)}/download", JsonElement.serializer())

    suspend fun prefs(): PodcastPrefsResponse = json.get("/api/podcasts/prefs", PodcastPrefsResponse.serializer())
    suspend fun setSpeed(speed: Double, feedId: String? = null): PodcastPrefsResponse =
        json.post(
            "/api/podcasts/prefs",
            buildJsonObject { if (feedId == null) put("speed", speed) else { put("feedId", feedId); put("feedSpeed", speed) } },
            PodcastPrefsResponse.serializer()
        )

    companion object {
        fun get() = PodcastClient(ServerJson.get())
    }
}
