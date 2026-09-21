package com.beeboentertainment.movie.downloads

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

enum class DownloadStatus { QUEUED, RUNNING, COMPLETE, FAILED }

/**
 * One offline item. Persisted as JSON in SharedPreferences so downloads survive app restarts
 * (both the finished ones and the half-finished ones, which are resumed with an HTTP Range
 * request the next time the user hits retry).
 */
@Serializable
data class DownloadRecord(
    val id: String,
    val kind: String,                  // "movie" | "tv"
    val title: String,
    val posterUrl: String? = null,
    val streamUrl: String,             // absolute, includes the 12h media token
    val fileName: String,
    val status: String = DownloadStatus.QUEUED.name,
    val bytesDownloaded: Long = 0L,
    val totalBytes: Long = 0L,
    val error: String? = null,
    val updatedAt: Long = 0L,
    /** TV only: which show and season this episode belongs to, so the Downloads screen can group it. */
    val showKey: String? = null,
    val showName: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    /** Queue position. Lower goes first; survives restarts, so a season resumes in episode order. */
    val queueSeq: Long = 0L,
    /** One-time "Download now using mobile data" for this download only, while Wi-Fi-only is on. */
    val allowMobileData: Boolean = false,
    /** The server's size for this file when it reports one (0 = unknown). Used before the transfer starts. */
    val expectedBytes: Long = 0L,
    /**
     * Set the moment the owner opens this download to play it (see DownloadsScreen's onPlay).
     * Not a "finished watching" mark like the server's own watched state — just "has been
     * opened at least once, and when" — which is enough to safely deprioritize it if the phone
     * ever needs the space back. Null means never opened from Downloads.
     */
    val lastPlayedAt: Long? = null,
    /**
     * What the server said this file was on the first reply (its ETag, else Last-Modified). Sent back
     * as If-Range when a transfer resumes, so a file replaced on the server starts over instead of
     * being spliced onto the old bytes.
     */
    val validator: String? = null,
    /** Smoothed speed while transferring, bytes per second (0 when not known): shown as speed and time left. */
    val speedBps: Long = 0L
) {
    val statusEnum: DownloadStatus
        get() = runCatching { DownloadStatus.valueOf(status) }.getOrDefault(DownloadStatus.FAILED)

    val isComplete: Boolean get() = statusEnum == DownloadStatus.COMPLETE

    /** 0..100, or -1 when the server never told us a content length. */
    val percent: Int
        get() = if (totalBytes > 0) ((bytesDownloaded * 100) / totalBytes).toInt().coerceIn(0, 100) else -1
}

/**
 * Pure (no Android) manipulation of the download index. Kept separate from the SharedPreferences
 * plumbing so it can be unit-tested headlessly.
 */
object DownloadIndex {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** The note on a row the user paused: it is a FAILED row underneath, so retrying resumes it. */
    const val PAUSED_NOTE = "Paused"

    fun decode(raw: String?): List<DownloadRecord> {
        if (raw.isNullOrBlank()) return emptyList()
        return runCatching { json.decodeFromString<List<DownloadRecord>>(raw) }.getOrDefault(emptyList())
    }

    fun encode(list: List<DownloadRecord>): String =
        json.encodeToString(kotlinx.serialization.builtins.ListSerializer(DownloadRecord.serializer()), list)

    /** Insert or replace by id, newest first. */
    fun upsert(list: List<DownloadRecord>, record: DownloadRecord): List<DownloadRecord> {
        val without = list.filterNot { it.id == record.id }
        return listOf(record) + without
    }

    fun remove(list: List<DownloadRecord>, id: String): List<DownloadRecord> =
        list.filterNot { it.id == id }

    fun find(list: List<DownloadRecord>, id: String): DownloadRecord? = list.firstOrNull { it.id == id }

