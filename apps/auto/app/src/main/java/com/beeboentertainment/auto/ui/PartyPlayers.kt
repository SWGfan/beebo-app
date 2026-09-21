package com.beeboentertainment.auto.ui

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.beeboentertainment.auto.data.Http
import com.beeboentertainment.auto.data.Prefs
import com.beeboentertainment.auto.media.Catalog
import com.beeboentertainment.auto.media.PlaybackService
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.guava.await
import okhttp3.Call

/**
 * The two players a watch party drives on this device.
 *
 *  - HOST: a [MediaController] on the app's own [PlaybackService] session — the
 *    player Android Auto is already playing through, so the host's sound is the
 *    car's sound. PlaybackService is untouched.
 *  - VIEWER: a local [ExoPlayer] that decodes video for the passenger screen.
 *    It never takes audio focus (the host owns the car's audio) and is muted by
 *    PartyController while following.
 *
 * Main thread only, like every Media3 player.
 */
class PartyPlayers(context: Context) {

    private val app = context.applicationContext
    private var controllerFuture: ListenableFuture<MediaController>? = null

    private val viewerLazy = lazy {
        val httpFactory = OkHttpDataSource.Factory(
            Call.Factory { request -> Http.streamClient().newCall(request) }
        ).setUserAgent("BeeboEntertainment-Auto/1.0")
        ExoPlayer.Builder(app)
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(app)
                    .setDataSourceFactory(DefaultDataSource.Factory(app, httpFactory))
            )
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .setUsage(C.USAGE_MEDIA)
                    .build(),
                /* handleAudioFocus = */ false,
            )
            .build()
    }
    val viewer: ExoPlayer get() = viewerLazy.value

    /** Connect to the media session. Returns null (never throws) if it can't. */
    suspend fun connectHost(): Player? {
        val future = controllerFuture ?: MediaController.Builder(
            app,
            SessionToken(app, ComponentName(app, PlaybackService::class.java)),
        ).buildAsync().also { controllerFuture = it }
        return runCatching { future.await() }.getOrNull()
    }

    /**
     * Load the host's title on the viewer. Returns a sentence when it can't,
     * null on success.
     */
    suspend fun loadForViewer(videoId: String): String? {
        val prefs = Prefs.get(app)
        if (!prefs.isConfigured) {
            return "Sign in to your Beebo server on this device to watch the host's film."
        }
        val item = runCatching { Catalog(app).resolvePlayable(videoId) }.getOrNull()
            ?: return "Couldn't find the host's film on your server. " +
                "Check this device is signed in to the same server as the host."
        viewer.setMediaItem(item)
        viewer.prepare()
        return null
    }

    fun release() {
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        if (viewerLazy.isInitialized()) viewer.release()
    }
}
