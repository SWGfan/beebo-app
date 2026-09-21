package com.beeboentertainment.movie.trip

import android.content.Context
import android.content.Intent
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.MediaStore
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Reading the two date formats photo and video files use. Pure, so the zone is a parameter. */
internal object MediaDates {

    /** EXIF "yyyy:MM:dd HH:mm:ss", which is wall-clock time with no zone, so [zone] says where it was. */
    fun parseExif(text: String?, zone: TimeZone = TimeZone.getDefault()): Long {
        val raw = text?.trim().orEmpty()
        if (raw.length < 19) return 0L
        return parse("yyyy:MM:dd HH:mm:ss", raw.take(19), zone)
    }

    /** A video's creation date, "yyyyMMdd'T'HHmmss" then optional fraction and 'Z', always UTC. */
    fun parseBasicUtc(text: String?): Long {
        val raw = text?.trim().orEmpty()
        if (raw.length < 15) return 0L
        return parse("yyyyMMdd'T'HHmmss", raw.take(15), TimeZone.getTimeZone("UTC"))
    }

    private fun parse(pattern: String, text: String, zone: TimeZone): Long {
        val format = SimpleDateFormat(pattern, Locale.US).apply {
            timeZone = zone
            isLenient = false
        }
        val date = format.parse(text, ParsePosition(0)) ?: return 0L
        // Cameras with no clock write all zeros, which parses to nothing useful.
        return if (date.time <= 0L) 0L else date.time
    }
}

/**
 * What the system photo picker handed back for one photo or video, turned into a [TripMedia].
 *
 * The picker grants read access to exactly the items the person chose and needs no storage
 * permission, so this only ever asks about those addresses: it never lists or searches the
 * phone's media. Everything is best-effort; a missing date is simply "unknown".
 */
internal object TripMediaReader {

    fun read(context: Context, uri: Uri): TripMedia {
        val resolver = context.contentResolver
        val mime = runCatching { resolver.getType(uri) }.getOrNull().orEmpty()
        val video = mime.startsWith("video/")
        // Keeps the grant across a restart where the picker allows it; harmless where it does not.
        runCatching { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        return TripMedia(uri.toString(), video, takenAt(context, uri, video))
    }

    private fun takenAt(context: Context, uri: Uri, video: Boolean): Long {
        val fromProvider = runCatching {
            context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DATE_TAKEN), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else 0L
            } ?: 0L
        }.getOrDefault(0L)
        if (fromProvider > 0L) return fromProvider
        return if (video) videoDate(context, uri) else exifDate(context, uri)
    }

    private fun exifDate(context: Context, uri: Uri): Long = runCatching {
        context.contentResolver.openInputStream(uri)?.use { input ->
            val exif = ExifInterface(input)
            val original = MediaDates.parseExif(exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL))
            if (original > 0L) original else MediaDates.parseExif(exif.getAttribute(ExifInterface.TAG_DATETIME))
        } ?: 0L
    }.getOrDefault(0L)

    private fun videoDate(context: Context, uri: Uri): Long {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(context, uri)
            MediaDates.parseBasicUtc(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE))
        } catch (_: Exception) {
            0L
        } finally {
            runCatching { retriever.release() }
        }
    }

    /** A video's length in milliseconds, or null when it cannot be read. */
    fun videoDurationMs(context: Context, uri: Uri): Long? {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(context, uri)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        } catch (_: Exception) {
            null
        } finally {
            runCatching { retriever.release() }
        }
    }
}