    /**
     * Anything left RUNNING when the process died is not actually running any more, so it goes
     * back in the queue (its .part is kept and resumed with a Range request). QUEUED rows stay
     * queued: a season queued last night carries on after a restart instead of failing.
     */
    fun reconcileAfterRestart(list: List<DownloadRecord>): List<DownloadRecord> = list.map {
        if (it.statusEnum == DownloadStatus.RUNNING) {
            it.copy(status = DownloadStatus.QUEUED.name, error = null, speedBps = 0L)
        } else it
    }

    /** Queued rows in the order they will download: queue position, then oldest first. */
    fun queueOrder(list: List<DownloadRecord>): List<DownloadRecord> =
        list.filter { it.statusEnum == DownloadStatus.QUEUED }
            .sortedWith(compareBy<DownloadRecord>({ it.queueSeq }, { it.updatedAt }))

    /** The next row the downloader should pick up, or null if nothing queued may run right now. */
    fun nextRunnable(list: List<DownloadRecord>, mayRun: (DownloadRecord) -> Boolean): DownloadRecord? =
        queueOrder(list).firstOrNull(mayRun)

    /** Highest queue position in use, so new rows go after everything already queued. */
    fun maxSeq(list: List<DownloadRecord>): Long = list.maxOfOrNull { it.queueSeq } ?: 0L

    /**
     * Can this row be stopped? Only something queued or actually transferring — a finished or
     * failed download is deleted, not stopped.
     */
    fun canStop(record: DownloadRecord?): Boolean =
        record != null && (record.statusEnum == DownloadStatus.QUEUED || record.statusEnum == DownloadStatus.RUNNING)

    /**
     * Stopping a download removes its row outright rather than parking it in a "stopped" state.
     *
     * This is a mis-click remedy: the user is saying "I never wanted this". Leaving a stopped
     * stub behind would mean another thing to tidy up, and a half-finished .part eating storage.
     * Starting it again later is then an ordinary fresh enqueue with no special-case state to
     * get wrong, so a stopped item can never end up permanently stuck.
     */
    fun stop(list: List<DownloadRecord>, id: String): List<DownloadRecord> = remove(list, id)

    /** What a tap on the download control means, given the row's current state. */
    enum class TapAction { START, STOP, DELETE }

    /**
     * A single tap has to mean something different depending on state, and the wrong guess is
     * exactly the bug the owner hit: previously, tapping a downloading item RE-ENQUEUED it.
     */
    fun tapAction(record: DownloadRecord?): TapAction = when {
        record == null -> TapAction.START
        record.statusEnum == DownloadStatus.COMPLETE -> TapAction.DELETE
        canStop(record) -> TapAction.STOP
        else -> TapAction.START          // FAILED -> try again
    }

    /** Confirmation copy. Every one of these actions is destructive or expensive, so all confirm. */
    fun confirmTitle(action: TapAction): String = when (action) {
        TapAction.START -> "Download?"
        TapAction.STOP -> "Stop download?"
        TapAction.DELETE -> "Delete download?"
    }

    fun confirmMessage(action: TapAction, title: String?): String {
        val name = title?.trim().orEmpty().ifBlank { "this title" }
        return when (action) {
            TapAction.START ->
                "Keep \"$name\" on this phone for offline viewing? Films can be several GB."
            TapAction.STOP ->
                "Stop downloading \"$name\"? The part already downloaded will be deleted."
            TapAction.DELETE ->
                "Remove the downloaded copy of \"$name\" from this phone?"
        }
    }

    fun confirmButton(action: TapAction): String = when (action) {
        TapAction.START -> "Download"
        TapAction.STOP -> "Stop"
        TapAction.DELETE -> "Delete"
    }

    /** Safe, collision-free file name for app-private storage. */
    fun fileNameFor(id: String, title: String): String {
        val safeTitle = title.replace(Regex("[^A-Za-z0-9 ._-]"), "_").trim().take(60).ifBlank { "video" }
        val hash = Integer.toHexString(id.hashCode())
        return "${safeTitle}_$hash.dat"
    }
}
