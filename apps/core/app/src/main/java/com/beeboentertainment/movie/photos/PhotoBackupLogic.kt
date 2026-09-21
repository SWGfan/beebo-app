package com.beeboentertainment.movie.photos

import kotlinx.serialization.Serializable

/*
 * Photo backup rules with no Android in them, so every decision is unit tested:
 * which photos are waiting, what order they go in, how an upload recovers from each server answer,
 * which permissions to ask for on each Android version and what the status line says.
 *
 * Nothing in the backup feature can delete, move or change a file on the phone: it only reads
 * MediaStore and file bytes. There is deliberately no API here that could.
 */

/** One photo or video on the phone, as MediaStore describes it. */
data class MediaCandidate(
    val id: Long,
    val uri: String,
    val name: String,
    val size: Long,
    val isVideo: Boolean,
    /** When it was taken (DATE_TAKEN), or 0 when MediaStore does not know. */
    val dateTakenMs: Long,
    /** When it arrived on the phone, in seconds (DATE_ADDED). */
    val dateAddedSec: Long,
    /** Last change, in seconds (DATE_MODIFIED). Part of the key, so an edited photo is sent again. */
    val dateModifiedSec: Long,
    val bucketName: String,
    val mimeType: String = "",
) {
    /** Stable identity of this exact version of the file on this phone. */
    val key: String get() = "$id:$size:$dateModifiedSec"

    /** Best capture time for the PC's YYYY/MM folders. */
    val takenAtMs: Long get() = if (dateTakenMs > 0) dateTakenMs else dateAddedSec * 1000
}

@Serializable
data class BackupSettings(
    val enabled: Boolean = false,
    /** Album (bucket) names to back up. Camera by default. */
    val albums: Set<String> = setOf(CAMERA_ALBUM),
    val wifiOnly: Boolean = true,
    val chargingOnly: Boolean = false,
    val includeVideos: Boolean = true,
    /** false = also back up what is already on the phone; true = only what arrives after [enabledAtSec]. */
    val onlyNew: Boolean = false,
    val enabledAtSec: Long = 0,
    val paused: Boolean = false,
    /** The Play build asks for a clear yes on the disclosure before any photo permission prompt. */
    val disclosureAcceptedVersion: Int = 0,
) {
    val active: Boolean get() = enabled && !paused

    companion object {
        const val CAMERA_ALBUM = "Camera"
    }
}

object PhotoBackupLogic {

    /** Bump when the disclosure wording changes materially; people then see and accept it again. */
    const val DISCLOSURE_VERSION = 1

    /** Server's default and our ceiling: small enough to pass the away-from-home tunnel comfortably. */
    const val CHUNK_BYTES = 512 * 1024
    const val MAX_ATTEMPTS = 5

    /** The albums that count as "Camera" (phones name the folder differently). */
    private val cameraNames = setOf("camera", "dcim", "100andro", "100media", "open camera")

    fun albumSelected(bucketName: String, albums: Set<String>): Boolean {
        val b = bucketName.trim().lowercase()
        return albums.any { a ->
            val want = a.trim().lowercase()
            want == b || (want == BackupSettings.CAMERA_ALBUM.lowercase() && b in cameraNames)
        }
    }

    /**
     * What still needs backing up, newest first (the photo you just took is the one you would miss
     * most). Skips anything already done, anything that failed too often, videos when they are off
     * and, in "only new" mode, anything that was on the phone before backup was turned on.
     */
    fun pending(
        candidates: List<MediaCandidate>,
        settings: BackupSettings,
        done: Set<String>,
        attempts: Map<String, Int> = emptyMap(),
    ): List<MediaCandidate> = candidates.asSequence()
        .filter { it.size > 0 }
        .filter { settings.includeVideos || !it.isVideo }
        .filter { albumSelected(it.bucketName, settings.albums) }
        .filter { !settings.onlyNew || it.dateAddedSec >= settings.enabledAtSec }
        .filter { it.key !in done }
        .filter { (attempts[it.key] ?: 0) < MAX_ATTEMPTS }
        .sortedWith(compareByDescending<MediaCandidate> { it.takenAtMs }.thenByDescending { it.id })
        .toList()

