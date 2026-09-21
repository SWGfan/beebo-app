package com.beeboentertainment.movie.photos

import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest

/**
 * Sends one file to the PC in chunks and recovers from everything a phone connection does: drops,
 * a chunk damaged on the way, the PC restarting, the app being killed mid-file (the next run's
 * `begin` returns the offset the PC already has) and old tunnel hosts that only take small bodies.
 *
 * Pure JVM: the network is a [Transport] and the file is an [open] function, so the whole state
 * machine is unit tested with a fake PC.
 */
class PhotoUploader(
    private val transport: Transport,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    private val shouldStop: () -> Boolean = { false },
    private val onProgress: (sent: Long, size: Long) -> Unit = { _, _ -> },
    /** How a server answer is read. Trip sharing reuses this whole transfer with its own wording. */
    private val stepFor: (httpCode: Int, error: String?, serverOffset: Long?) -> PhotoBackupLogic.Step =
        { code, error, offset -> PhotoBackupLogic.stepFor(code, error, offset) },
) {
    interface Transport {
        fun begin(device: String, name: String, size: Long, sha256: String, takenAt: Long): PhotoBackupClient.Reply
        fun chunk(uploadId: String, offset: Long, bytes: ByteArray, length: Int, sha256: String): PhotoBackupClient.Reply
        fun finish(uploadId: String): PhotoBackupClient.Reply
    }

    data class Item(val device: String, val name: String, val size: Long, val sha256: String, val takenAt: Long)

    sealed class Outcome {
        data class Saved(val path: String?, val duplicate: Boolean) : Outcome()
        /** This file cannot go right now; count an attempt and move to the next one. */
        data class Skipped(val reason: String) : Outcome()
        /** Stop the whole run (signed out, not allowed, PC disk full ...). */
        data class Stopped(val message: String, val signedOut: Boolean) : Outcome()
        /** Network trouble or the worker is being stopped: try again on the next run. */
        object Interrupted : Outcome()
    }

    companion object {
        const val SMALL_CHUNK = 24 * 1024
        const val MAX_NETWORK_RETRIES = 4
        const val MAX_RESTARTS = 2
        const val MAX_DAMAGED_CHUNKS = 5

        fun sha256Hex(bytes: ByteArray, length: Int = bytes.size): String {
            val md = MessageDigest.getInstance("SHA-256")
            md.update(bytes, 0, length)
            return md.digest().joinToString("") { "%02x".format(it) }
        }

        fun sha256Hex(stream: InputStream): String {
            val md = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(1 shl 16)
            while (true) {
                val n = stream.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }

    /** [open] returns a fresh stream of the file positioned at byte 0. */
    fun upload(item: Item, open: () -> InputStream): Outcome {
        var chunkBytes = PhotoBackupLogic.CHUNK_BYTES
        var networkRetries = 0
        var restarts = 0
        var damaged = 0

        fun retry(): Boolean {
            networkRetries++
            if (networkRetries > MAX_NETWORK_RETRIES || shouldStop()) return false
            sleep(PhotoBackupLogic.retryDelayMs(networkRetries))
            return true
        }

        session@ while (true) {
            if (shouldStop()) return Outcome.Interrupted
            val begun = try {
                transport.begin(item.device, item.name, item.size, item.sha256, item.takenAt)
            } catch (e: IOException) {
                if (retry()) continue@session else return Outcome.Interrupted
            }
            if (begun.code in 200..299 && begun.body.status == "done") return Outcome.Saved(begun.body.path, duplicate = true)
            val uploadId = begun.body.uploadId
            if (begun.code !in 200..299 || uploadId == null || begun.body.offset == null) {
                when (val s = stepFor(begun.code, begun.body.error, begun.body.offset)) {
                    is PhotoBackupLogic.Step.Stop -> return Outcome.Stopped(s.message, s.signedOut)
                    is PhotoBackupLogic.Step.SkipFile -> return Outcome.Skipped(s.reason)
                    else -> if (retry()) continue@session else return Outcome.Interrupted
                }
            }
            begun.body.chunkSize?.let { if (it in SMALL_CHUNK..PhotoBackupLogic.CHUNK_BYTES && chunkBytes > SMALL_CHUNK) chunkBytes = it }
            var offset: Long = begun.body.offset

            var stream: InputStream? = null
            var streamAt = -1L
            val buffer = ByteArray(PhotoBackupLogic.CHUNK_BYTES)
            try {
                transfer@ while (true) {
                    // Send every remaining chunk.
                    while (offset < item.size) {
                        if (shouldStop()) return Outcome.Interrupted
                        val range = PhotoBackupLogic.nextChunk(offset, item.size, chunkBytes) ?: break
                        val want = (range.last - range.first + 1).toInt().coerceAtMost(chunkBytes)
                        if (stream == null || streamAt != offset) {
                            stream?.close()
                            stream = open()
                            skipFully(stream, offset)
                            streamAt = offset
                        }
                        val got = readFully(stream, buffer, want)
                        streamAt += got
                        if (got <= 0) return Outcome.Skipped("the file got shorter while backing up")
                        val reply = try {
                            transport.chunk(uploadId, offset, buffer, got, sha256Hex(buffer, got))
                        } catch (e: PhotoBackupClient.TooLargeForTunnel) {
                            if (chunkBytes == SMALL_CHUNK) return Outcome.Skipped("connection refused small chunks")
                            chunkBytes = SMALL_CHUNK
                            streamAt = -1
                            continue
                        } catch (e: IOException) {
                            streamAt = -1
                            if (retry()) continue@session else return Outcome.Interrupted
                        }
                        when (val s = stepFor(reply.code, reply.body.error, reply.body.offset)) {
                            is PhotoBackupLogic.Step.Continue -> {
                                if (reply.code == 422 && ++damaged > MAX_DAMAGED_CHUNKS) return Outcome.Skipped("chunks keep arriving damaged")
                                if (s.offset != offset + got) streamAt = -1 // resync with what the PC has
                                offset = s.offset
                                networkRetries = 0
                                onProgress(offset, item.size)
                            }
                            is PhotoBackupLogic.Step.Restart -> { if (++restarts > MAX_RESTARTS) return Outcome.Skipped("upload kept restarting"); continue@session }
                            is PhotoBackupLogic.Step.Stop -> return Outcome.Stopped(s.message, s.signedOut)
                            is PhotoBackupLogic.Step.SkipFile -> return Outcome.Skipped(s.reason)
                            else -> { streamAt = -1; if (retry()) continue@session else return Outcome.Interrupted }
                        }
                    }
                    // All bytes are on the PC: ask it to check the whole file and save it.
                    val done = try { transport.finish(uploadId) } catch (e: IOException) {
                        if (retry()) continue@session else return Outcome.Interrupted
                    }
                    if (done.code in 200..299) return Outcome.Saved(done.body.path, done.body.duplicate)
                    when (val s = stepFor(done.code, done.body.error, done.body.offset)) {
                        is PhotoBackupLogic.Step.Continue -> { offset = s.offset; streamAt = -1; continue@transfer }
                        // The PC's hash of what arrived differs from the phone's: the file changed
                        // while it was being sent (or was damaged). Hash it again next run.
                        is PhotoBackupLogic.Step.Restart -> return Outcome.Skipped("checksum_mismatch")
                        is PhotoBackupLogic.Step.Stop -> return Outcome.Stopped(s.message, s.signedOut)
                        is PhotoBackupLogic.Step.SkipFile -> return Outcome.Skipped(s.reason)
                        else -> if (retry()) continue@session else return Outcome.Interrupted
                    }
                }
            } finally {
                runCatching { stream?.close() }
            }
        }
    }

    private fun skipFully(stream: InputStream, count: Long) {
        var left = count
        while (left > 0) {
            val n = stream.skip(left)
            if (n <= 0) {
                if (stream.read() < 0) throw IOException("file ended early")
                left--
            } else left -= n
        }
    }

    private fun readFully(stream: InputStream, buf: ByteArray, want: Int): Int {
        var total = 0
        while (total < want) {
            val n = stream.read(buf, total, want - total)
            if (n < 0) break
            total += n
        }
        return total
    }
}
