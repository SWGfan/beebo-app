package com.beeboentertainment.auto.media

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import com.beeboentertainment.auto.data.Http
import com.beeboentertainment.auto.data.Prefs
import com.beeboentertainment.auto.remote.AutoRemote
import okhttp3.Request
import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.ConcurrentHashMap

/**
 * Serves posters to Android Auto as content:// URIs.
 *
 * This exists because browse-row artwork must be a local content:// or
 * android.resource:// URI — the car will not fetch an http(s) URL and Media3
 * passes artworkUri straight through without loading it. Setting a BitmapLoader
 * on the session does not help here; it only affects now-playing artwork.
 *
 * Beebo Entertainment's poster endpoints are public (no Authorization header needed) and
 * already send `Cache-Control: public, max-age=604800`, but they still have to
 * come through a provider to be usable in the browse tree.
 */
class ArtworkProvider : ContentProvider() {

    /** serverPath -> when fetching it last failed. */
    private val failures = ConcurrentHashMap<String, Long>()

    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String = "image/jpeg"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val ctx = context ?: throw FileNotFoundException("no context")

        // The provider has to be exported for the car to read it, so who is
        // asking is checked here. A null caller is this app's own process,
        // which is how the now-playing bitmap loader arrives.
        val caller = callingPackage
        if (caller != null && caller != ctx.packageName && caller !in CAR_PACKAGES) {
            Log.w(TAG, "refusing artwork request from $caller")
            throw FileNotFoundException("not allowed")
        }

        val encoded = uri.lastPathSegment ?: throw FileNotFoundException("no path")
        val serverPath = ArtworkUris.decode(encoded)
            ?: throw FileNotFoundException("bad artwork id")
        if (!ArtworkUris.isArtworkPath(serverPath)) {
            Log.w(TAG, "refusing non-artwork path")
            throw FileNotFoundException("not an artwork path")
        }

        val prefs = Prefs.get(ctx)
        val base = prefs.baseUrl
        if (base.isBlank()) throw FileNotFoundException("no server configured")

        val cacheDir = File(ctx.cacheDir, "artwork").apply { mkdirs() }
        val cached = File(cacheDir, ArtworkUris.cacheKey(serverPath) + ".jpg")

        if (!cached.exists() || cached.length() == 0L) {
            // Without this the car re-asks for every poster the server does not
            // have on every single browse, and each miss costs a binder thread.
            val failedAt = failures[serverPath]
            if (failedAt != null && SystemClock.elapsedRealtime() - failedAt < NEGATIVE_TTL_MS) {
                throw FileNotFoundException("recently unavailable")
            }
            // Away from home, a poster asked for while the tunnel is still opening would park a
            // binder thread for as long as connecting takes. Say "not now" (not cached as a
            // failure) and let the car ask again once it is open; this also starts it opening.
            if (AutoRemote.wouldWaitForTunnel(base + serverPath)) {
                throw FileNotFoundException("connecting to the home computer")
            }
            fetch(base + serverPath, cacheDir, cached, serverPath)
            failures.remove(serverPath)
        }

        return ParcelFileDescriptor.open(cached, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    private fun fetch(
        url: String,
        cacheDir: File,
        cached: File,
        serverPath: String,
    ) {
        var tmp: File? = null
        try {
            val req = Request.Builder().url(url).get().build()
            Http.artworkClient().newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) throw FileNotFoundException("HTTP ${resp.code}")
                val body = resp.body ?: throw FileNotFoundException("empty body")
                // Written to a sibling temp file and renamed, so a concurrent
                // openFile either sees no cache entry or a complete one, never
                // a half-written JPEG.
                val t = File.createTempFile("art", null, cacheDir).also { tmp = it }
                t.outputStream().use { out -> body.byteStream().copyTo(out) }
                if (!t.renameTo(cached)) throw FileNotFoundException("could not cache poster")
                tmp = null
            }
        } catch (e: Exception) {
            failures[serverPath] = SystemClock.elapsedRealtime()
            Log.w(TAG, "artwork fetch failed", e)
            throw FileNotFoundException("fetch failed: ${e.message}")
        } finally {
            tmp?.delete()
        }
    }

    override fun query(
        uri: Uri, projection: Array<out String>?, selection: String?,
        selectionArgs: Array<out String>?, sortOrder: String?,
    ): Cursor? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun update(
        uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?,
    ): Int = 0
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    private companion object {
        const val TAG = "ArtworkProvider"
        const val NEGATIVE_TTL_MS = 60_000L
        val CAR_PACKAGES = setOf(
            "com.google.android.projection.gearhead",
            "com.android.car.media",
            "com.android.car.carlauncher",
        )
    }
}
