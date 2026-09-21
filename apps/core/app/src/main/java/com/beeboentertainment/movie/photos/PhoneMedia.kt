package com.beeboentertainment.movie.photos

import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat

/**
 * Read-only access to the phone's photos and videos through MediaStore. Only queries and
 * openInputStream are used: nothing here can delete, move or edit anything on the phone.
 */
object PhoneMedia {

    data class Album(val name: String, val count: Int)

    fun access(context: Context, includeVideos: Boolean = true): PhotoBackupLogic.MediaAccess =
        PhotoBackupLogic.access(Build.VERSION.SDK_INT, { p ->
            ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED
        }, includeVideos)

    fun scan(context: Context, includeVideos: Boolean): List<MediaCandidate> {
        val out = ArrayList<MediaCandidate>()
        query(context, images = true, out)
        if (includeVideos) query(context, images = false, out)
        return out
    }

    /** Albums (buckets) with how many photos and videos each holds, biggest first. */
    fun albums(context: Context): List<Album> = scan(context, includeVideos = true)
        .groupingBy { it.bucketName.ifBlank { "Other" } }.eachCount()
        .map { (name, count) -> Album(name, count) }
        .sortedWith(compareByDescending<Album> { PhotoBackupLogic.albumSelected(it.name, setOf(BackupSettings.CAMERA_ALBUM)) }.thenByDescending { it.count })

    private fun query(context: Context, images: Boolean, out: MutableList<MediaCandidate>) {
        val collection: Uri = if (images) {
            if (Build.VERSION.SDK_INT >= 29) MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL) else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        } else {
            if (Build.VERSION.SDK_INT >= 29) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL) else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        }
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_ADDED,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.MIME_TYPE,
            "datetaken",
            "bucket_display_name",
        )
        // Pending (still being written) and trashed items are not backed up until they are final.
        val selection = if (Build.VERSION.SDK_INT >= 29) "${MediaStore.MediaColumns.IS_PENDING} = 0" else null
        runCatching {
            context.contentResolver.query(collection, projection, selection, null, "${MediaStore.MediaColumns.DATE_ADDED} DESC")?.use { c ->
                val iId = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val iName = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                val iSize = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                val iAdded = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
                val iMod = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
                val iMime = c.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
                val iTaken = c.getColumnIndex("datetaken")
                val iBucket = c.getColumnIndex("bucket_display_name")
                while (c.moveToNext()) {
                    val id = c.getLong(iId)
                    out += MediaCandidate(
                        id = id,
                        uri = ContentUris.withAppendedId(collection, id).toString(),
                        name = c.getString(iName) ?: "photo_$id",
                        size = c.getLong(iSize),
                        isVideo = !images,
                        dateTakenMs = if (iTaken >= 0) c.getLong(iTaken) else 0L,
                        dateAddedSec = c.getLong(iAdded),
                        dateModifiedSec = c.getLong(iMod),
                        bucketName = if (iBucket >= 0) c.getString(iBucket).orEmpty() else "",
                        mimeType = c.getString(iMime).orEmpty(),
                    )
                }
            }
        }
    }
}