    /** Byte range of the next chunk, or null when [offset] is already at the end. */
    fun nextChunk(offset: Long, size: Long, chunkBytes: Int = CHUNK_BYTES): LongRange? {
        if (offset < 0 || offset >= size) return null
        val end = minOf(size, offset + chunkBytes.coerceIn(16 * 1024, 4 * 1024 * 1024)) - 1
        return offset..end
    }

    /** What to do after the server answers a chunk or finish request. */
    sealed class Step {
        /** Carry on sending from [offset]. */
        data class Continue(val offset: Long) : Step()
        /** The file is safely on the PC (saved now, or it already had it). */
        object Done : Step()
        /** The PC discarded the partial file; begin again from the start. */
        object Restart : Step()
        /** Try the same request again shortly (network hiccup, PC busy). */
        object RetryLater : Step()
        /** Skip this file for now and count an attempt (the file itself is the problem). */
        data class SkipFile(val reason: String) : Step()
        /** Stop the whole run; the message is for the status line. */
        data class Stop(val message: String, val signedOut: Boolean = false) : Step()
    }

    /**
     * Map an HTTP answer to the next step. [serverOffset] is the `offset` the server put in its
     * JSON (present on 200 and on 409/422 conflicts).
     */
    fun stepFor(httpCode: Int, error: String?, serverOffset: Long?, finished: Boolean = false): Step = when {
        httpCode in 200..299 && finished -> Step.Done
        httpCode in 200..299 && serverOffset != null -> Step.Continue(serverOffset)
        httpCode in 200..299 -> Step.RetryLater
        httpCode == 401 -> Step.Stop("Sign in to Beebo again to keep backing up.", signedOut = true)
        httpCode == 403 && error == "backup_not_allowed" ->
            Step.Stop("The owner of this Beebo hasn't allowed photo backup for your account yet.")
        httpCode == 403 -> Step.Stop("Your Beebo account can't back up photos.")
        httpCode == 404 && error == "upload_not_found" -> Step.Restart
        httpCode == 404 -> Step.Stop("Your home computer needs the latest Beebo for photo backup.")
        httpCode == 409 && error == "offset_mismatch" && serverOffset != null -> Step.Continue(serverOffset)
        httpCode == 409 && error == "incomplete" && serverOffset != null -> Step.Continue(serverOffset)
        httpCode == 409 -> Step.RetryLater
        httpCode == 422 && error == "checksum_mismatch" -> Step.Restart
        httpCode == 422 -> Step.Continue(serverOffset ?: 0) // one chunk arrived damaged: resend it
        httpCode == 413 -> Step.Stop("Your home computer refused the upload size. Update Beebo on the computer.")
        httpCode == 415 -> Step.SkipFile("not a photo or video")
        httpCode == 507 -> Step.Stop("Your home computer's disk is full.")
        httpCode == 400 -> Step.SkipFile(error ?: "rejected")
        else -> Step.RetryLater // 5xx, 429, tunnel trouble
    }

    /** Wait before retrying the [attempt]th time (1-based): 2 s, 4 s, 8 s ... capped at a minute. */
    fun retryDelayMs(attempt: Int): Long = (1000L shl attempt.coerceIn(1, 6)).coerceAtMost(60_000L)

    /* ------------------------------ permissions ------------------------------ */

    enum class MediaAccess { FULL, PARTIAL, NONE }

    const val READ_EXTERNAL_STORAGE = "android.permission.READ_EXTERNAL_STORAGE"
    const val READ_MEDIA_IMAGES = "android.permission.READ_MEDIA_IMAGES"
    const val READ_MEDIA_VIDEO = "android.permission.READ_MEDIA_VIDEO"
    const val READ_MEDIA_VISUAL_USER_SELECTED = "android.permission.READ_MEDIA_VISUAL_USER_SELECTED"

