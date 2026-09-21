package com.beeboentertainment.movie.livetv

import com.beeboentertainment.movie.server.ServerJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The Live TV routes, over the shared bearer client. The playlist and pieces are played straight
 * from the address `watch` returns (its signed ticket is the credential, so a player needs no
 * login); that address is never logged.
 */
class LiveTvClient(private val json: ServerJson) {

    suspend fun status(): LiveStatus = json.get("/api/livetv/status", LiveStatus.serializer())
    suspend fun channels(): ChannelsResponse = json.get("/api/livetv/channels", ChannelsResponse.serializer())
    suspend fun guide(hours: Int = 3, fromMs: Long? = null): GuideResponse =
        json.get("/api/livetv/guide?hours=$hours" + (fromMs?.let { "&from=$it" } ?: ""), GuideResponse.serializer())

    suspend fun setFavourite(channelKey: String, on: Boolean): FavouriteResponse =
        json.post("/api/livetv/favourite", buildJsonObject { put("channel", channelKey); put("on", on) }, FavouriteResponse.serializer())

    /** Tune a channel. Fails with tuners_busy (503) when every tuner is in use. */
    suspend fun watch(channelKey: String): WatchResponse =
        json.post("/api/livetv/watch", buildJsonObject { put("channel", channelKey) }, WatchResponse.serializer())

    /** Let go of the tuner: the last viewer leaving releases it. */
    suspend fun stop(ticket: String): JsonElement =
        json.post("/api/livetv/stop", buildJsonObject { put("ticket", ticket) }, JsonElement.serializer())

    companion object {
        fun get() = LiveTvClient(ServerJson.get())
    }
}
