package com.beeboentertainment.movie.player

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.beeboentertainment.movie.core.MediaTokenHeader
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.BackgroundPlaybackPolicy
import com.beeboentertainment.movie.core.LiveProgress
import com.beeboentertainment.movie.core.MediaMetadataBuilder
import com.beeboentertainment.movie.core.MimeGuess
import com.beeboentertainment.movie.core.PassthroughSetting
import com.beeboentertainment.movie.core.PlayQueueHolder
import com.beeboentertainment.movie.core.PlaylistLogic
import com.beeboentertainment.movie.core.SubtitlePolicy
import com.beeboentertainment.movie.core.TransportPolicy
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.UpNextItem
import com.beeboentertainment.movie.ui.MainActivity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Owns the actual player.
 *
 * Why a service at all: an ExoPlayer living inside PlayerActivity dies the moment Android decides
 * to tear the Activity down, and it has no legitimate way to keep decoding once the screen locks.
 * A MediaSessionService is the supported way to keep playback running in the background — it also
 * hands us the lock-screen / notification transport controls, Bluetooth button handling and
 * Android Auto compatibility for free, because Media3's DefaultMediaNotificationProvider builds
 * the notification straight from the session's current MediaItem metadata.
 *
 * This service also owns the two things that must keep happening while the UI is gone:
 *   - saving the resume position
 *   - posting /api/watch-session + /api/progress so the family's watch history stays accurate
 *
 * Casting lives here too: the CastPlayer and the local ExoPlayer are swapped underneath the same
 * MediaSession, so the notification and the Activity both keep pointing at whatever is playing.
 */
@UnstableApi
class PlaybackService : MediaSessionService() {

    companion object {
        private const val TAG = "PlaybackService"

        /**
         * How often we persist the resume mark and (every sixth tick) report progress.
         * Battery: 30 s between /api/progress POSTs lets the radio drop to its idle state
         * between requests (10 s never did). Pause, stop, end and seek post immediately (see
         * the listener), so cross-device resume is no less accurate; the server credits
         * forward steps of up to 120 s, so 30 s is well inside its window.
         */
        private const val TICK_MS = 5_000L
        private const val PROGRESS_EVERY_TICKS = 6   // -> /api/progress roughly every 30s

        /** Skip-button mashing and scrubbing fire seek events many times a second; settle first. */
        private const val SEEK_REPORT_DEBOUNCE_MS = 1_500L

        /**
         * How long the MediaSession stays pointed at the phone after a cast session appears,
         * waiting for the receiver to confirm it has the item. See startCastHandover.
         */
        private const val CAST_HANDOVER_TIMEOUT_MS = 12_000L

        /** Set on MediaItem metadata extras so the service knows what it is playing. */
        const val EXTRA_KIND = MediaMetadataBuilder.EXTRA_KIND
        const val EXTRA_ITEM_ID = MediaMetadataBuilder.EXTRA_ITEM_ID
    }

    private var mediaSession: MediaSession? = null
    private var localPlayer: ExoPlayer? = null
    private var castPlayer: CastReceiver? = null

    /**
     * The players the session actually sees: each real player wrapped so ⏮ / ⏭ mean
     * "previous / next episode" instead of "previous / next item in a one-item playlist".
     */
    private var localTransport: TransportForwardingPlayer? = null
    private var castTransport: TransportForwardingPlayer? = null

    /** Sits between the CastPlayer and the session. See CastStabilisingPlayer. */
    private var castStabiliser: CastStabilisingPlayer? = null

    /**
     * True between "a cast session appeared" and "the receiver actually has the item".
     * The session deliberately stays on the local player for that window.
     */
    private var pendingCastHandover = false
    private var handoverTimeout: Job? = null

    /** Cached /api/upnext for whatever is playing, so the transport buttons act instantly. */
    private var transportNext: UpNextItem? = null
    private var transportPrevious: UpNextItem? = null
    private var transportForItemId: String? = null
    /** What the server said for [transportForItemId]; the play queue is layered on top of it. */
    private var serverNext: UpNextItem? = null
    private var serverPrevious: UpNextItem? = null
    private var serverAnsweredFor: String? = null

