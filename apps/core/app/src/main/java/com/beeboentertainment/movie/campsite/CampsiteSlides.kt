package com.beeboentertainment.movie.campsite

import kotlinx.serialization.json.*
import java.io.File
import java.io.InputStream
import java.util.UUID

/** One local, temporary presentation. Authority and the playback clock live on the host phone. */
internal class CampsiteSlides(root: File, private val now: () -> Long = System::currentTimeMillis) {
    data class Reply(val status: Int, val body: JsonObject)
    data class Media(val id: String, val name: String, val mime: String, val file: File)
    private val directory = File(root, UUID.randomUUID().toString()).also { require(it.mkdirs()) }
    private val media = mutableListOf<Media>()
    private val pending = mutableMapOf<String, Long>()
    private var owner: String? = null
    private var ownerName = ""
    private var generation = UUID.randomUUID().toString()
    private var revision = 0L
    private var touched = 0L
    private var index = 0
    private var position = 0.0
    private var anchor = now()
    private var playing = false
    private var closed = false

    private fun error(status: Int, message: String) = Reply(status, buildJsonObject { put("ok", false); put("error", message) })
    private fun currentPosition() = (position + if (playing) (now() - anchor).coerceAtLeast(0L) / 1000.0 else 0.0).coerceIn(0.0, 86400.0)
    private fun clear() {
        media.forEach { it.file.delete() }; media.clear()
        owner = null; ownerName = ""; generation = UUID.randomUUID().toString()
        playing = false; position = 0.0; index = 0; revision++
    }
    private fun expire() { if (owner != null && now() - touched > 120_000) clear() }

    @Synchronized fun handle(token: String?, name: String?, host: Boolean, body: JsonObject? = null): Reply {
        if (closed) return error(410, "Campsite sharing has stopped.")
        if (token.isNullOrBlank() || name.isNullOrBlank()) return error(401, "Join the campsite first.")
        expire()
        if (owner == token) touched = now()
        val action = body?.get("action")?.jsonPrimitive?.contentOrNull
        if (action == "claim") {
            if (owner != null && owner != token) return error(409, "$ownerName is presenting. Ask them to finish first.")
            if (owner == null) { owner = token; ownerName = name.take(24); touched = now(); revision++ }
        } else if (action == "stop" && host) {
            clear()
        } else if (body != null) {
            if (owner != token) return error(403, "Only the presenter can change the shared view.")
            if (body["generation"]?.jsonPrimitive?.contentOrNull != generation) return error(409, "The presentation changed. Refresh and try again.")
            when (action) {
                "release" -> clear()
                "select" -> {
                    val next = body["index"]?.jsonPrimitive?.intOrNull
                    if (next == null || next !in media.indices) return error(400, "Choose a shared photo or video.")
                    index = next; position = 0.0; anchor = now(); playing = false; revision++
                }
                "playback" -> {
                    if (media.getOrNull(index)?.mime?.startsWith("video/") != true) return error(400, "Select a video first.")
                    if (body["mediaId"]?.jsonPrimitive?.contentOrNull != media[index].id) return error(409, "The selected video changed.")
                    val seconds = body["position"]?.jsonPrimitive?.doubleOrNull
                    val play = body["playing"]?.jsonPrimitive?.booleanOrNull
                    if (seconds == null || !seconds.isFinite() || seconds !in 0.0..86400.0 || play == null) return error(400, "Invalid video position.")
                    position = seconds; anchor = now(); playing = play; revision++
                }
                else -> return error(400, "Unknown presentation action.")
            }
        }
        return snapshot(token, host)
    }

    @Synchronized private fun snapshot(token: String, host: Boolean) = Reply(200, buildJsonObject {
        put("ok", true); put("generation", generation); put("revision", revision)
        put("presenter", ownerName); put("mine", owner == token); put("host", host)
        put("index", index); put("playing", playing); put("position", currentPosition()); put("serverTime", now())
        put("items", buildJsonArray { media.forEach { m -> add(buildJsonObject {
            put("id", m.id); put("name", m.name); put("type", if (m.mime.startsWith("video/")) "video" else "photo")
            put("url", "/slides/file?id=${m.id}")
        }) } })
    })

