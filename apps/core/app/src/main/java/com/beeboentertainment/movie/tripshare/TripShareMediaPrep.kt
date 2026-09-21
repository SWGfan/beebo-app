package com.beeboentertainment.movie.tripshare

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import com.beeboentertainment.movie.photos.PhotoUploader
import com.beeboentertainment.movie.trip.Mp4LocationStripper
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Getting the person's picked files ready to send. Everything is read from the addresses the system
 * picker handed back (no storage permission, no listing of the gallery) and written to this app's own
 * cache folder, which is wiped when the link is made.
 *
 *  - Photos are decoded, turned upright, shrunk to at most [ShareDefaults.PHOTO_MAX_EDGE] and written as
 *    a fresh JPEG. That redraw carries no Exif, so no GPS, camera model or edit history leaves the phone.
 *  - Clips are copied as they are, then any location atom is blanked in the copy before it is sent.
 *  - A song is streamed from its own file and never copied.
 *
 * Needs a real phone (decoders, cache space, the picker's grants), so the arithmetic lives in
 * [TripSharePhotoMath] and the rules in [TripShareLogic], which are unit tested.
 */
internal object TripShareMediaPrep {

    data class Info(val name: String, val size: Long)

    fun workDir(context: Context, jobId: String): File = File(context.cacheDir, "trip-share/$jobId").apply { mkdirs() }

    /** Removes the whole cache for [jobId]. */
    fun clean(context: Context, jobId: String) {
        runCatching { File(context.cacheDir, "trip-share/$jobId").deleteRecursively() }
    }

    fun info(context: Context, uri: Uri): Info {
        var name = "file"
        var size = -1L
        runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    if (!c.isNull(0)) name = c.getString(0)
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        }
        return Info(name, size)
    }

    /** A photo redrawn to a small metadata-free JPEG at [out], or null if it cannot be read. */
    fun preparePhoto(context: Context, uri: Uri, out: File): PreparedFile? {
        if (out.isFile && out.length() > 0L) return describe(out, "photo.jpg", ShareKind.PHOTO, id = out.name)
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        runCatching { resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val orientation = runCatching {
            resolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
        }.getOrNull() ?: ExifInterface.ORIENTATION_NORMAL
        val decode = BitmapFactory.Options().apply {
            inSampleSize = TripSharePhotoMath.sampleSize(bounds.outWidth, bounds.outHeight, ShareDefaults.PHOTO_MAX_EDGE)
        }
        val decoded = runCatching { resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, decode) } }.getOrNull() ?: return null
        var made: Bitmap? = null
        var outW = 0
        var outH = 0
        try {
            val upright = TripSharePhotoMath.upright(orientation)
            val (uw, uh) = TripSharePhotoMath.uprightSize(decoded.width, decoded.height, upright)
            val (tw, th) = TripSharePhotoMath.scaledSize(uw, uh, ShareDefaults.PHOTO_MAX_EDGE)
            val matrix = Matrix().apply {
                if (upright.degrees != 0) postRotate(upright.degrees.toFloat())
                if (upright.flipHorizontal) postScale(-1f, 1f)
                postScale(tw.toFloat() / uw, th.toFloat() / uh)
            }
            val bmp = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
            made = bmp
            outW = bmp.width
            outH = bmp.height
            val tmp = File(out.parentFile, out.name + ".tmp")
            FileOutputStream(tmp).use { bmp.compress(Bitmap.CompressFormat.JPEG, ShareDefaults.PHOTO_QUALITY, it) }
            if (!tmp.renameTo(out)) { tmp.delete(); return null }
        } catch (e: Exception) {
            return null
        } finally {
            val m = made
            if (m != null && m !== decoded) m.recycle()
            decoded.recycle()
        }
        return describe(out, "photo.jpg", ShareKind.PHOTO, id = out.name, width = outW, height = outH)
    }

    /** A clip copied into the cache with location blanked, or null when there is not room or it cannot be read. */
    fun prepareVideo(context: Context, uri: Uri, out: File, maxBytes: Long): PreparedFile? {
        if (out.isFile && out.length() > 0L) return describe(out, "clip.mp4", ShareKind.VIDEO, id = out.name)
        val known = info(context, uri).size
        if (known > maxBytes) return null
        // Leave the phone some breathing room: a full cache breaks other things.
        if (known > 0 && context.cacheDir.usableSpace < known + 200L * 1024 * 1024) return null
        val tmp = File(out.parentFile, out.name + ".tmp")
        try {
            context.contentResolver.openInputStream(uri)?.use { input -> FileOutputStream(tmp).use { input.copyTo(it, 256 * 1024) } } ?: return null
            if (tmp.length() <= 0L || tmp.length() > maxBytes) { tmp.delete(); return null }
            Mp4LocationStripper.strip(tmp)
            if (!tmp.renameTo(out)) { tmp.delete(); return null }
        } catch (e: IOException) {
            tmp.delete()
            return null
        }
        return describe(out, "clip.mp4", ShareKind.VIDEO, id = out.name)
    }

    /** The song, read straight from the person's chosen file each time it is needed. */
    fun prepareSong(context: Context, uri: Uri, id: String): PreparedFile? {
        val info = info(context, uri)
        val open = { context.contentResolver.openInputStream(uri) ?: throw IOException("song unreadable") }
        val (size, sha) = runCatching {
            open().use { input ->
                var n = 0L
                val md = java.security.MessageDigest.getInstance("SHA-256")
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val r = input.read(buf)
                    if (r < 0) break
                    md.update(buf, 0, r); n += r
                }
                n to md.digest().joinToString("") { "%02x".format(it) }
            }
        }.getOrNull() ?: return null
        return PreparedFile(id, ShareKind.AUDIO, info.name, size, sha, open = open)
    }

    private fun describe(file: File, name: String, kind: ShareKind, id: String, width: Int = 0, height: Int = 0): PreparedFile? {
        val sha = runCatching { file.inputStream().use { PhotoUploader.sha256Hex(it) } }.getOrNull() ?: return null
        var w = width
        var h = height
        if (kind == ShareKind.PHOTO && (w == 0 || h == 0)) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            runCatching { BitmapFactory.decodeFile(file.path, bounds) }
            w = bounds.outWidth.coerceAtLeast(0); h = bounds.outHeight.coerceAtLeast(0)
        }
        return PreparedFile(id, kind, name, file.length(), sha, w, h) { file.inputStream() }
    }
}
