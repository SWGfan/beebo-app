package com.beeboentertainment.auto.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * Wire models for the Beebo Entertainment `/api/…` contract served by
 * apps/desktop/electron/streamServer.js on port 47811.
 *
 * Every field name here is copied verbatim from the server's JSON. Nullable
 * fields all carry a `= null` default and the Json parser is configured with
 * ignoreUnknownKeys, so the server can grow fields without breaking the car.
 */

@Serializable
data class User(
    val id: String = "",
    val name: String = "",
    val isAdmin: Boolean = false,
)

@Serializable
data class PingResponse(
    val ok: Boolean = false,
    val app: String? = null,
    val apiVersion: Int = 0,
)

@Serializable
data class LoginRequest(val username: String, val password: String)

@Serializable
data class LoginResponse(
    val ok: Boolean = false,
    val token: String? = null,
    val user: User? = null,
    val error: String? = null,
    val locked: Boolean = false,
    val minutesRemaining: Int? = null,
)

/**
 * What the server says the newest published build of this app is.
 *
 * The original Beebo Entertainment phone app has no version check at all — nothing tells
 * anyone a new build exists. This is the fix for that, for this app at least.
 */
@Serializable
data class AutoVersionResponse(
    val ok: Boolean = false,
    val versionCode: Int = 0,
    val versionName: String? = null,
    val notes: String? = null,
    val downloadUrl: String? = null,
)

@Serializable
data class MeResponse(val ok: Boolean = false, val user: User? = null)

@Serializable
data class Genre(val id: Int, val name: String = "", val count: Int = 0)

@Serializable
data class MovieItem(
    val id: String,
    val title: String = "",
    val year: Int? = null,
    val poster: String? = null,
    val quality: String? = null,
    val genres: List<Int> = emptyList(),
    val overview: String? = null,
    val isNew: Boolean = false,
    val collectionName: String? = null,
    val collectionId: Int? = null,
    val stream: String = "",
)

@Serializable
data class MoviesResponse(
    val ok: Boolean = false,
    val genres: List<Genre> = emptyList(),
    val items: List<MovieItem> = emptyList(),
)

@Serializable
data class ShowItem(
    val key: String,
    val name: String = "",
    val year: Int? = null,
    val poster: String? = null,
    val episodeCount: Int = 0,
    val isNew: Boolean = false,
    val quality: String? = null,
    val genres: List<Int> = emptyList(),
)

@Serializable
data class TvShowsResponse(
    val ok: Boolean = false,
    val genres: List<Genre> = emptyList(),
    val items: List<ShowItem> = emptyList(),
)

@Serializable
data class EpisodeItem(
    val id: String,
    val season: Int? = null,
    val episode: Int? = null,
    val title: String = "",
    val quality: String? = null,
    val stream: String = "",
)

@Serializable
data class SeasonBlock(
    val season: Int? = null,
    val episodes: List<EpisodeItem> = emptyList(),
)

@Serializable
data class ShowHeader(
    val key: String = "",
    val name: String = "",
    val poster: String? = null,
    val overview: String? = null,
)

@Serializable
data class EpisodesResponse(
    val ok: Boolean = false,
    val show: ShowHeader = ShowHeader(),
    val seasons: List<SeasonBlock> = emptyList(),
)

@Serializable
data class EpisodeContextResponse(
    val ok: Boolean = false,
    val showKey: String? = null,
    val showName: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val error: String? = null,
)

@Serializable
data class HistoryItem(
    val id: String,
    val kind: String = "movie",
    val title: String = "",
    val poster: String? = null,
    val stream: String = "",
    val currentTime: Double = 0.0,
    val duration: Double = 0.0,
    val percent: Int = 0,
)

@Serializable
data class HistoryResponse(
    val ok: Boolean = false,
    val items: List<HistoryItem> = emptyList(),
)

@Serializable
data class SurfItem(
    val id: String,
    val kind: String = "movie",
    val title: String = "",
    val poster: String? = null,
    val stream: String = "",
)

@Serializable
data class SurfResponse(
    val ok: Boolean = false,
    // uint32 on the wire — Int would overflow.
    val seed: Long = 0L,
    val index: Int = 0,
    val total: Int = 0,
    val startFraction: Double = 0.5,
    val item: SurfItem? = null,
)

@Serializable
data class WatchSessionRequest(val kind: String, val id: String, val surf: Boolean = false)

@Serializable
data class WatchSessionResponse(
    val ok: Boolean = false,
    val sessionId: String? = null,
    val error: String? = null,
)

@Serializable
data class ProgressRequest(
    val sessionId: String,
    val currentTime: Double,
    val duration: Double,
)

@Serializable
data class OkResponse(val ok: Boolean = false, val error: String? = null)

/** Thrown for a 401 — the caller should drop the token and re-login. */
class UnauthorizedException : Exception("unauthorized")

class ApiException(val status: Int, val error: String?) :
    Exception("HTTP $status${error?.let { " ($it)" } ?: ""}")
