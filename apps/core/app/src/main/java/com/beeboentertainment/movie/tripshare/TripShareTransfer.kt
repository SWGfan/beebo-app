package com.beeboentertainment.movie.tripshare

import com.beeboentertainment.movie.photos.PhotoUploader
import java.io.IOException
import java.io.InputStream

/** A file that is ready to send: already redrawn (photos) and hashed, and able to be read again from byte 0. */
class PreparedFile(
    val id: String,
    val kind: ShareKind,
    val name: String,
    val sizeBytes: Long,
    val sha256: String,
    val width: Int = 0,
    val height: Int = 0,
    val open: () -> InputStream,
)

/** What the transfer needs from the network. The real one is [TripShareClient]; tests use a fake computer. */
interface TripSharePc {
    /** Which of [hashes] (with their sizes) the computer already holds for [tripId]. May throw [IOException]. */
    fun have(tripId: String, files: List<Pair<String, Long>>): Set<String>

    /** The begin / chunk / finish calls for one file. */
    fun transport(tripId: String, file: PreparedFile): PhotoUploader.Transport
}

sealed class TransferResult {
    /** Every file was sent or skipped. [onPc] is the set of hashes now safely on the computer. */
    data class Finished(val onPc: Set<String>, val skipped: List<SkippedFile>) : TransferResult()

    /** Stop for good: signed out, not allowed, storage full. */
    data class Stopped(val message: String, val signedOut: Boolean, val onPc: Set<String>) : TransferResult()

    /** Network trouble or the work was stopped: carry on next time from where it left off. */
    data class Interrupted(val onPc: Set<String>) : TransferResult()
}

/**
 * Sends a trip's files to the computer one after another, resuming and verifying every chunk with the
 * same code phone backup uses ([PhotoUploader]). Pure JVM: files come from [PreparedFile.open] and the
 * computer is a [TripSharePc], so the whole thing is unit tested with a fake.
 */
class TripShareTransfer(
    private val pc: TripSharePc,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    private val shouldStop: () -> Boolean = { false },
    /** (index of the file being sent, how many there are, bytes sent of it, its size). */
    private val onProgress: (index: Int, total: Int, sent: Long, size: Long) -> Unit = { _, _, _, _ -> },
) {
    fun run(tripId: String, files: List<PreparedFile>): TransferResult {
        val onPc = LinkedHashSet<String>()
        val skipped = ArrayList<SkippedFile>()
        val have = try {
            pc.have(tripId, files.map { it.sha256 to it.sizeBytes })
        } catch (e: IOException) {
            emptySet() // begin() will tell us anyway: a file the computer has answers "done"
        }
        for ((i, file) in files.withIndex()) {
            if (shouldStop()) return TransferResult.Interrupted(onPc)
            onProgress(i, files.size, 0L, file.sizeBytes)
            if (file.sha256 in have) { onPc += file.sha256; onProgress(i, files.size, file.sizeBytes, file.sizeBytes); continue }
            val uploader = PhotoUploader(
                pc.transport(tripId, file),
                sleep = sleep,
                shouldStop = shouldStop,
                onProgress = { sent, size -> onProgress(i, files.size, sent, size) },
                stepFor = { code, error, offset -> TripShareLogic.stepFor(code, error, offset) },
            )
            val item = PhotoUploader.Item(device = tripId, name = file.name, size = file.sizeBytes, sha256 = file.sha256, takenAt = 0L)
            val outcome = try {
                uploader.upload(item, file.open)
            } catch (e: IOException) {
                PhotoUploader.Outcome.Skipped(e.message ?: "unreadable")
            }
            when (outcome) {
                is PhotoUploader.Outcome.Saved -> onPc += file.sha256
                is PhotoUploader.Outcome.Skipped -> skipped += SkippedFile(file.id, file.name, outcome.reason)
                is PhotoUploader.Outcome.Stopped -> return TransferResult.Stopped(outcome.message, outcome.signedOut, onPc)
                PhotoUploader.Outcome.Interrupted -> return TransferResult.Interrupted(onPc)
            }
        }
        return TransferResult.Finished(onPc, skipped)
    }
}