    /** Streams directly to disk, with a reservation so concurrent uploads cannot exceed the limit. */
    fun upload(token: String?, name: String?, expectedGeneration: String, mime: String, length: Long, input: InputStream): Reply {
        val extension = TYPES[mime] ?: return error(415, "Use JPEG, PNG, GIF, WebP, MP4, MOV or WebM.")
        val limit = if (mime.startsWith("video/")) 150L * MIB else 20L * MIB
        if (length !in 12..limit) return error(413, "Photos can be up to 20 MB and videos up to 150 MB.")
        val id = UUID.randomUUID().toString()
        val file = File(directory, "$id.$extension")
        synchronized(this) {
            expire()
            if (closed || token == null || owner != token || generation != expectedGeneration) return error(403, "Take your turn presenting before adding files.")
            if (media.size + pending.size >= 25 || media.sumOf { it.file.length() } + pending.values.sum() + length > 500L * MIB)
                return error(413, "Share up to 25 files and 500 MB per turn. Finish sharing to start a fresh selection.")
            pending[id] = length; touched = now()
        }
        try {
            val prefix = ByteArray(12)
            var read = 0
            while (read < prefix.size) { val n = input.read(prefix, read, prefix.size - read); if (n <= 0) throw java.io.EOFException(); read += n }
            if (!validHeader(mime, prefix)) return error(415, "That file does not match its photo or video format.")
            file.outputStream().use { out ->
                out.write(prefix)
                val buffer = ByteArray(64 * 1024)
                var left = length - prefix.size
                while (left > 0) {
                    val n = input.read(buffer, 0, minOf(left, buffer.size.toLong()).toInt())
                    if (n <= 0) throw java.io.EOFException()
                    out.write(buffer, 0, n); left -= n
                    synchronized(this) { if (closed || generation != expectedGeneration || owner != token) throw java.io.IOException("Sharing ended") ; touched = now() }
                }
            }
            synchronized(this) {
                if (closed || owner != token || generation != expectedGeneration) return error(409, "Sharing ended while the file was being added.")
                val label = name.orEmpty().map { if (it.isISOControl() || it == '/' || it.code == 92) ' ' else it }.joinToString("").trim().take(100).ifBlank { if (mime.startsWith("video/")) "Video" else "Photo" }
                media.add(Media(id, label, mime, file)); revision++; touched = now()
                return snapshot(token!!, false)
            }
        } catch (_: Exception) {
            return error(400, "The upload was interrupted. Keep both phones connected and try again.")
        } finally {
            synchronized(this) {
                pending.remove(id)
                if (media.none { it.id == id }) file.delete()
                if (closed) directory.delete()
            }
        }
    }

    @Synchronized fun file(id: String): Media? { expire(); return if (closed) null else media.firstOrNull { it.id == id } }
    @Synchronized fun close() { closed = true; clear(); directory.delete() }

    companion object {
        private const val MIB = 1024L * 1024
        private val TYPES = mapOf("image/jpeg" to "jpg", "image/png" to "png", "image/gif" to "gif", "image/webp" to "webp", "video/mp4" to "mp4", "video/quicktime" to "mov", "video/webm" to "webm")
        private fun validHeader(mime: String, b: ByteArray): Boolean {
            fun ascii(start: Int, end: Int) = b.copyOfRange(start, end).toString(Charsets.US_ASCII)
            return when (mime) {
                "image/jpeg" -> b[0] == 0xff.toByte() && b[1] == 0xd8.toByte() && b[2] == 0xff.toByte()
                "image/png" -> b.take(8) == listOf(137,80,78,71,13,10,26,10).map { it.toByte() }
                "image/gif" -> ascii(0,6) in listOf("GIF87a", "GIF89a")
                "image/webp" -> ascii(0,4) == "RIFF" && ascii(8,12) == "WEBP"
                "video/mp4", "video/quicktime" -> ascii(4,8) == "ftyp"
                "video/webm" -> b.take(4) == listOf(26,69,223,163).map { it.toByte() }
                else -> false
            }
        }
    }
}
