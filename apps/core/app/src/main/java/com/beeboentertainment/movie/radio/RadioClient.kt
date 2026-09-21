package com.beeboentertainment.movie.radio

import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.server.ServerJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The radio routes, over the shared bearer client. Station addresses are never logged. */
class RadioClient(private val json: ServerJson) {

    private fun enc(s: String) = UrlUtils.encode(s)

    suspend fun status(): RadioStatus = json.get("/api/radio/status", RadioStatus.serializer())

    suspend fun browse(name: String? = null, tag: String? = null, country: String? = null, order: String = "votes", limit: Int = 60, offset: Int = 0): StationsResponse =
        json.get(
            "/api/radio/browse" + UrlUtils.query(
                "name" to name, "tag" to tag, "country" to country, "order" to order, "limit" to limit.toString(),
                "offset" to offset.takeIf { it > 0 }?.toString()
            ),
            StationsResponse.serializer()
        )

    suspend fun favourites(): FavoritesResponse = json.get("/api/radio/favorites", FavoritesResponse.serializer())
    suspend fun addFavourite(s: Station): FavoritesResponse =
        json.post("/api/radio/favorites", buildJsonObject { put("id", s.id) }, FavoritesResponse.serializer())
    suspend fun removeFavourite(id: String): FavoritesResponse = json.delete("/api/radio/favorites/${enc(id)}", FavoritesResponse.serializer())

    suspend fun custom(): CustomResponse = json.get("/api/radio/custom", CustomResponse.serializer())
    suspend fun addCustom(name: String, url: String): CustomResponse =
        json.post("/api/radio/custom", buildJsonObject { put("name", name); put("url", url) }, CustomResponse.serializer())
    suspend fun removeCustom(id: String): CustomResponse = json.delete("/api/radio/custom/${enc(id)}", CustomResponse.serializer())

    suspend fun recent(): RecentResponse = json.get("/api/radio/recent", RecentResponse.serializer())

    /** Start a station: the computer connects to it first, so a dead address fails here with a reason. */
    suspend fun play(stationId: String): PlayResponse =
        json.post("/api/radio/play", buildJsonObject { put("stationId", stationId) }, PlayResponse.serializer())

    suspend fun session(id: String): SessionResponse = json.get("/api/radio/session/${enc(id)}", SessionResponse.serializer())
    suspend fun stop(id: String): JsonElement = json.delete("/api/radio/session/${enc(id)}", JsonElement.serializer())

    companion object {
        fun get() = RadioClient(ServerJson.get())
    }
}
