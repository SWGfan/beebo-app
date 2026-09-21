package com.beeboentertainment.movie.campsite

import java.io.File

/** Audio file naming and content types for the tracks the host phone serves to guests. */
internal object CampsiteMusicFiles {
    fun mimeFor(fileName: String): String = when (fileName.substringAfterLast('.', "").lowercase()) {
        "mp3" -> "audio/mpeg"
        "m4a", "mp4", "aac" -> "audio/mp4"
        "flac" -> "audio/flac"
        "ogg", "opus" -> "audio/ogg"
        "wav" -> "audio/wav"
        else -> "application/octet-stream"
    }

    /** File extension for a server response's Content-Type; null for anything that is not audio we know. */
    fun extensionFor(contentType: String?): String? = when (contentType?.substringBefore(';')?.trim()?.lowercase()) {
        "audio/mpeg", "audio/mp3" -> "mp3"
        "audio/mp4", "audio/x-m4a", "audio/aac", "audio/m4a" -> "m4a"
        "audio/flac", "audio/x-flac" -> "flac"
        "audio/ogg", "audio/opus" -> "ogg"
        "audio/wav", "audio/x-wav", "audio/wave" -> "wav"
        else -> null
    }
}

/**
 * The host phone's on-disk copy of the tracks it is playing together. A guest browser needs the
 * whole file (it decodes it into memory), so the host keeps the current track and the next couple
 * as plain files that [CampsiteServer] can serve with Range support, and forgets the rest.
 *
 * File names are `<trackId>.<ext>` with the id validated against [CampsiteMusicEngine.ID_PATTERN],
 * so a track id can never walk out of the folder. Downloads are written as `<id>.part` and renamed,
 * so a half-finished file is never served.
 */
internal class CampsiteMusicCache(
    private val directory: File,
    private val maxFiles: Int = 8,
    private val maxBytes: Long = 400L * 1024 * 1024,
) {
    init { directory.mkdirs() }

    /** The finished file for [trackId], or null. */
    fun fileFor(trackId: String): File? {
        if (!trackId.matches(CampsiteMusicEngine.ID_PATTERN)) return null
        return directory.listFiles()?.firstOrNull { it.isFile && !it.name.endsWith(PART) && it.nameWithoutExtension == trackId && it.length() > 0 }
    }

    /** Where a download of [trackId] should be written first. */
    fun partFor(trackId: String): File {
        require(trackId.matches(CampsiteMusicEngine.ID_PATTERN)) { "bad track id" }
        return File(directory, trackId + PART)
    }

    /** Move a finished download into place under its real extension. */
    fun commit(trackId: String, part: File, extension: String): File {
        require(trackId.matches(CampsiteMusicEngine.ID_PATTERN)) { "bad track id" }
        val target = File(directory, "$trackId.${extension.filter { it.isLetterOrDigit() }.take(5).ifBlank { "bin" }}")
        directory.listFiles()?.filter { it.nameWithoutExtension == trackId && it != part }?.forEach { it.delete() }
        if (!part.renameTo(target)) { part.copyTo(target, overwrite = true); part.delete() }
        return target
    }

    /**
     * Delete everything not in [keep], oldest first, until the folder fits its limits. Files in
     * [keep] are never deleted, even if that leaves the folder over budget (the current song wins).
     */
    fun trim(keep: Set<String>) {
        val files = directory.listFiles()?.filter { it.isFile } ?: return
        files.filter { it.name.endsWith(PART) && it.nameWithoutExtension !in keep }.forEach { it.delete() }
        val done = files.filter { !it.name.endsWith(PART) && it.exists() }.sortedBy { it.lastModified() }.toMutableList()
        var total = done.sumOf { it.length() }
        for (f in done.toList()) {
            if (done.size <= maxFiles && total <= maxBytes) break
            if (f.nameWithoutExtension in keep) continue
            total -= f.length(); done.remove(f); f.delete()
        }
    }

    fun clear() { directory.listFiles()?.forEach { it.delete() } }

    private companion object { const val PART = ".part" }
}
