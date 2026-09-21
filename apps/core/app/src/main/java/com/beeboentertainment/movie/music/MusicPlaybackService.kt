package com.beeboentertainment.movie.music

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.ShuffleOrder
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.R
import com.beeboentertainment.movie.audio.AudioExtras
import com.beeboentertainment.movie.audio.AudioKind
import com.beeboentertainment.movie.audio.AudioPrefs
import com.beeboentertainment.movie.audio.AudioStreamRules
import com.beeboentertainment.movie.audio.SpokenSeek
import com.beeboentertainment.movie.core.UrlUtils
import com.google.common.collect.ImmutableList
import com.beeboentertainment.movie.rtc.RemoteAccess
import com.beeboentertainment.movie.rtc.Route
import com.beeboentertainment.movie.ui.MainActivity
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.util.concurrent.ConcurrentHashMap
import kotlin.random.Random

/**
 * The Music player: a queue of songs that keeps playing with the screen off, with controls on
 * the lock screen, in the notification shade, on a headset and a watch.
 *
 * Why a service of its own rather than more of the video PlaybackService: that one is built
 * round a single film or episode (its ⏮ / ⏭ ask the server for the next episode, it posts watch
 * history, resume marks and subtitles for one item). A music queue needs the opposite - Media3's
 * own playlist, so songs run into each other gaplessly, shuffle and repeat work from every
 * controller, and nothing is written to the family's watch history. Two sessions in one app is
 * supported by Media3; each has its own id and notification, and audio focus makes them take
 * turns: starting a song pauses a film and starting a film pauses the music.
 *
 * Streams: every song URL is resolved just before it is fetched to add what this device can
 * decode and the quality to use (MusicStreamRules). Away from home that is the owner's chosen
 * data-saving quality; at home the original. The app's bearer token goes in a header, only to
 * this Beebo server, and the shared OkHttp client carries it over the tunnel away from home.
 */
@UnstableApi
class MusicPlaybackService : MediaSessionService() {

    companion object {
        const val SESSION_ID = "beebo-music"
        private const val NOTIFICATION_ID = 0xBEEB
        private const val CHANNEL_ID = "beebo_music"
        private const val SKIP_BACK = "beebo.audio.skipBack"
        private const val SKIP_FORWARD = "beebo.audio.skipForward"
    }

    private var session: MediaSession? = null
    private var exo: ExoPlayer? = null

    /**
     * The URL each song was first resolved to. A seek re-opens the stream, and it must ask for
     * exactly the same bytes (same format and quality) even if the phone has since left home.
     */
    private val resolved = ConcurrentHashMap<String, String>()

