package com.beeboentertainment.movie.data

import kotlinx.serialization.Serializable

/*
 * GET /api/admin/dashboard and POST /api/admin/dashboard/stop (the PC's serverDashboard.js).
 * Every field has a default, like the other admin DTOs, so an older or newer PC never crashes
 * the screen: a section the PC did not send is simply null.
 */

@Serializable
data class DashboardNowPlaying(
    val id: String = "",
    val streamId: String? = null,
    val user: String = "",
    val title: String = "",
    val kind: String = "movie",
    val device: String = "",
    val where: String = "",
    val whereLabel: String = "",
    val positionSeconds: Double = 0.0,
    val durationSeconds: Double = 0.0,
    val progress: Double? = null,
    val playback: String = "direct",
    val playbackLabel: String = "",
    val currentBitsPerSec: Long = 0,
    val fileBitsPerSec: Long? = null,
    val paused: Boolean = false,
    val stoppable: Boolean = false
)

@Serializable
data class DashboardStreamRate(
    val streamId: String = "",
    val title: String = "",
    val bytesPerSec: Long = 0,
    val bytesSent: Long = 0
)

@Serializable
data class DashboardBandwidth(
    val currentBitsPerSec: Long = 0,
    val peakTodayBytesPerSec: Long = 0,
    val sentTodayBytes: Long = 0,
    val streams: List<DashboardStreamRate> = emptyList()
)

@Serializable
data class DashboardDay(val day: String = "", val plays: Int = 0, val seconds: Long = 0)

@Serializable
data class DashboardTitle(val title: String = "", val kind: String = "movie", val plays: Int = 0, val seconds: Long = 0)

@Serializable
data class DashboardMember(val userId: String = "", val name: String = "", val plays: Int = 0, val seconds: Long = 0)

@Serializable
data class DashboardTotals(val plays: Int = 0, val seconds: Long = 0)

@Serializable
data class DashboardActivity(
    val days: Int = 7,
    val totals: DashboardTotals = DashboardTotals(),
    val daily: List<DashboardDay> = emptyList(),
    val topTitles: List<DashboardTitle> = emptyList(),
    val watchTimeByMember: List<DashboardMember> = emptyList(),
    val partial: Boolean = false
)

@Serializable
data class DashboardExtraCount(val kind: String = "", val label: String = "", val count: Int = 0)

@Serializable
data class DashboardCounts(
    val movies: Int = 0,
    val shows: Int = 0,
    val episodes: Int = 0,
    val extra: List<DashboardExtraCount> = emptyList()
)

@Serializable
data class DashboardFolder(val kind: String = "", val dir: String = "", val usedBytes: Long = 0, val files: Int = 0)

@Serializable
data class DashboardDisk(val disk: String = "", val totalBytes: Long = 0, val freeBytes: Long = 0, val usedBytes: Long = 0)

@Serializable
data class DashboardStorage(val folders: List<DashboardFolder> = emptyList(), val disks: List<DashboardDisk> = emptyList())

@Serializable
data class DashboardRecent(val title: String = "", val addedAt: Long? = null)

@Serializable
data class DashboardMissingPosters(val movies: Int = 0, val shows: Int = 0, val examples: List<String> = emptyList())

@Serializable
data class DashboardConverterCurrent(val title: String = "", val progress: Double? = null)

@Serializable
data class DashboardConverter(
    val queued: Int = 0,
    val converting: Int = 0,
    val done: Int = 0,
    val failed: Int = 0,
    val current: DashboardConverterCurrent? = null,
    val paused: Boolean = false
)

@Serializable
data class DashboardInbox(
    val enabled: Boolean = false,
    val paused: Boolean = false,
    val sortedToday: Int = 0,
    val waitingForCopy: Int = 0,
    val needsLook: Int = 0,
    val problem: String = ""
)

@Serializable
data class DashboardLibrary(
    val counts: DashboardCounts = DashboardCounts(),
    val storage: DashboardStorage = DashboardStorage(),
    val recentlyAdded: List<DashboardRecent> = emptyList(),
    val missingPosters: DashboardMissingPosters? = null,
    val converter: DashboardConverter = DashboardConverter(),
    val inbox: DashboardInbox? = null
)

@Serializable
data class DashboardSystemMemory(val totalBytes: Long = 0, val freeBytes: Long = 0)

@Serializable
data class DashboardVersions(val app: String = "", val electron: String = "", val node: String = "", val os: String = "")

@Serializable
data class DashboardAway(
    val registered: Boolean = false,
    val address: String = "",
    val online: Boolean? = null,
    val problem: String = ""
)

@Serializable
data class DashboardRelayBytes(val beebo: Long = 0, val cloudflare: Long = 0, val custom: Long = 0)

@Serializable
data class DashboardRelay(val bytes: DashboardRelayBytes = DashboardRelayBytes(), val totalBytes: Long = 0)

@Serializable
data class DashboardLogLine(val at: Long = 0, val message: String = "")

@Serializable
data class DashboardErrors(val count: Int = 0, val recent: List<DashboardLogLine> = emptyList())

@Serializable
data class DashboardUpdate(val available: Boolean = false, val latest: String = "")

@Serializable
data class DashboardHealth(
    val cpuPercent: Double? = null,
    val memoryBytes: Long = 0,
    val systemMemory: DashboardSystemMemory = DashboardSystemMemory(),
    val uptimeSeconds: Long = 0,
    val versions: DashboardVersions = DashboardVersions(),
    val away: DashboardAway = DashboardAway(),
    val relay: DashboardRelay = DashboardRelay(),
    val lastBackupAt: Long? = null,
    val errors24h: DashboardErrors = DashboardErrors(),
    val update: DashboardUpdate? = null
)

@Serializable
data class AdminDashboardResponse(
    val ok: Boolean = false,
    val generatedAt: Long = 0,
    val canStopStreams: Boolean = false,
    val nowPlaying: List<DashboardNowPlaying>? = null,
    val bandwidth: DashboardBandwidth? = null,
    val health: DashboardHealth? = null,
    val activity: DashboardActivity? = null,
    val library: DashboardLibrary? = null,
    val error: String? = null
)

@Serializable
data class AdminStopStreamRequest(val streamId: String)

@Serializable
data class AdminStopStreamResponse(val ok: Boolean = false, val error: String? = null, val blockedForSeconds: Int? = null)