    /**
     * The runtime permissions to request together. Android 14+ must include
     * READ_MEDIA_VISUAL_USER_SELECTED in the same request, which is what makes the system dialog
     * offer "Select photos and videos" alongside "Allow all".
     */
    fun permissionsToRequest(sdkInt: Int, includeVideos: Boolean): List<String> = when {
        sdkInt >= 34 -> listOfNotNull(READ_MEDIA_IMAGES, READ_MEDIA_VIDEO.takeIf { includeVideos }, READ_MEDIA_VISUAL_USER_SELECTED)
        sdkInt >= 33 -> listOfNotNull(READ_MEDIA_IMAGES, READ_MEDIA_VIDEO.takeIf { includeVideos })
        else -> listOf(READ_EXTERNAL_STORAGE)
    }

    /** What the app can read now, from the grant state of each permission. */
    fun access(sdkInt: Int, granted: (String) -> Boolean, includeVideos: Boolean = true): MediaAccess = when {
        sdkInt >= 33 && granted(READ_MEDIA_IMAGES) && (!includeVideos || granted(READ_MEDIA_VIDEO)) -> MediaAccess.FULL
        sdkInt >= 34 && granted(READ_MEDIA_VISUAL_USER_SELECTED) -> MediaAccess.PARTIAL
        sdkInt >= 33 && granted(READ_MEDIA_IMAGES) -> MediaAccess.PARTIAL // photos yes, videos no
        sdkInt < 33 && granted(READ_EXTERNAL_STORAGE) -> MediaAccess.FULL
        else -> MediaAccess.NONE
    }

    /**
     * Whether the explanation screen must be accepted before the permission prompt. The Play build
     * always asks for an explicit yes (Google Play's photo and video permissions policy); the
     * website build shows the same explanation but turning the switch on is the yes.
     */
    fun needsDisclosureConsent(isPlayBuild: Boolean, settings: BackupSettings): Boolean =
        isPlayBuild && settings.disclosureAcceptedVersion < DISCLOSURE_VERSION

    /* ------------------------------ wording ------------------------------ */

    /** A device name the PC can use as a folder name. */
    fun deviceFolderName(manufacturer: String?, model: String?): String {
        val m = model.orEmpty().trim()
        val maker = manufacturer.orEmpty().trim()
        val raw = when {
            m.isEmpty() -> maker
            maker.isEmpty() || m.startsWith(maker, ignoreCase = true) -> m
            else -> "${maker.replaceFirstChar { it.uppercase() }} $m"
        }
        return raw.replace(Regex("""[\\/:*?"<>| -]"""), "_").trim().trim('.').take(60).ifBlank { "Phone" }
    }

    /** "Just now", "5 minutes ago", "3 hours ago", "2 days ago", or null when never. */
    fun ago(thenMs: Long, nowMs: Long): String? {
        if (thenMs <= 0) return null
        val mins = ((nowMs - thenMs).coerceAtLeast(0)) / 60_000
        return when {
            mins < 1 -> "just now"
            mins < 60 -> if (mins == 1L) "1 minute ago" else "$mins minutes ago"
            mins < 48 * 60 -> (mins / 60).let { if (it == 1L) "1 hour ago" else "$it hours ago" }
            else -> "${mins / (24 * 60)} days ago"
        }
    }

    fun statusLine(state: BackupState, settings: BackupSettings, nowMs: Long): String {
        val last = ago(state.lastBackupAtMs, nowMs)?.let { "Last backed up $it" } ?: "Not backed up yet"
        return when {
            !settings.enabled -> "Photo backup is off"
            state.stopMessage != null -> state.stopMessage
            settings.paused -> "Paused · $last"
            state.running && state.total > 0 -> "Backing up ${state.done + 1} of ${state.total}"
            state.waitingFor != null -> "Waiting for ${state.waitingFor} · $last"
            state.pending > 0 -> "${state.pending} waiting · $last"
            else -> "Up to date · $last"
        }
    }
}

/** What the backup worker last reported, for the settings screen. */
@Serializable
data class BackupState(
    val running: Boolean = false,
    val done: Int = 0,
    val total: Int = 0,
    val currentName: String? = null,
    val currentProgress: Float = 0f,
    val pending: Int = 0,
    val lastBackupAtMs: Long = 0,
    val lastRunAtMs: Long = 0,
    val backedUpCount: Int = 0,
    val waitingFor: String? = null,
    val stopMessage: String? = null,
)
