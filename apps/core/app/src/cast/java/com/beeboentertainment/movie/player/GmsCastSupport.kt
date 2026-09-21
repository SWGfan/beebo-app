package com.beeboentertainment.movie.player

import android.content.Context
import android.util.Log
import androidx.media3.cast.CastPlayer
import androidx.media3.cast.SessionAvailabilityListener
import androidx.media3.common.Player
import androidx.mediarouter.app.MediaRouteButton
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.framework.CastButtonFactory
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability

/**
 * The real Cast implementation, for the web and play builds (src/cast is a source directory both
 * flavours share; the amazon build has NoCastSupport instead).
 *
 * Cast is optional: plenty of devices (and any device without Play services) have no working
 * Cast stack. Every entry point here is null-safe so the rest of the app can simply skip the
 * Cast button when this reports unavailable, instead of crashing on startup.
 */
internal class GmsCastSupport : CastSupport {

    private var context: CastContext? = null
    private var attempted = false

    override fun playServicesAvailable(context: Context): Boolean = try {
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    } catch (t: Throwable) {
        false
    }

    /** Returns null when Cast is unavailable on this device. Safe to call from any thread-ish UI path. */
    private fun castContext(ctx: Context): CastContext? {
        if (context != null) return context
        if (attempted) return context
        attempted = true
        val why = CastAvailability.decide(castStackLinked = true, playServicesUsable = playServicesAvailable(ctx))
        if (why != CastAvailability.Available) {
            Log.i(TAG, "Cast disabled: $why")
            return null
        }
        context = try {
            CastContext.getSharedInstance(ctx.applicationContext)
        } catch (t: Throwable) {
            Log.w(TAG, "CastContext unavailable", t)
            null
        }
        return context
    }

    override fun isAvailable(context: Context): Boolean = castContext(context) != null

    override fun reset() { attempted = false }

    override fun setUpMediaRouteButton(context: Context, button: MediaRouteButton): Boolean =
        runCatching { CastButtonFactory.setUpMediaRouteButton(context.applicationContext, button) }
            .onFailure { Log.w(TAG, "Cast button setup failed", it) }
            .isSuccess

    override fun isSessionConnected(context: Context): Boolean =
        runCatching { castContext(context)?.sessionManager?.currentCastSession?.isConnected == true }
            .getOrDefault(false)

    override fun observeSession(context: Context, onActiveChanged: (Boolean) -> Unit): AutoCloseable? {
        val manager = castContext(context)?.sessionManager ?: return null
        val listener = object : SessionManagerListener<CastSession> {
            override fun onSessionStarting(session: CastSession) {}
            override fun onSessionStarted(session: CastSession, sessionId: String) = onActiveChanged(true)
            override fun onSessionStartFailed(session: CastSession, error: Int) = onActiveChanged(false)
            override fun onSessionEnding(session: CastSession) {}
            override fun onSessionEnded(session: CastSession, error: Int) = onActiveChanged(false)
            override fun onSessionResuming(session: CastSession, sessionId: String) {}
            override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) = onActiveChanged(true)
            override fun onSessionResumeFailed(session: CastSession, error: Int) = onActiveChanged(false)
            override fun onSessionSuspended(session: CastSession, reason: Int) {}
        }
        runCatching { manager.addSessionManagerListener(listener, CastSession::class.java) }
            .onFailure { return null }
        return AutoCloseable {
            runCatching { manager.removeSessionManagerListener(listener, CastSession::class.java) }
        }
    }

    override fun createReceiver(context: Context, listener: Player.Listener): CastReceiver? {
        val castContext = castContext(context) ?: return null
        val cast = CastPlayer(castContext, CastMetadataConverter())
        cast.addListener(listener)
        return object : CastReceiver {
            override val player: Player get() = cast
            override val isSessionAvailable: Boolean get() = cast.isCastSessionAvailable
            override fun setSessionListener(onAvailableChanged: ((Boolean) -> Unit)?) {
                cast.setSessionAvailabilityListener(onAvailableChanged?.let { changed ->
                    object : SessionAvailabilityListener {
                        override fun onCastSessionAvailable() = changed(true)
                        override fun onCastSessionUnavailable() = changed(false)
                    }
                })
            }
            override fun release() = cast.release()
        }
    }

    override fun loadOnReceiver(context: Context, media: CastMedia): CastLoadResult {
        val session = runCatching { castContext(context)?.sessionManager?.currentCastSession }.getOrNull()
            ?: return CastLoadResult.NoSession
        val meta = MediaMetadata(if (media.isVideo) MediaMetadata.MEDIA_TYPE_MOVIE else MediaMetadata.MEDIA_TYPE_PHOTO).apply {
            putString(MediaMetadata.KEY_TITLE, media.title)
        }
        val info = MediaInfo.Builder(media.url)
            .setStreamType(if (media.isVideo) MediaInfo.STREAM_TYPE_BUFFERED else MediaInfo.STREAM_TYPE_NONE)
            .setContentType(media.contentType)
            .setMetadata(meta)
            .build()
        return runCatching {
            session.remoteMediaClient?.load(MediaLoadRequestData.Builder().setMediaInfo(info).setAutoplay(true).build())
            CastLoadResult.Sent
        }.getOrElse { CastLoadResult.Failed }
    }

    private companion object {
        const val TAG = "CastHelper"
    }
}

/** web + play: the real Cast SDK. The amazon source set has its own factory returning NoCastSupport. */
internal object CastSupportFactory {
    fun create(): CastSupport = GmsCastSupport()
}
