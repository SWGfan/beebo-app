package com.beeboentertainment.movie.downloads

import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * One HTTP attempt at a download: ask for the file (or the rest of it), check the reply is
 * really that file, write it to the .part, and verify what landed on disk. No Android in here, so
 * DownloadAttemptTest drives it against a real local HTTP server. The service around it decides
 * what a failure means (retry, pause, give up) and keeps the queue and the notification.
 */
class DownloadAttempt(
    private val client: OkHttpClient,
    /** Bytes free on the download volume (0 = unknown). */
    private val freeSpace: () -> Long,
    /** Called between reads; throw to stop the transfer (a stop, a pause, the network rule). */
    private val checkpoint: () -> Unit = {},
    /** Handed the live call so a stop can cancel the socket at once. */
    private val onCall: (Call) -> Unit = {},
    private val formatBytes: (Long) -> String = { "$it bytes" }
) {

    sealed class Result {
        /** Every promised byte is in the .part, synced to disk. */
        data class Finished(val total: Long, val validator: String?) : Result()
        /** The .part already held the whole file (the server said so with a 416). */
        data class AlreadyComplete(val total: Long) : Result()
        /** The media link no longer works: a 401, a bare 403, or a login page in place of the film. */
        data object LinkExpired : Result()
        /** The .part didn't belong to the file the server has now and was deleted: ask again from byte 0. */
        data object RestartFromZero : Result()
    }

    /** Where the body will start and how big the whole file is, once the reply is known to be usable. */
    fun interface Started {
        fun onStarted(startOffset: Long, total: Long, validator: String?)
    }

    fun run(
        url: String,
        part: File,
        storedValidator: String?,
        storedTotal: Long,
        totalHint: Long,
        started: Started = Started { _, _, _ -> },
        onProgress: (written: Long, total: Long) -> Unit = { _, _ -> }
    ): Result {
        val already = if (part.exists()) part.length() else 0L
        val builder = Request.Builder().url(url).get()
        ResumeRules.rangeHeader(already)?.let { builder.header("Range", it) }
        if (already > 0 && storedValidator != null) builder.header("If-Range", storedValidator)
        // Tells the home server this is a download, not playback: a library shared from another
        // household may have downloads turned off, and the server refuses these then.
        builder.header("X-Beebo-Download", "1")
        // A film is already compressed and a byte range is of the file as stored: never let a
        // proxy or OkHttp's transparent gzip touch it.
        builder.header("Accept-Encoding", "identity")

        val call = client.newCall(builder.build())
        onCall(call)
        return call.execute().use { r -> handle(r, part, already, storedValidator, storedTotal, totalHint, started, onProgress) }
    }

    private fun handle(
        r: Response,
        part: File,
        already: Long,
        storedValidator: String?,
        storedTotal: Long,
        totalHint: Long,
        started: Started,
        onProgress: (Long, Long) -> Unit
    ): Result {
        if (r.code == 401) return Result.LinkExpired
        if (r.code == 403) {
            val why = refusalMessage(r)
            if (why != null) throw DownloadFatalException(why)
            return Result.LinkExpired
        }
        if (r.code == 404) throw DownloadFatalException("This file is no longer on your home computer.")
        if (r.code != 416 && !r.isSuccessful) throw DownloadHttpException(r.code, "Server returned HTTP ${r.code}")

        val contentType = r.header("Content-Type")
        if (r.code != 416) {
            // A login page arrives as a polite 200 when the media link has expired.
            if (Integrity.looksLikeLoginPage(contentType)) return Result.LinkExpired
            if (!Integrity.looksLikeMedia(contentType)) {
                throw DownloadFatalException("Your home computer sent something that isn't a video. Open the title again and retry.")
            }
        }

        val body = r.body ?: throw IllegalStateException("Empty response body")
        val contentLength = body.contentLength()
        val reply = ResumeRules.Reply(r.code, contentLength, r.header("Content-Range"), r.header("ETag"), r.header("Last-Modified"))
        val startOffset: Long
        val total: Long
        when (val outcome = ResumeRules.interpret(already, storedValidator, storedTotal, reply)) {
            is ResumeRules.Outcome.AlreadyComplete -> return Result.AlreadyComplete(already)
            is ResumeRules.Outcome.DiscardAndAskAgain -> {
                part.delete()
                return Result.RestartFromZero
            }
            is ResumeRules.Outcome.Continue -> {
                startOffset = outcome.startOffset
                total = if (outcome.total > 0) outcome.total else storedTotal
            }
            is ResumeRules.Outcome.FromScratch -> {
                if (part.exists()) part.delete()
                startOffset = 0L
                total = if (outcome.total > 0) outcome.total else totalHint
            }
        }

        // Don't start filling the phone with something that can't fit.
        val needed = if (total > 0) total - startOffset else contentLength
        val free = freeSpace()
        if (SpaceGuard.tooFull(needed, free)) {
            throw DownloadFatalException("Not enough space: needs ${formatBytes(needed)}, ${formatBytes(free)} free")
        }

        val validator = ResumeRules.validatorOf(reply) ?: storedValidator
        started.onStarted(startOffset, total, validator)

        var written = startOffset
        RandomAccessFile(part, "rw").use { out ->
            out.setLength(startOffset)
            out.seek(startOffset)
            val buf = ByteArray(256 * 1024)
            body.byteStream().use { input ->
                while (true) {
                    checkpoint()
                    val n = input.read(buf)
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    written += n
                    onProgress(written, total)
                }
            }
            // Everything reaches the disk before the file is called finished.
            runCatching { out.fd.sync() }
        }

        when (val verdict = Integrity.verify(written, total, part.length())) {
            is Integrity.Verdict.Ok -> Unit
            is Integrity.Verdict.Short ->
                throw IOException("The connection ended ${formatBytes(verdict.missingBytes)} early")
            is Integrity.Verdict.Overrun -> {
                part.delete()
                throw IOException("The file changed on your computer while it was downloading")
            }
            is Integrity.Verdict.DiskMismatch ->
                throw IOException("Couldn't save the file to this phone")
        }
        return Result.Finished(if (total > 0) total else written, validator)
    }

    /** What the server said when it refused with 403 (a stopped stream, downloads off, a plan limit), or null if it said nothing. */
    private fun refusalMessage(r: Response): String? = runCatching {
        val text = r.peekBody(2_048).string().trim()
        if (text.isEmpty()) return@runCatching null
        val json = Regex("\"message\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(text)?.groupValues?.get(1)
        (json ?: text.takeIf { !it.startsWith("<") && !it.startsWith("{") })
            ?.replace("\\\"", "\"")?.replace("\\n", " ")?.take(240)?.takeIf { it.isNotBlank() }
    }.getOrNull()
}
