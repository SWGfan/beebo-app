package com.beeboentertainment.movie.voice

import android.content.ContentValues
import android.content.Context
import android.media.tv.TvContract
import android.os.Build
import android.util.Log
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.core.WatchNextPlanner
import com.beeboentertainment.movie.ui.tv.TvDevice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Keeps the Android TV / Google TV home screen's "Continue watching" (Watch Next) row in step with
 * this viewer's Continue list on the home computer. TVs only, Android 8+, using the platform
 * TvContract directly (no extra library). What to change is decided by [WatchNextPlanner].
 *
 * Called when the app opens on a TV and whenever playback pauses or stops.
 */
object WatchNextSync {
    private const val TAG = "WatchNextSync"
    private const val MIN_INTERVAL_MS = 20_000L
    private val lock = Mutex()
    @Volatile private var lastRun = 0L

    fun supported(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && runCatching { TvDevice.isTv(context) }.getOrDefault(false)

    suspend fun refresh(context: Context, force: Boolean = false) {
        if (!supported(context)) return
        val now = System.currentTimeMillis()
        if (!force && now - lastRun < MIN_INTERVAL_MS) return
        lastRun = now
        withContext(Dispatchers.IO) {
            lock.withLock {
                runCatching { sync(context.applicationContext) }.onFailure { Log.w(TAG, "Watch Next update failed", it) }
            }
        }
    }

    private suspend fun sync(context: Context) {
        val app = BeeboApp.instance
        if (!app.session.isLoggedIn) {
            clear(context)
            return
        }
        val items = app.api.continueWatching().items.map {
            WatchNextPlanner.Item(
                id = it.id, kind = it.kind, title = it.title,
                positionSeconds = it.currentTime, durationSeconds = it.duration,
                upNext = it.upNext, poster = UrlUtils.join(app.session.baseUrl, it.poster)
            )
        }
        val plan = WatchNextPlanner.plan(items, existing(context), System.currentTimeMillis())
        if (plan.isEmpty) return
        val resolver = context.contentResolver
        plan.delete.forEach { id -> resolver.delete(TvContract.buildWatchNextProgramUri(id), null, null) }
        plan.update.forEach { (id, p) -> resolver.update(TvContract.buildWatchNextProgramUri(id), values(context, p), null, null) }
        plan.insert.forEach { p -> resolver.insert(TvContract.WatchNextPrograms.CONTENT_URI, values(context, p)) }
    }

    private fun existing(context: Context): List<WatchNextPlanner.Existing> {
        val out = mutableListOf<WatchNextPlanner.Existing>()
        val proj = arrayOf(
            TvContract.WatchNextPrograms._ID,
            TvContract.WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID,
            TvContract.WatchNextPrograms.COLUMN_LAST_PLAYBACK_POSITION_MILLIS,
            TvContract.WatchNextPrograms.COLUMN_TITLE,
            TvContract.WatchNextPrograms.COLUMN_WATCH_NEXT_TYPE,
            TvContract.WatchNextPrograms.COLUMN_BROWSABLE
        )
        context.contentResolver.query(TvContract.WatchNextPrograms.CONTENT_URI, proj, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val internal = c.getString(1) ?: continue
                out += WatchNextPlanner.Existing(
                    programId = c.getLong(0),
                    internalId = internal,
                    positionMs = c.getLong(2),
                    title = c.getString(3) ?: "",
                    type = if (c.getInt(4) == TvContract.WatchNextPrograms.WATCH_NEXT_TYPE_NEXT) WatchNextPlanner.Type.NEXT else WatchNextPlanner.Type.CONTINUE,
                    browsable = c.getInt(5) != 0
                )
            }
        }
        return out
    }

    private fun values(context: Context, p: WatchNextPlanner.Program): ContentValues = ContentValues().apply {
        val (kind, id) = p.internalId.split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        put(TvContract.WatchNextPrograms.COLUMN_TYPE, if (kind == "tv") TvContract.WatchNextPrograms.TYPE_TV_EPISODE else TvContract.WatchNextPrograms.TYPE_MOVIE)
        put(TvContract.WatchNextPrograms.COLUMN_WATCH_NEXT_TYPE,
            if (p.type == WatchNextPlanner.Type.NEXT) TvContract.WatchNextPrograms.WATCH_NEXT_TYPE_NEXT else TvContract.WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE)
        put(TvContract.WatchNextPrograms.COLUMN_TITLE, p.title)
        put(TvContract.WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID, p.internalId)
        put(TvContract.WatchNextPrograms.COLUMN_LAST_PLAYBACK_POSITION_MILLIS, p.positionMs.toInt())
        if (p.durationMs > 0) put(TvContract.WatchNextPrograms.COLUMN_DURATION_MILLIS, p.durationMs.toInt())
        put(TvContract.WatchNextPrograms.COLUMN_LAST_ENGAGEMENT_TIME_UTC_MILLIS, p.lastEngagementMs)
        p.poster?.let {
            put(TvContract.WatchNextPrograms.COLUMN_POSTER_ART_URI, it)
            put(TvContract.WatchNextPrograms.COLUMN_POSTER_ART_ASPECT_RATIO, TvContract.WatchNextPrograms.ASPECT_RATIO_2_3)
        }
        put(TvContract.WatchNextPrograms.COLUMN_INTENT_URI,
            android.content.Intent(android.content.Intent.ACTION_VIEW, VoiceSearchActivity.deepLink(VoiceSearchActivity.HOST_PLAY, kind, id))
                .setPackage(context.packageName)
                .toUri(android.content.Intent.URI_INTENT_SCHEME))
    }

    private fun clear(context: Context) {
        existing(context).forEach { context.contentResolver.delete(TvContract.buildWatchNextProgramUri(it.programId), null, null) }
    }

}