    private val scope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob())
    private var ticker: Job? = null
    private var eventReport: Job? = null

    /** Watch-history session for the item currently playing. */
    private var watchSessionId: String? = null
    private var watchSessionItemId: String? = null

    /** The file the subtitle handling last dealt with, so re-setting the same one is not a new video. */
    private var subtitleItemId: String? = null
    private var subtitleJob: Job? = null
    /** Set just before this service re-sets an item to carry its sidecars. That transition is the same viewing. */
    private var sidecarReattachFor: String? = null
    /** (item id, sidecar index) still to be selected once the player has merged the sidecar in as a track. */
    private var pendingSubtitle: Pair<String, Int>? = null

    private val app get() = BeeboApp.instance

    /**
     * True while a Chromecast session owns playback - including the handover window, when the
     * session is still nominally on the paused local player.
     */
    val isCasting: Boolean
        get() = pendingCastHandover ||
            (castTransport != null && mediaSession?.player === castTransport)

    /* ------------------------------- lifecycle ------------------------------- */

    override fun onCreate() {
        super.onCreate()

        val player = ExoPlayer.Builder(this, BeeboRenderersFactory(this) { PassthroughSetting.fromId(app.session.plain.getString(PassthroughSetting.PREF_KEY, null)) != PassthroughSetting.OFF })
            // handleAudioFocus = true gives us AudioFocusPolicy's behaviour natively:
            // duck on a transient duck-able loss, pause on a call or another media app.
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus = */ true
            )
            // Pause when headphones are unplugged / BT disconnects.
            .setHandleAudioBecomingNoisy(true)
            // Hold a partial wake lock + wifi lock so playback survives the screen turning off.
            .setWakeMode(C.WAKE_MODE_NETWORK)
            // The same data sources ExoPlayer builds by default, except that a stream or subtitle
            // URL's media token goes in a header when the server reads one (MediaTokenHeader).
            // MediaItems keep the tokened URL, so a cast still hands the TV a link that works.
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(this, mediaTokenDataSource())))
            .build()

        player.addListener(playerListener)
        player.addAnalyticsListener(AudioOutputState.listener)
        localPlayer = player
        val wrapped = TransportForwardingPlayer(player)
        localTransport = wrapped

        mediaSession = MediaSession.Builder(this, wrapped)
            .setSessionActivity(openAppIntent())
            .setCallback(SessionCallback())
            .build()

        setUpCastPlayer()
        startTicker()
        // Play next / Add to queue while something plays: ⏭ and the up-next card follow at once.
        scope.launch {
            PlayQueueHolder.queue.collect {
                val id = transportForItemId ?: return@collect
                if (id == currentItemId()) applyQueueTransport(id, currentKind())
            }
        }
    }

    private fun mediaTokenDataSource(): DataSource.Factory =
        // The app's own OkHttp client, not HttpURLConnection: through name.beebo.tv that is what
        // carries the film over the tunnel (Range requests, so seeking works) or to the computer's
        // own address at home. For any other server it behaves as before.
        ResolvingDataSource.Factory(androidx.media3.datasource.okhttp.OkHttpDataSource.Factory(com.beeboentertainment.movie.BeeboApp.instance.api.okHttp)) { spec ->
            val split = MediaTokenHeader.forPlayback(spec.uri.toString())
            if (split == null) spec
            else spec.buildUpon()
                .setUri(Uri.parse(split.url))
                .setHttpRequestHeaders(spec.httpRequestHeaders + (MediaTokenHeader.HEADER to split.token))
                .build()
        }

    private fun pendingIntentFlags(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT

    /** Fallback: nothing is playing, so the notification can only mean "open Beebo". */
    private fun openAppIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(this, 0, intent, pendingIntentFlags())
    }

    /**
     * Tapping the notification (or the cast "live notification") should land on the VIDEO,
     * not the home screen. Everything needed is already on the MediaItem: the id and kind
     * ride in the metadata extras, the title in the metadata, and the URL in the item itself.
     *
     * Falls back to opening the app whenever there is nothing playable to point at, so the
     * notification is never left with a dead tap target.
     */
    private fun playerIntent(): PendingIntent {
        val item = runCatching { localPlayer?.currentMediaItem }.getOrNull() ?: return openAppIntent()
        val meta = item.mediaMetadata
        val extras = meta.extras
        val itemId = extras?.getString(EXTRA_ITEM_ID)?.takeIf { it.isNotBlank() }
            ?: item.mediaId.takeIf { it.isNotBlank() }
            ?: return openAppIntent()
        val uri = item.localConfiguration?.uri?.toString()?.takeIf { it.isNotBlank() }
            ?: return openAppIntent()

        // A downloaded copy comes through as file://; anything else is a server URL.
        val offline = uri.startsWith("file:")
        val intent = PlayerActivity.intentFor(
            context = this,
            itemId = itemId,
            kind = extras?.getString(EXTRA_KIND) ?: "movie",
            title = meta.title?.toString() ?: "",
            streamUrl = if (offline) null else uri,
            localPath = if (offline) Uri.parse(uri).path else null,
            posterUrl = meta.artworkUri?.toString()
        ).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        // A different request code from openAppIntent(), so FLAG_UPDATE_CURRENT never
        // rewrites one into the other.
        return PendingIntent.getActivity(this, 1, intent, pendingIntentFlags())
    }

    /** Re-point the notification at whatever is on screen now. Cheap; safe to call often. */
    private fun refreshSessionActivity() {
        runCatching { mediaSession?.setSessionActivity(playerIntent()) }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    /**
     * The user swiped the app away. If nothing is playing there is no reason to linger; if a cast
     * session is live we stay so the TV keeps going.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = mediaSession?.player
        if (player == null || (!player.playWhenReady && !isCasting)) {
            stopSelfSafely()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        ticker?.cancel()
        eventReport?.cancel()
        scope.cancel()
        saveResumeNow()
        handoverTimeout?.cancel()
        handoverTimeout = null
        pendingCastHandover = false
        // Nothing on this phone is left serving video to a TV once playback is gone.
        PhoneCastRelay.stop()
        castPlayer?.setSessionListener(null)
        castPlayer?.release()
        castPlayer = null
        castStabiliser = null
        castTransport = null
        localTransport = null
        mediaSession?.run {
            player.removeListener(playerListener)
            release()
        }
        mediaSession = null
        localPlayer?.release()
        localPlayer = null
        super.onDestroy()
    }

    private fun stopSelfSafely() {
        saveResumeNow()
        runCatching { stopSelf() }
    }

    /* --------------------------------- cast --------------------------------- */

    private fun setUpCastPlayer() {
        // Null when Cast is unavailable: no Play services, or the Amazon build (no Cast SDK).
        val receiver = CastHelper.createReceiver(this, playerListener) ?: return
        castPlayer = receiver.apply {
            setSessionListener { available -> swapPlayer(toCast = available) }
        }
        castStabiliser = CastStabilisingPlayer(receiver)
        castTransport = castStabiliser?.let { TransportForwardingPlayer(it) }
        if (receiver.isSessionAvailable) swapPlayer(toCast = true)
    }

    /** Move playback between the phone and the TV. */
    private fun swapPlayer(toCast: Boolean) {
        if (toCast) {
            startCastHandover()
        } else {
            // Order matters: endCastHandover takes the item back off the TV and needs the phone's
            // stand-in addresses turned back into the real ones first. Only then does the little
            // server - and the wake lock and Wi-Fi lock it holds - go away.
            endCastHandover()
            PhoneCastRelay.stop()
        }
    }

    /**
     * A cast session came up.
     *
     * The item is loaded into the CastPlayer FIRST and the MediaSession is only re-pointed once
     * the receiver has actually taken it.
     *
     * Why the wait: Media3's MediaNotificationManager cancels the media notification outright -
     * stopForeground(STOP_FOREGROUND_REMOVE) plus NotificationManager.cancel - the moment the
     * session's player reports an empty timeline or STATE_IDLE. A freshly built CastPlayer
     * reports both until the receiver answers queueLoad, so handing it the session immediately
     * destroyed the shade controls and left them to be rebuilt from nothing.
     *
     * The phone is muted straight away so the audio does not double up; the session simply keeps
     * pointing at the (paused, still loaded) local player until the TV is genuinely in charge.
     */
    private fun startCastHandover() {
        val session = mediaSession ?: return
        val target = castTransport ?: return
        val previous = session.player
        if (previous === target) return

        val item = previous.currentMediaItem
        val positionMs = previous.currentPosition
        val wasPlaying = previous.playWhenReady

        // A downloaded file lives on the phone; a Chromecast cannot reach it.
        if (item?.localConfiguration?.uri?.scheme == "file") {
            Log.i(TAG, "Refusing to cast a local file")
            return
        }

        // name.beebo.tv: a TV can't reach this phone's tunnel. At home the URLs move to the
        // computer's own address; away from home the cast is refused (the button is hidden there).
        val castItem = item?.let { castableItem(it) }
        if (item != null && castItem == null) {
            Log.i(TAG, "Refusing to cast: the TV has no address it can reach for this one")
            // Away from home the phone carries the film itself, and only whole files can travel
            // that way. Rather than a button that does nothing, say which it is and what to do.
            val decision = com.beeboentertainment.movie.rtc.RemoteAccess.castDecision()
            if (decision is com.beeboentertainment.movie.rtc.CastRule.Decision.ViaPhone) {
                val playingConverted = item.localConfiguration?.uri?.toString()
                    ?.let { !PhoneCastRules.canPassThrough(it) } == true
                PhoneCastRelay.say(
                    if (playingConverted) com.beeboentertainment.movie.rtc.CastRule.CANT_CAST_CONVERTED
                    else com.beeboentertainment.movie.rtc.CastRule.CANT_CONVERT_AWAY
                )
            }
            return
        }

        previous.pause()

        if (castItem != null) {
            castStabiliser?.remember(castItem, positionMs)
            target.setMediaItem(castItem, positionMs)
            target.prepare()
            target.playWhenReady = wasPlaying
        }

        pendingCastHandover = true
        handoverTimeout?.cancel()
        handoverTimeout = scope.launch {
            delay(CAST_HANDOVER_TIMEOUT_MS)
            // The receiver never reported a queue. Hand over anyway rather than leaving the
            // session pointing at a phone that is not playing anything.
            if (pendingCastHandover) completeCastHandover(force = true)
        }
        // It may already be there (resuming an existing session), so try immediately.
        completeCastHandover(force = false)
    }

    /**
     * [item] with every URL a TV can reach, or null when it can't be cast from here (CastRule).
     *
     * At home the URLs move to the computer's own address. Away from home, on Wi-Fi, they move
     * to this phone: [PhoneCastRelay] registers each one and gives back an address on the phone
     * that the TV can fetch, and the phone pulls the bytes down the tunnel as the TV asks for
     * them. The video URL is registered FIRST, because that is what starts a fresh session (new
     * token) - the subtitles and poster then join the same one.
     */
    private fun castableItem(item: androidx.media3.common.MediaItem): androidx.media3.common.MediaItem? {
        val decision = com.beeboentertainment.movie.rtc.RemoteAccess.castDecision()
        if (decision is com.beeboentertainment.movie.rtc.CastRule.Decision.Allowed) return item
        val cfg = item.localConfiguration ?: return item
        val viaPhone: (String) -> String? = { PhoneCastRelay.localUrlFor(it) }
        val uri = com.beeboentertainment.movie.rtc.CastRule.castUrl(cfg.uri.toString(), decision, viaPhone) ?: return null
        val subs = cfg.subtitleConfigurations.map { s ->
            val u = com.beeboentertainment.movie.rtc.CastRule.castUrl(s.uri.toString(), decision, viaPhone) ?: return null
            s.buildUpon().setUri(Uri.parse(u)).build()
        }
        // The poster must move to the TV-reachable address too, or the TV shows no artwork.
        val art = item.mediaMetadata.artworkUri?.toString()
            ?.let { com.beeboentertainment.movie.rtc.CastRule.castUrl(it, decision, viaPhone) }
        val metadata = item.mediaMetadata.buildUpon().setArtworkUri(art?.let { Uri.parse(it) }).build()
        return item.buildUpon().setUri(uri).setSubtitleConfigurations(subs).setMediaMetadata(metadata).build()
    }

    /**
     * The opposite of the away-from-home cast rewrite: any address on this phone goes back to the
     * home computer's own URL, so the phone plays the film itself again once the TV lets go.
     * A no-op at home and on any other server address.
     */
    private fun backFromPhone(item: androidx.media3.common.MediaItem): androidx.media3.common.MediaItem {
        val cfg = item.localConfiguration ?: return item
        val uri = PhoneCastRelay.originalUrl(cfg.uri.toString())
        val subs = cfg.subtitleConfigurations.map { s ->
            PhoneCastRelay.originalUrl(s.uri.toString())?.let { s.buildUpon().setUri(Uri.parse(it)).build() } ?: s
        }
        val art = item.mediaMetadata.artworkUri?.toString()?.let { PhoneCastRelay.originalUrl(it) }
        if (uri == null && art == null && subs == cfg.subtitleConfigurations) return item
        val b = item.buildUpon().setSubtitleConfigurations(subs)
        if (uri != null) b.setUri(Uri.parse(uri))
        if (art != null) b.setMediaMetadata(item.mediaMetadata.buildUpon().setArtworkUri(Uri.parse(art)).build())
        return b.build()
    }

    /** Re-point the MediaSession at the cast player once the receiver really has the item. */
    private fun completeCastHandover(force: Boolean) {
        if (!pendingCastHandover) return
        val session = mediaSession ?: return
        val cast = castPlayer?.player ?: return
        val target = castTransport ?: return
        val ready = !cast.currentTimeline.isEmpty() && cast.playbackState != Player.STATE_IDLE
        if (!force && !ready) return

        pendingCastHandover = false
        handoverTimeout?.cancel()
        handoverTimeout = null
        if (session.player !== target) session.player = target
        // Scrubbing must keep working while casting, and the CastPlayer reports its own set.
        publishAvailableCommands()
        refreshSessionActivity()
    }

    /** The cast session ended: bring playback back to the phone, carrying position and state. */
    private fun endCastHandover() {
        val session = mediaSession ?: return
        val target = localTransport ?: return
        pendingCastHandover = false
        handoverTimeout?.cancel()
        handoverTimeout = null
        val previous = session.player
        if (previous === target) return

        // The receiver hands the item back without its sidecars; put known ones straight back on
        // rather than re-preparing a second time a moment after this one. Away from home it also
        // hands back the addresses on THIS phone that it was given, which are about to stop
        // working, so those go back to the home computer's own URLs first.
        val item = previous.currentMediaItem?.let { withCachedSidecars(backFromPhone(it)) }
        val positionMs = previous.currentPosition
        val wasPlaying = previous.playWhenReady

        previous.pause()
        session.player = target
        if (item != null) {
            target.setMediaItem(item, positionMs)
            target.playWhenReady = wasPlaying
            target.prepare()
        }
        publishAvailableCommands()
        refreshSessionActivity()
    }

    /* ------------------------- progress + resume ticker ---------------------- */

    private fun startTicker() {
        ticker?.cancel()
        ticker = scope.launch {
            var tick = 0
            while (isActive) {
                delay(TICK_MS)
                tick++
                val player = mediaSession?.player ?: continue
                // isPlaying is ExoPlayer's word for "rendering right now"; the cast wrappers
                // do not always say it while the TV is plainly playing. playWhenReady + READY
                // is the same question asked in words every Player answers.
                val advancing = player.isPlaying ||
                    (player.playWhenReady && player.playbackState == Player.STATE_READY)
                if (!advancing) continue
                saveResumeNow()
                // The Library and episode lists follow this every tick; crossing 95% also
                // tells the server straight away, so the next episode is there on refresh.
                val crossed = publishLiveProgress(player)
                if (crossed) reportProgressSoon(player, 0L)
                else if (tick % PROGRESS_EVERY_TICKS == 0) reportProgress(player)
            }
        }
    }

    private fun currentItemId(): String? =
        mediaSession?.player?.currentMediaItem?.mediaMetadata?.extras?.getString(EXTRA_ITEM_ID)
            ?: mediaSession?.player?.currentMediaItem?.mediaId?.takeIf { it.isNotBlank() }

    private fun currentKind(): String =
        mediaSession?.player?.currentMediaItem?.mediaMetadata?.extras?.getString(EXTRA_KIND) ?: "movie"

    /** Persist the resume mark. Safe to call at any time; ResumeStore ignores trivial positions. */
    private fun saveResumeNow() {
        val player = mediaSession?.player ?: return
        val id = currentItemId() ?: return
        runCatching { app.resume.save(id, player.currentPosition, player.duration) }
    }

    /**
     * Share the position with the app's lists (LiveProgress). No network, no disk: the lists
     * redraw from it immediately. Returns true when this update crossed the finished line.
     */
    private fun publishLiveProgress(player: Player): Boolean {
        val id = currentItemId() ?: return false
        val item = player.currentMediaItem
        return runCatching {
            LiveProgress.shared.report(
                itemId = id,
                kind = currentKind(),
                title = item?.mediaMetadata?.title?.toString().orEmpty(),
                positionMs = player.currentPosition,
                durationMs = player.duration.takeIf { it > 0L } ?: 0L,
                nowMs = System.currentTimeMillis(),
                // While casting away from home the item points at this phone; the lists want the
                // real address, which is what "Continue watching" will open later.
                streamUrl = item?.localConfiguration?.uri?.toString()
                    ?.let { PhoneCastRelay.originalUrl(it) ?: it },
                posterUrl = item?.mediaMetadata?.artworkUri?.toString()
            )
        }.getOrDefault(false)
    }

    /**
     * Out-of-band progress report for pause / stop / end / seek, so the server's mark is fresh
     * without waiting for the next 30 s tick. A pending one is replaced, so a burst of seeks
     * posts once, at the position it settled on.
     */
    private fun reportProgressSoon(player: Player, delayMs: Long) {
        eventReport?.cancel()
        eventReport = scope.launch {
            if (delayMs > 0) delay(delayMs)
            reportProgress(player, notifyLists = true)
        }
    }

    /**
     * Watch history. Best effort in every direction — a family media server being briefly
     * unreachable must never interrupt playback.
     */
    private fun reportProgress(player: Player, notifyLists: Boolean = false) {
        val id = currentItemId() ?: return
        scope.launch {
            try {
                if (watchSessionId == null || watchSessionItemId != id) {
                    watchSessionItemId = id
                    watchSessionId = app.api.startWatchSession(currentKind(), id).sessionId
                }
                val sid = watchSessionId ?: return@launch
                val pos = player.currentPosition
                val dur = player.duration
                if (pos <= 0) return@launch
                app.api.reportProgress(sid, pos / 1000.0, if (dur > 0) dur / 1000.0 else 0.0)
                // Pause / stop / seek / finished: lists on screen may now fetch the server's view
                // (e.g. the next episode). The periodic 30 s report does not ask for a refetch.
                if (notifyLists) LiveProgress.shared.serverUpdated()
            } catch (_: Exception) {
                // history is a nice-to-have; swallow and try again on the next tick
            }
        }
    }

    /**
     * On a TV, the home screen's "Continue watching" row follows the server's Continue list. A
     * few seconds' wait lets the progress report above land first.
     */
    private fun refreshWatchNextSoon() {
        if (!com.beeboentertainment.movie.voice.WatchNextSync.supported(this)) return
        scope.launch {
            delay(3_000)
            com.beeboentertainment.movie.voice.WatchNextSync.refresh(applicationContext)
        }
    }

    /* ------------------------------- transport -------------------------------- */

    /**
     * Ask the server what sits either side of the current item.
     *
     * One request per item, cached, so pressing ⏮ / ⏭ is instant and never fires off a lookup
     * mid-press. Failures leave the cache empty, which degrades to "⏮ restarts, ⏭ says it's the
     * last one" rather than to a crash.
     */
    private fun refreshTransport() {
        val id = currentItemId()
        if (id.isNullOrBlank() || id == transportForItemId) return
        transportForItemId = id
        transportNext = null
        transportPrevious = null
        serverNext = null
        serverPrevious = null
        serverAnsweredFor = null
        val kind = currentKind()
        TransportCache.startItem(id, kind)

        // The play queue (a playlist, Play next, Add to queue): move onto this item if it is the
        // next one queued, remember where a playlist got to, and let the queue answer ⏭ at once.
        if (PlayQueueHolder.onItemStarted(kind, id)) {
            val q = PlayQueueHolder.current
            val playlistId = q.playlistId
            if (playlistId != null) {
                scope.launch {
                    runCatching { app.api.playlistProgress(playlistId, q.current?.entryId.orEmpty(), q.pos, q.shuffle, q.seed) }
                }
            }
        }
        applyQueueTransport(id, kind)

        scope.launch {
            val response = runCatching { app.api.upNext(kind, id) }.getOrNull() ?: return@launch
            // Ignore a late answer for an item we have already moved off.
            if (transportForItemId != id) return@launch
            serverNext = response.next
            serverPrevious = response.previous
            serverAnsweredFor = id
            applyQueueTransport(id, kind)
        }

        scope.launch {
            // Markers are duration-validated server-side, so send the duration once we have one.
            val durationSeconds = mediaSession?.player?.duration
                ?.takeIf { it > 0 }?.let { it / 1000.0 }
            val markers = runCatching { app.api.markers(kind, id, durationSeconds) }.getOrNull()
                ?: return@launch
            if (transportForItemId != id) return@launch
            TransportCache.setMarkers(id, markers.introEndSeconds, markers.creditsStartSeconds)
        }
    }

    /**
     * ⏮ / ⏭ for [id]: the play queue first, then the server's up next (PlaylistLogic.transportFor).
     * The cache only counts as loaded once one of them has something to say, or the server answered.
     */
    private fun applyQueueTransport(id: String, kind: String) {
        val (next, previous) = PlaylistLogic.transportFor(PlayQueueHolder.current, kind, id, serverNext, serverPrevious)
        transportNext = next
        transportPrevious = previous
        if (next != null || previous != null || serverAnsweredFor == id) TransportCache.setTransport(id, next, previous)
        publishAvailableCommands()
    }

    /**
     * Re-publish the player commands to every connected controller.
     *
     * A MediaController caches the command set it was given at connect time; without this, the
     * ⏭ button would stay disabled forever because the /api/upnext answer always arrives after
     * the controller has connected.
     */
    private fun publishAvailableCommands() {
        val session = mediaSession ?: return
        // RECOMPUTED, never cached. The previous version took this once, when the /api/upnext
        // answer landed — which is while the player is still buffering and therefore before it
        // reports COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM. Pinning that early snapshot onto every
        // controller left the scrub bar disabled for the whole item.
        val commands = session.player.availableCommands
        session.connectedControllers.forEach { controller ->
            runCatching {
                session.setAvailableCommands(
                    controller,
                    // Not SessionCommands.EMPTY: that stripped every controller's session
                    // commands as a side effect of refreshing the player ones.
                    MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS,
                    commands
                )
            }
        }
    }

    /** ⏮ — restart when we are into the item, otherwise step back; never a no-op. */
    private fun handlePrevious() {
        val player = mediaSession?.player ?: return
        when (TransportPolicy.previousAction(player.currentPosition, transportPrevious != null)) {
            TransportPolicy.PreviousAction.RESTART -> player.seekTo(0L)
            TransportPolicy.PreviousAction.GO_PREVIOUS ->
                transportPrevious?.let { playTransportItem(it) } ?: player.seekTo(0L)
        }
    }

    /** ⏭ — play the next episode / collection part, if there is one. */
    private fun handleNext() {
        val item = transportNext
        if (item == null) {
            Log.i(TAG, TransportPolicy.NO_NEXT_MESSAGE)
            return
        }
        playTransportItem(item)
    }

    /**
     * Swap the session's player onto another episode / part.
     * Built here rather than in the Activity so the lock screen, the notification and a headset
     * button all work identically while the UI is gone.
     */
    private fun playTransportItem(item: UpNextItem) {
        val player = mediaSession?.player ?: return
        val mediaItem = MediaItemFactory.forUpNextItem(app.session.baseUrl, item) ?: return
        player.setMediaItem(withCachedSidecars(mediaItem), 0L)
        player.playWhenReady = true
        player.prepare()
    }

    /* ------------------------------- subtitles -------------------------------- */

    /**
     * Sidecar subtitles for whatever the player just moved to, whoever moved it.
     *
     * PlayerActivity puts the sidecars on the items it builds, but it is not there for the episodes
     * this service moves to itself - ⏭ in the notification, on the lock screen or a headset - with
     * the app closed, and those came up with none. So the service makes sure of it for every item:
     * a new file starts with no subtitle override left over from the last one, and if the viewer
     * has subtitles on and the item arrived without its sidecars, they are looked up (off the main
     * thread, inside ApiClient) and put on with one re-prepare where it stands.
     *
     * Nothing waits on this - the video is already playing when it starts - and any failure just
     * means no subtitles for that item. Skipped entirely while casting: see SubtitlePolicy.shouldAttach.
     */
    private fun refreshSubtitles() {
        if (isCasting) return
        val player = localPlayer ?: return
        val item = player.currentMediaItem ?: return
        val extras = item.mediaMetadata.extras
        val id = extras?.getString(EXTRA_ITEM_ID)?.takeIf { it.isNotBlank() } ?: return
        val kind = extras.getString(EXTRA_KIND) ?: "movie"
        val attached = SidecarSubtitles.attachedTo(item)

        if (id != subtitleItemId) {
            subtitleItemId = id
            subtitleJob?.cancel()
            pendingSubtitle = null
            // Overrides are keyed by track group, and two files' same-language sidecars make
            // groups that compare EQUAL - left alone, the last film's choice picks itself again.
            clearTextOverrides(player)
            if (attached) armSubtitleSelection(id, item.localConfiguration?.subtitleConfigurations.orEmpty())
        }
        // The same file again (re-set to carry sidecars, or handed back by a cast) keeps its
        // override - it is still the right one - and only needs sidecars if it came back bare.

        if (!SubtitlePolicy.shouldAttach(
                subtitlesOn = app.session.subtitlesOn,
                casting = isCasting,
                itemId = id,
                uri = item.localConfiguration?.uri?.toString(),
                alreadyAttached = attached
            )
        ) return
        if (subtitleJob?.isActive == true) return
        // Dispatchers.Main, not .immediate: a cached answer must not re-set the item from inside
        // the very transition callback that is reporting it.
        subtitleJob = scope.launch(Dispatchers.Main) {
            val tracks = try {
                SidecarSubtitles.tracks(app.api, kind, id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.d(TAG, "No subtitle list for $id: ${e.message}")
                return@launch
            }
            attachSidecars(id, tracks)
        }
    }

    /** Re-set the current item, where it stands, carrying [tracks] - if it is still [id] and still bare. */
    private fun attachSidecars(id: String, tracks: List<com.beeboentertainment.movie.data.SubtitleTrack>) {
        if (tracks.isEmpty() || isCasting || !app.session.subtitlesOn) return
        val player = localPlayer ?: return
        val current = player.currentMediaItem ?: return
        if (current.mediaMetadata.extras?.getString(EXTRA_ITEM_ID) != id) return
        if (SidecarSubtitles.attachedTo(current)) return
        val configurations = SidecarSubtitles.configurations(app.session.baseUrl, tracks)
        if (configurations.isEmpty()) return

        armSubtitleSelection(id, configurations)
        val positionMs = player.currentPosition
        val wasPlaying = player.playWhenReady
        sidecarReattachFor = id
        player.setMediaItem(current.buildUpon().setSubtitleConfigurations(configurations).build(), positionMs)
        player.prepare()
        player.playWhenReady = wasPlaying
    }

    /**
     * An item about to be played, with its sidecars on if they are already known - no request,
     * no waiting. Anything not known yet is left to refreshSubtitles once it is playing.
     */
    private fun withCachedSidecars(item: MediaItem): MediaItem {
        if (SidecarSubtitles.attachedTo(item)) return item
        if (!SubtitlePolicy.isStream(item.localConfiguration?.uri?.toString())) return item
        val extras = item.mediaMetadata.extras ?: return item
        val id = extras.getString(EXTRA_ITEM_ID)?.takeIf { it.isNotBlank() } ?: return item
        val tracks = SidecarSubtitles.cached(extras.getString(EXTRA_KIND) ?: "movie", id) ?: return item
        val configurations = SidecarSubtitles.configurations(app.session.baseUrl, tracks)
        if (configurations.isEmpty()) return item
        return item.buildUpon().setSubtitleConfigurations(configurations).build()
    }

    /** Remember which sidecar the viewer's saved preference wants, to select once it is a track. */
    private fun armSubtitleSelection(id: String, configurations: List<MediaItem.SubtitleConfiguration>) {
        val index = SubtitlePolicy.rememberedIndex(
            languages = configurations.map { it.language },
            subtitlesOn = app.session.subtitlesOn,
            wantedLanguage = app.session.subtitleLanguage
        )
        pendingSubtitle = if (index >= 0) id to index else null
    }

    /**
     * A sidecar only becomes a selectable track once the player has merged it in, well after
     * setMediaItem. Selected once, then left alone, so a different choice made from the picker
     * afterwards is never fought over.
     */
    private fun applyPendingSubtitle() {
        val (id, index) = pendingSubtitle ?: return
        if (isCasting) return
        val player = localPlayer ?: return
        if (player.currentMediaItem?.mediaMetadata?.extras?.getString(EXTRA_ITEM_ID) != id) {
            pendingSubtitle = null
            return
        }
        val group = SidecarSubtitles.textGroup(player.currentTracks, index) ?: return
        pendingSubtitle = null
        runCatching {
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
                .build()
        }
    }

    /** Same "off" as PlayerActivity.clearSubtitleSelection: clear the override, never disable the type. */
    private fun clearTextOverrides(player: Player) {
        runCatching {
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .build()
        }
    }

    /**
     * Wraps the real player so ⏮ / ⏭ mean episode navigation.
     *
     * THE BUG: this previously advertised a fixed command set and left hasNextMediaItem() to the
     * wrapped player, which has a single-item playlist and therefore always answered false.
     * PlayerControlView and DefaultMediaNotificationProvider decide whether the NEXT control is
     * usable from that state, so it stayed dead — while PREVIOUS worked, because seeking to
     * previous is always permitted (at worst it restarts the current item). Both are now derived
     * from the cached /api/upnext result, and the session is told when that arrives so controllers
     * refresh instead of holding the connect-time snapshot.
     */
    private inner class TransportForwardingPlayer(player: Player) :
        androidx.media3.common.ForwardingPlayer(player) {

        /**
         * Starts from the real player's set and only ever touches the previous/next pairs.
         * Everything else — crucially COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, which is what enables
         * the scrub bar — passes straight through untouched.
         */
        override fun getAvailableCommands(): Player.Commands {
            val hasNext = transportNext != null
            val builder = Player.Commands.Builder().addAll(super.getAvailableCommands())
            TransportPolicy.addedCommands(hasNext).forEach { builder.add(it) }
            TransportPolicy.removedCommands(hasNext).forEach { builder.remove(it) }
            return builder.build()
        }

        override fun isCommandAvailable(command: Int): Boolean = when (command) {
            Player.COMMAND_SEEK_TO_PREVIOUS,
            Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> TransportPolicy.previousAvailable()
            Player.COMMAND_SEEK_TO_NEXT,
            Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> TransportPolicy.nextAvailable(transportNext != null)
            // Seeking within the item, and everything else, is the real player's answer to give.
            else -> super.isCommandAvailable(command)
        }

        override fun seekToPrevious() = handlePrevious()
        override fun seekToPreviousMediaItem() = handlePrevious()
        override fun seekToNext() = handleNext()
        override fun seekToNextMediaItem() = handleNext()

        /** Both reflect the cache, not the one-item playlist underneath. */
        override fun hasPreviousMediaItem(): Boolean = TransportPolicy.previousAvailable()
        override fun hasNextMediaItem(): Boolean = TransportPolicy.nextAvailable(transportNext != null)
    }

    /**
     * Keeps the MediaSession's view of the cast player stable.
     *
     * Media3 removes the media notification - stopForeground(STOP_FOREGROUND_REMOVE) plus
     * NotificationManager.cancel, in MediaNotificationManager.shouldShowNotification - whenever
     * the session's player reports STATE_IDLE or an empty timeline. It does NOT merely make the
     * notification dismissible; it deletes it, and Android's own media control in the shade goes
     * with it because the legacy PlaybackState maps STATE_IDLE to STATE_NONE.
     *
     * A CastPlayer reports exactly that whenever the receiver's MediaStatus is absent - see
     * CastPlayer.updateTimeline and CastPlayer.fetchPlaybackState, both of which collapse to
     * empty / IDLE when RemoteMediaClient.getMediaStatus() returns null. The Default Media
     * Receiver drops its MediaStatus when it unloads paused media, which is why pausing a cast
     * took the transport controls away with no way back except reopening the video.
     *
     * So: for as long as the cast SESSION is up, keep reporting the last real timeline, item and
     * position, and never report IDLE. Pressing play then re-loads the item on the receiver if it
     * really did drop it, so the shade's play button resumes the film instead of doing nothing.
     */
    private inner class CastStabilisingPlayer(private val receiver: CastReceiver) :
        androidx.media3.common.ForwardingPlayer(receiver.player) {

        private val cast: Player = receiver.player

        private var lastTimeline: Timeline = Timeline.EMPTY
        private var lastItem: MediaItem? = null
        private var lastPositionMs: Long = 0L

        /** Seeded at handover, before the receiver has reported anything at all. */
        fun remember(item: MediaItem, positionMs: Long) {
            lastItem = item
            lastPositionMs = positionMs
        }

        private val sessionUp: Boolean
            get() = runCatching { receiver.isSessionAvailable }.getOrDefault(false)

        /** Does the TV currently hold the media, as opposed to having dropped it? */
        private fun remoteHasMedia(): Boolean =
            !cast.currentTimeline.isEmpty() && cast.playbackState != Player.STATE_IDLE

        override fun getCurrentTimeline(): Timeline {
            val live = cast.currentTimeline
            if (!live.isEmpty()) {
                lastTimeline = live
                return live
            }
            return if (sessionUp) lastTimeline else live
        }

        override fun getCurrentMediaItem(): MediaItem? {
            val live = cast.currentMediaItem
            if (live != null) {
                lastItem = live
                return live
            }
            // Not gated on the session still being up: when it ends, endCastHandover reads the
            // item and position from here to carry playback back to the phone.
            return lastItem
        }

        override fun getMediaItemCount(): Int = getCurrentTimeline().windowCount

        override fun getPlaybackState(): Int {
            val state = cast.playbackState
            if (state != Player.STATE_IDLE) return state
            // Still connected to the TV and we know what belongs on it: "ready, paused", not gone.
            return if (sessionUp && getCurrentMediaItem() != null) Player.STATE_READY else state
        }

        override fun getCurrentPosition(): Long {
            if (!remoteHasMedia()) return lastPositionMs
            val live = cast.currentPosition
            if (live > 0L) lastPositionMs = live
            return live
        }

        override fun play() {
            reloadIfRemoteDroppedMedia()
            super.play()
        }

        override fun setPlayWhenReady(playWhenReady: Boolean) {
            if (playWhenReady) reloadIfRemoteDroppedMedia()
            super.setPlayWhenReady(playWhenReady)
        }

        /**
         * Pressing play after the receiver unloaded the media would otherwise do nothing - there
         * is no media on the TV left to resume. Put it back at the last known position first.
         */
        private fun reloadIfRemoteDroppedMedia() {
            if (!sessionUp || remoteHasMedia()) return
            val item = lastItem ?: return
            Log.i(TAG, "Receiver dropped the media; reloading before play")
            runCatching {
                cast.setMediaItem(item, lastPositionMs)
                cast.prepare()
            }
        }
    }

    /* ------------------------------- listener -------------------------------- */

    private val playerListener = object : Player.Listener {

        /**
         * The real player gains COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM the moment it has a seekable
         * timeline, and loses it again between items. Re-publishing here is what keeps the scrub
         * bar in step; without it a controller keeps whatever set it was last given.
         */
        override fun onAvailableCommandsChanged(availableCommands: Player.Commands) {
            publishAvailableCommands()
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            // Our own re-set to add sidecars is the same video carrying on, not a new one.
            val ownReattach = sidecarReattachFor != null && sidecarReattachFor == currentItemId()
            sidecarReattachFor = null
            if (!ownReattach) {
                // A new item means a new history session.
                watchSessionId = null
                watchSessionItemId = null
            }
            refreshTransport()
            publishAvailableCommands()
            // The notification now describes a different video, so its tap target must move too.
            refreshSessionActivity()
            refreshSubtitles()
        }

        override fun onTracksChanged(tracks: Tracks) {
            applyPendingSubtitle()
        }

        override fun onTimelineChanged(timeline: Timeline, reason: Int) {
            // The receiver reporting its queue is the signal that the TV really has the item.
            completeCastHandover(force = false)
        }

        /**
         * Playback stopping for any reason the viewer meant (pause, stop, the end) is the moment
         * the server's mark matters most, so post it now rather than at the next 30 s tick. A
         * rebuffer mid-play also flips isPlaying off, but that is not one of those moments.
         */
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) return
            val player = mediaSession?.player ?: return
            if (player.playbackState == Player.STATE_BUFFERING && player.playWhenReady) return
            saveResumeNow()
            publishLiveProgress(player)
            reportProgressSoon(player, 0L)
            refreshWatchNextSoon()
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            if (reason != Player.DISCONTINUITY_REASON_SEEK) return
            val player = mediaSession?.player ?: return
            reportProgressSoon(player, SEEK_REPORT_DEBOUNCE_MS)
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            completeCastHandover(force = false)
            // Seekability settles as the player leaves BUFFERING, so refresh here too.
            if (playbackState == Player.STATE_READY) {
                publishAvailableCommands()
                refreshSessionActivity()
            }
            if (playbackState == Player.STATE_ENDED) {
                // Finished: clear the resume mark so it doesn't offer to resume the credits,
                // then get out of the notification shade.
                currentItemId()?.let { runCatching { app.resume.clear(it) } }
                if (BackgroundPlaybackPolicy.shouldStopServiceOnEnded() && !isCasting) {
                    stopSelfSafely()
                }
            }
        }
    }

    /* -------------------------------- callback -------------------------------- */

    /**
     * MediaItems set by our own Activity already carry a URI, so we simply accept them.
     * Without this the default callback rejects controller-supplied playlists.
     */
    private inner class SessionCallback : MediaSession.Callback {
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>
        ): ListenableFuture<MutableList<MediaItem>> {
            // "Hey Google, play Heat on Beebo" while Beebo's session is up: Assistant (and any
            // other controller) sends a spoken search instead of an item. Resolve it against the
            // library; a search nothing matches fails the future rather than playing a guess.
            if (mediaItems.any { it.localConfiguration == null && it.requestMetadata.searchQuery != null }) {
                val future = com.google.common.util.concurrent.SettableFuture.create<MutableList<MediaItem>>()
                scope.launch {
                    try {
                        val out = mutableListOf<MediaItem>()
                        for (item in mediaItems) {
                            val spoken = item.requestMetadata.searchQuery
                            if (item.localConfiguration != null || spoken == null) { out += item; continue }
                            val q = com.beeboentertainment.movie.core.VoiceSearch.parse(spoken)
                            val t = com.beeboentertainment.movie.voice.VoiceLibrary.resolve(q)
                                ?: throw java.io.IOException("Nothing in the library matches \"$spoken\"")
                            out += MediaItemFactory.build(t.streamUrl, t.itemId, t.kind, t.title, t.posterUrl, offline = false)
                        }
                        future.set(out)
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        Log.w(TAG, "voice search failed: ${e.message}")
                        future.setException(e)
                    }
                }
                return future
            }
            val resolved = mediaItems.map { item ->
                if (item.localConfiguration == null) item.buildUpon().setUri(Uri.EMPTY).build()
                // Already casting and the app starts something else (the next episode, another
                // film): the TV needs an address it can reach, exactly as it did at handover.
                // Without this the TV would be handed the phone's own private address for the
                // home computer and would simply stall.
                else if (isCasting) castableItem(item) ?: item
                else item
            }.toMutableList()
            return Futures.immediateFuture(resolved)
        }
    }

    /** Helper for the Activity: bundle the per-item extras the service reads back. */
    object Extras {
        fun bundle(itemId: String, kind: String): Bundle = Bundle().apply {
            putString(EXTRA_ITEM_ID, itemId)
            putString(EXTRA_KIND, kind)
        }
    }
}
