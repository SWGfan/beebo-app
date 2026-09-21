package com.beeboentertainment.movie.photos

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

/* Wire shapes of /api/photos/... (desktop electron/photosApi.js). Every field defaults. */

@Serializable
data class PhotoAccess(val view: Boolean = false, val backup: Boolean = false, val owner: Boolean = false)

@Serializable
data class PhotosStatus(val ok: Boolean = false, val access: PhotoAccess = PhotoAccess(), val backupFolder: String? = null)

@Serializable
data class PhotoLocation(val lat: Double = 0.0, val lon: Double = 0.0)

@Serializable
data class PhotoItem(
    val id: String = "",
    val name: String = "",
    val type: String = "photo",
    val size: Double = 0.0,
    val takenAt: Double = 0.0,
    val album: String = "",
    val albumName: String = "",
    val camera: String? = null,
    val location: PhotoLocation? = null,
) {
    val isVideo: Boolean get() = type == "video"
    val takenAtMs: Long get() = takenAt.toLong()
}

@Serializable
data class PhotoMonth(val key: String = "", val count: Int = 0)

@Serializable
data class PhotoTimeline(
    val ok: Boolean = false,
    val total: Int = 0,
    val items: List<PhotoItem> = emptyList(),
    val nextOffset: Int? = null,
    val months: List<PhotoMonth> = emptyList(),
)

@Serializable
data class PhotoAlbum(
    val id: String = "",
    val name: String = "",
    val path: String = "",
    val count: Int = 0,
    val photos: Int = 0,
    val videos: Int = 0,
    val coverId: String = "",
    val latest: Double = 0.0,
)

@Serializable
data class PhotoAlbums(val ok: Boolean = false, val albums: List<PhotoAlbum> = emptyList())

@Serializable
data class PhotoCast(
    val ok: Boolean = false,
    val type: String = "photo",
    val name: String = "",
    val contentType: String = "image/jpeg",
    val url: String = "",
    val poster: String = "",
)

@Serializable
data class BackupDevice(val device: String = "", val files: Int = 0, val bytes: Double = 0.0, val lastBackupAt: Double? = null, val mine: Boolean = false)

@Serializable
data class BackupSummary(val ok: Boolean = false, val device: BackupDevice? = null, val devices: List<BackupDevice> = emptyList())

class PhotosException(message: String, val code: Int = 0) : IOException(message)

/** Reading the PC's Photos library. Thumbnails and files load through Coil/ExoPlayer with the bearer header. */
class PhotosClient(
    private val session: SessionStore = BeeboApp.instance.session,
    private val http: OkHttpClient = BeeboApp.instance.api.okHttp,
) {
    fun thumbUrl(id: String): String = UrlUtils.endpoint(session.baseUrl, "/api/photos/thumb?id=$id") ?: ""
    fun viewUrl(id: String): String = UrlUtils.endpoint(session.baseUrl, "/api/photos/view?id=$id") ?: ""
    fun originalUrl(id: String): String = UrlUtils.endpoint(session.baseUrl, "/api/photos/original?id=$id") ?: ""
    fun absolute(path: String): String = UrlUtils.endpoint(session.baseUrl, path) ?: ""

    private suspend fun <T> get(path: String, serializer: KSerializer<T>): T = withContext(Dispatchers.IO) {
        val url = UrlUtils.endpoint(session.baseUrl, path) ?: throw PhotosException("No home computer address saved.")
        val token = session.token?.takeIf { it.isNotBlank() } ?: throw PhotosException("Sign in to see Photos.", 401)
        val req = Request.Builder().url(url).header("Authorization", "Bearer $token").header("Accept", "application/json").get().build()
        http.newCall(req).execute().use { r ->
            val text = r.body?.string().orEmpty()
            when (r.code) {
                in 200..299 -> runCatching { ApiClient.JSON.decodeFromString(serializer, text) }
                    .getOrElse { throw PhotosException("Unexpected answer from your home computer.") }
                401 -> throw PhotosException("Your sign-in expired. Sign in again.", 401)
                403 -> throw PhotosException("The owner of this Beebo hasn't shared Photos with you yet.", 403)
                404 -> throw PhotosException("Your home computer needs the latest Beebo for Photos.", 404)
                else -> throw PhotosException("Your home computer couldn't load Photos (HTTP ${r.code}).", r.code)
            }
        }
    }

    suspend fun status(): PhotosStatus = get("/api/photos/status", PhotosStatus.serializer())

    suspend fun timeline(offset: Int, album: String? = null, videosOnly: Boolean = false): PhotoTimeline =
        get(
            "/api/photos/timeline?limit=300&offset=$offset" +
                (album?.let { "&album=" + UrlUtils.encode(it) } ?: "") + (if (videosOnly) "&type=video" else ""),
            PhotoTimeline.serializer(),
        )

    suspend fun albums(): PhotoAlbums = get("/api/photos/albums", PhotoAlbums.serializer())

    suspend fun cast(id: String): PhotoCast = get("/api/photos/cast?id=$id", PhotoCast.serializer())

    suspend fun backupSummary(device: String): BackupSummary =
        get("/api/photos/backup/summary?device=" + UrlUtils.encode(device), BackupSummary.serializer())
}