    override fun onCreate() {
        super.onCreate()
        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this)
                .setNotificationId(NOTIFICATION_ID)
                .setChannelId(CHANNEL_ID)
                .setChannelName(R.string.music_notification_channel)
                .build()
        )
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                /* handleAudioFocus = */ true
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            // Skip buttons for audiobooks and podcasts (a headset's rewind / fast-forward key).
            .setSeekBackIncrementMs(AudioPrefs.skipBackSeconds(this) * 1000L)
            .setSeekForwardIncrementMs(AudioPrefs.skipForwardSeconds(this) * 1000L)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(this, streamDataSource())))
            .build()
        player.addListener(listener)
        exo = player
        session = MediaSession.Builder(this, QueuePlayer(player))
            .setId(SESSION_ID)
            .setSessionActivity(openAppIntent())
            .setCallback(Callback())
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        session?.run {
            player.removeListener(listener)
            release()
        }
        session = null
        exo?.release()
        exo = null
        super.onDestroy()
    }

    private fun openAppIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MusicPlayer.EXTRA_OPEN_NOW_PLAYING, true)
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getActivity(this, 0x4D55, intent, flags)
    }

    private fun streamDataSource(): DataSource.Factory {
        val app = BeeboApp.instance
        return ResolvingDataSource.Factory(OkHttpDataSource.Factory(app.api.okHttp)) { spec ->
            val url = spec.uri.toString()
            val base = UrlUtils.normalizeBaseUrl(app.session.baseUrl)
            // Only this server's own audio addresses get the bearer token, whatever the kind.
            val kind = AudioStreamRules.kindOf(url, base) ?: return@Factory spec
            val key = url.substringBefore('?')
            val target = resolved.getOrPut(key) {
                when (kind) {
                    AudioKind.MUSIC -> {
                        val away = runCatching { RemoteAccess.currentRoute() is Route.Tunnel }.getOrDefault(false)
                        val quality = MusicStreamRules.qualityFor(away, MusicPrefs.homeQuality(this), MusicPrefs.awayQuality(this))
                        MusicStreamRules.withOptions(url, DeviceCodecs.list(), quality)
                    }
                    // Audiobooks are converted only when this phone cannot decode the format.
                    AudioKind.AUDIOBOOK -> MusicStreamRules.withOptions(url, DeviceCodecs.list(), "original")
                    // Podcasts and radio are relayed as they are.
                    AudioKind.PODCAST, AudioKind.RADIO -> url
                }
            }
            val token = app.session.token
            spec.buildUpon()
                .setUri(Uri.parse(target))
                .setHttpRequestHeaders(
                    if (token.isNullOrBlank()) spec.httpRequestHeaders
                    else spec.httpRequestHeaders + ("Authorization" to "Bearer $token")
                )
                .build()
        }
    }

    /** Forget stream decisions for songs that are no longer current or next. */
    private fun trimResolved(player: Player) {
        val keep = mutableSetOf<String>()
        val idx = player.currentMediaItemIndex
        listOf(idx, player.nextMediaItemIndex).filter { it in 0 until player.mediaItemCount }.forEach { i ->
            player.getMediaItemAt(i).localConfiguration?.uri?.toString()?.substringBefore('?')?.let { keep += it }
        }
        resolved.keys.retainAll(keep)
    }

    /**
     * Volume levelling: the ReplayGain of the song that just became current, applied as the
     * player's volume. Set on the transition (which fires when playback reaches the song, not when
     * it is queued) so a gapless join never plays the next song at the previous one's level. A
     * whole album in order uses the album gain; shuffle uses each song's own.
     */
    private fun applyLevel() {
        val player = exo ?: return
        val extras = player.currentMediaItem?.mediaMetadata?.extras
        fun d(key: String): Double? = extras?.takeIf { it.containsKey(key) }?.getDouble(key)
        val db = if (MusicPrefs.levelling(this)) MusicGain.db(
            d(MusicGain.EXTRA_GAIN_DB), d(MusicGain.EXTRA_ALBUM_GAIN_DB),
            d(MusicGain.EXTRA_GAIN_PEAK), d(MusicGain.EXTRA_ALBUM_GAIN_PEAK),
            albumMode = !player.shuffleModeEnabled
        ) else null
        player.volume = MusicGain.volumeFor(db)
    }

    /**
     * What is playing decides how the service behaves: spoken word asks the system for speech focus
     * (a navigation prompt pauses it rather than talking over it) and gets skip back / forward
     * buttons on the lock screen and in the shade; music keeps its own behaviour untouched.
     */
    private var currentKind: AudioKind? = null

    private fun onKindChanged(item: MediaItem?) {
        val kind = AudioKind.fromId(item?.mediaMetadata?.extras?.getString(AudioExtras.KIND))
        if (kind == currentKind) return
        currentKind = kind
        exo?.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(if (kind.spoken) C.AUDIO_CONTENT_TYPE_SPEECH else C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(),
            /* handleAudioFocus = */ true
        )
        session?.setCustomLayout(
            if (kind.spoken && kind.seekable) ImmutableList.of(skipButton(SKIP_BACK), skipButton(SKIP_FORWARD)) else ImmutableList.of()
        )
    }

    private fun skipButton(action: String): CommandButton {
        val back = action == SKIP_BACK
        return CommandButton.Builder()
            .setDisplayName(if (back) "Back ${AudioPrefs.skipBackSeconds(this)} seconds" else "Forward ${AudioPrefs.skipForwardSeconds(this)} seconds")
            .setIconResId(if (back) R.drawable.ic_audio_back else R.drawable.ic_audio_forward)
            .setSessionCommand(SessionCommand(action, Bundle.EMPTY))
            .build()
    }

    private val listener = object : Player.Listener {
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            session?.player?.let { trimResolved(it) }
            onKindChanged(mediaItem)
            applyLevel()
        }

        override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) {
            applyLevel()
        }
    }

    /**
     * Turning shuffle on keeps the song that is playing and shuffles only what comes after it
     * (MusicQueueLogic.shuffledOrder), whoever pressed the button - the app, the lock screen or a car.
     */
    private inner class QueuePlayer(private val player: ExoPlayer) : ForwardingPlayer(player) {
        override fun setShuffleModeEnabled(shuffleModeEnabled: Boolean) {
            if (shuffleModeEnabled && player.mediaItemCount > 1) {
                val seed = System.nanoTime()
                val order = MusicQueueLogic.shuffledOrder(player.mediaItemCount, player.currentMediaItemIndex, Random(seed))
                player.setShuffleOrder(ShuffleOrder.DefaultShuffleOrder(order, seed))
            }
            super.setShuffleModeEnabled(shuffleModeEnabled)
        }
    }

    /** Items arrive from MusicPlayer (in this process) or from an outside controller. */
    private inner class Callback : MediaSession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                .add(SessionCommand(SKIP_BACK, Bundle.EMPTY))
                .add(SessionCommand(SKIP_FORWARD, Bundle.EMPTY))
                .build()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(commands)
                .build()
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle
        ): ListenableFuture<SessionResult> {
            when (customCommand.customAction) {
                SKIP_BACK -> SpokenSeek.seekBy(session.player, -AudioPrefs.skipBackSeconds(this@MusicPlaybackService))
                SKIP_FORWARD -> SpokenSeek.seekBy(session.player, AudioPrefs.skipForwardSeconds(this@MusicPlaybackService))
                else -> return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
            }
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }

        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>
        ): ListenableFuture<MutableList<MediaItem>> {
            val base = BeeboApp.instance.session.baseUrl
            val out = mediaItems.mapNotNull { item ->
                when {
                    item.localConfiguration != null -> item
                    item.requestMetadata.mediaUri != null -> item.buildUpon().setUri(item.requestMetadata.mediaUri).build()
                    Regex("^[a-f0-9]{20}$").matches(item.mediaId) ->
                        UrlUtils.join(base, "/api/music/track/${item.mediaId}/stream")?.let { item.buildUpon().setUri(it).build() }
                    else -> null
                }
            }.toMutableList()
            return Futures.immediateFuture(out)
        }
    }
}
