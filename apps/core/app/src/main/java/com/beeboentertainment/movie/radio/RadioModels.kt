package com.beeboentertainment.movie.radio

import kotlinx.serialization.Serializable

/*
 * The radio routes under /api/radio (electron/radioApi.js, docs PODCASTS-AND-RADIO). A station id is
 * "rb:<uuid>" (the open Radio Browser directory) or "c:<12 hex>" (one the person added). The
 * station's own stream address is deliberately not modelled: the app only ever plays the
 * computer's relay of it, and only ever shows names, tags and logos.
 */

@Serializable
data class Station(
    val id: String = "",
    val name: String = "",
    val homepage: String = "",
    val favicon: String = "",
    val tags: List<String> = emptyList(),
    val country: String = "",
    val countryCode: String = "",
    val language: String = "",
    val codec: String = "",
    val bitrate: Int = 0,
    val votes: Int = 0,
    val source: String = "",
)

@Serializable
data class RadioStatus(val ok: Boolean = false, val sessions: Int = 0)

@Serializable
data class StationsResponse(val ok: Boolean = false, val stations: List<Station> = emptyList())

@Serializable
data class FavoritesResponse(val ok: Boolean = false, val favorites: List<Station> = emptyList())

@Serializable
data class CustomResponse(val ok: Boolean = false, val custom: List<Station> = emptyList(), val station: Station? = null)

@Serializable
data class RecentResponse(val ok: Boolean = false, val recent: List<Station> = emptyList())

@Serializable
data class NowPlaying(val raw: String = "", val artist: String = "", val title: String = "", val at: Long = 0)

@Serializable
data class SessionStation(val id: String = "", val name: String = "", val favicon: String = "", val homepage: String = "", val source: String = "")

@Serializable
data class SessionInfo(val name: String = "", val genre: String = "", val bitrate: Int = 0, val contentType: String = "", val hasMetadata: Boolean = false)

@Serializable
data class RadioSession(
    val id: String = "",
    val station: SessionStation = SessionStation(),
    /** connecting, live, reconnecting, failed, idle, closed */
    val state: String = "",
    val error: String = "",
    val nowPlaying: NowPlaying? = null,
    val history: List<NowPlaying> = emptyList(),
    val info: SessionInfo = SessionInfo(),
    val reconnects: Int = 0,
    val listeners: Int = 0,
    val startedAt: Long = 0,
    /** Server-relative audio address; only /api/radio/session/ paths are ever used. */
    val stream: String = "",
)

@Serializable
data class PlayResponse(val ok: Boolean = false, val session: RadioSession = RadioSession())

@Serializable
data class SessionResponse(val ok: Boolean = false, val session: RadioSession = RadioSession())
