package com.beeboentertainment.movie.music

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The app's handle on the Music player: connects to [MusicPlaybackService] with a Media3
 * MediaController and turns its state into one [State] the screens draw from. Every button in
 * the app goes through here; the lock screen, notification and headset talk to the service
 * directly, and the state here follows them.
 */
object MusicPlayer {

    const val EXTRA_OPEN_NOW_PLAYING = "beebo.music.openNowPlaying"

    data class QueueEntry(val index: Int, val item: MediaItem)

    data class State(
        val connected: Boolean = false,
        val current: MediaItem? = null,
        val currentIndex: Int = -1,
        val isPlaying: Boolean = false,
        val buffering: Boolean = false,
        val positionMs: Long = 0L,
        val durationMs: Long = 0L,
        val shuffle: Boolean = false,
        val repeat: MusicQueueLogic.Repeat = MusicQueueLogic.Repeat.OFF,
        /** Songs still to come, in the order they will play (shuffle and repeat applied). */
        val upNext: List<QueueEntry> = emptyList(),
        val error: String? = null,
        /** Off, counting down to a time, or armed for the end of the current track. */
        val sleepTimer: MusicSleepTimerState = MusicSleepTimerState.Off,
        /** What to show for [sleepTimer] right now, or null when it's off. Already formatted. */
        val sleepTimerLabel: String? = null
    ) {
        val hasSong: Boolean get() = current != null
        val trackId: String? get() = MusicMedia.trackId(current)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** Bumped when a notification tap asks for Now Playing; the nav host follows it. */
    private val _openNowPlaying = MutableStateFlow(0)
    val openNowPlaying: StateFlow<Int> = _openNowPlaying.asStateFlow()

    private val main = Handler(Looper.getMainLooper())
    private var future: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val pending = mutableListOf<(MediaController) -> Unit>()
    /** Songs added with "Play next" since the current song started, so the next one queues behind them. */
    private var playNextCount = 0
    private var lastIndex = -1

    fun noteIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_OPEN_NOW_PLAYING, false) == true) {
            intent.removeExtra(EXTRA_OPEN_NOW_PLAYING)
            _openNowPlaying.value = _openNowPlaying.value + 1
        }
    }

    /** Connects once; later calls are free. Screens call this when they appear. */
    fun connect(context: Context) {
        if (controller != null || future != null) return
        val app = context.applicationContext
        val token = SessionToken(app, ComponentName(app, MusicPlaybackService::class.java))
        val f = MediaController.Builder(app, token).buildAsync()
        future = f
        f.addListener({
            val c = runCatching { f.get() }.getOrNull()
            if (c == null) {
                future = null
                return@addListener
            }
            controller = c
            c.addListener(listener)
            pending.toList().forEach { it(c) }
            pending.clear()
            publish()
        }, ContextCompat.getMainExecutor(app))
    }

    private fun withController(context: Context, action: (MediaController) -> Unit) {
        val c = controller
        if (c != null) { action(c); publish(); return }
        pending += action
        connect(context)
    }

    /* ------------------------------- actions ------------------------------- */

    /** Replace the queue with [tracks] and play from [startIndex]; [shuffle] shuffles the rest. */
    fun play(context: Context, tracks: List<MusicTrack>, startIndex: Int = 0, shuffle: Boolean = false) {
        val items = tracks.mapNotNull { MusicMedia.item(it) }
        if (items.isEmpty()) return
        val start = if (shuffle && startIndex == 0) (items.indices).random() else startIndex.coerceIn(0, items.size - 1)
        withController(context) { c ->
            c.shuffleModeEnabled = false
            c.setMediaItems(items, start, C.TIME_UNSET)
            c.prepare()
            // After the items are in, so the service shuffles around the song that is starting.
            if (shuffle) c.shuffleModeEnabled = true
            c.play()
            playNextCount = 0
        }
    }

    fun playNext(context: Context, track: MusicTrack) {
        val item = MusicMedia.item(track) ?: return
        withController(context) { c ->
            if (c.mediaItemCount == 0) {
                c.setMediaItem(item); c.prepare(); c.play(); return@withController
            }
            c.addMediaItem(MusicQueueLogic.playNextIndex(c.currentMediaItemIndex, c.mediaItemCount, playNextCount), item)
            playNextCount++
        }
    }

    fun addToQueue(context: Context, track: MusicTrack) {
        val item = MusicMedia.item(track) ?: return
        withController(context) { c ->
            if (c.mediaItemCount == 0) {
                c.setMediaItem(item); c.prepare(); c.play(); return@withController
            }
            c.addMediaItem(MusicQueueLogic.addToQueueIndex(c.mediaItemCount), item)
        }
    }

    fun togglePlay() {
        val c = controller ?: return
        if (c.playbackState == Player.STATE_ENDED) c.seekToDefaultPosition(0)
        if (c.isPlaying) c.pause() else { if (c.playbackState == Player.STATE_IDLE) c.prepare(); c.play() }
        publish()
    }

    fun next() { controller?.let { if (it.hasNextMediaItem()) it.seekToNextMediaItem() }; publish() }

    /** Restart the song a few seconds in, otherwise the one before. */
    fun previous() {
        val c = controller ?: return
        when (MusicQueueLogic.previousAction(c.currentPosition, c.hasPreviousMediaItem())) {
            MusicQueueLogic.PreviousAction.RESTART -> c.seekTo(0L)
            MusicQueueLogic.PreviousAction.PREVIOUS -> c.seekToPreviousMediaItem()
        }
        publish()
    }

    fun seekTo(positionMs: Long) { controller?.seekTo(positionMs.coerceAtLeast(0L)); publish() }

    fun toggleShuffle() { controller?.let { it.shuffleModeEnabled = !it.shuffleModeEnabled }; publish() }

    fun cycleRepeat() {
        controller?.let { it.repeatMode = MusicQueueLogic.toMedia3(MusicQueueLogic.nextRepeat(MusicQueueLogic.fromMedia3(it.repeatMode))) }
        publish()
    }

    fun jumpTo(index: Int) {
        val c = controller ?: return
        if (index in 0 until c.mediaItemCount) { c.seekToDefaultPosition(index); c.play() }
        publish()
    }

    fun remove(index: Int) {
        val c = controller ?: return
        if (index in 0 until c.mediaItemCount && index != c.currentMediaItemIndex) c.removeMediaItem(index)
        publish()
    }

    fun stop() {
        controller?.run { stop(); clearMediaItems() }
        publish()
    }

    /* ----------------------------- sleep timer ------------------------------ */

    private var sleepTimer: MusicSleepTimerState = MusicSleepTimerState.Off

    /** Stop playback in [minutes] minutes. Replaces whatever the timer was previously set to. */
    fun startSleepTimer(minutes: Int) {
        sleepTimer = MusicSleepTimer.start(minutes, SystemClock.elapsedRealtime())
        armSleepTimerTicks()
        publish()
    }

    /** Stop playback the next time the current track ends, whichever one that turns out to be. */
    fun startSleepTimerAtEndOfTrack() {
        sleepTimer = MusicSleepTimerState.EndOfTrack
        armSleepTimerTicks()
        publish()
    }

    fun cancelSleepTimer() {
        sleepTimer = MusicSleepTimerState.Off
        main.removeCallbacks(sleepTimerTick)
        publish()
    }

    /** Runs once a second while a timer is armed, whether or not a song is actually playing right
     *  now, so the countdown keeps moving and still fires on schedule if the phone is idle. */
    private val sleepTimerTick = object : Runnable {
        override fun run() {
            if (MusicSleepTimer.hasElapsed(sleepTimer, SystemClock.elapsedRealtime())) {
                sleepTimer = MusicSleepTimerState.Off
                controller?.pause()
                publish()
                return
            }
            publish()
            if (sleepTimer != MusicSleepTimerState.Off) main.postDelayed(this, 1_000)
        }
    }

    private fun armSleepTimerTicks() {
        main.removeCallbacks(sleepTimerTick)
        main.post(sleepTimerTick)
    }

    /** True once, right when the sleep timer stops the current track from advancing further. */
    private fun onTrackEnded() {
        if (MusicSleepTimer.stopsAtTrackEnd(sleepTimer)) {
            sleepTimer = MusicSleepTimerState.Off
            main.removeCallbacks(sleepTimerTick)
            controller?.pause()
        }
    }

    /* -------------------------------- state -------------------------------- */

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = publish()

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            // AUTO is Media3 moving on by itself once a song finishes - a manual skip (Next,
            // tapping the queue, Previous) must never be mistaken for "the track ended".
            if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) onTrackEnded()
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            publish()
            if (controller?.isPlaying == true) main.postDelayed(this, 500)
        }
    }

    private fun playOrder(timeline: Timeline, shuffle: Boolean): IntArray {
        if (timeline.isEmpty) return IntArray(0)
        val out = ArrayList<Int>(timeline.windowCount)
        var i = timeline.getFirstWindowIndex(shuffle)
        while (i != C.INDEX_UNSET && out.size < timeline.windowCount) {
            out += i
            i = timeline.getNextWindowIndex(i, Player.REPEAT_MODE_OFF, shuffle)
        }
        return out.toIntArray()
    }

    private fun publish() {
        val c = controller ?: return
        val index = c.currentMediaItemIndex
        if (index != lastIndex) { lastIndex = index; playNextCount = 0 }
        val repeat = MusicQueueLogic.fromMedia3(c.repeatMode)
        val order = playOrder(c.currentTimeline, c.shuffleModeEnabled)
        val upNext = MusicQueueLogic.upNext(order, index, repeat, limit = 200)
            .filter { it in 0 until c.mediaItemCount }
            .map { QueueEntry(it, c.getMediaItemAt(it)) }
        _state.value = State(
            connected = true,
            current = c.currentMediaItem,
            currentIndex = index,
            isPlaying = c.isPlaying,
            buffering = c.playbackState == Player.STATE_BUFFERING,
            positionMs = c.currentPosition.coerceAtLeast(0L),
            durationMs = c.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0L,
            shuffle = c.shuffleModeEnabled,
            repeat = repeat,
            upNext = upNext,
            error = c.playerError?.let { "This song couldn't be played." },
            sleepTimer = sleepTimer,
            sleepTimerLabel = MusicSleepTimer.label(sleepTimer, SystemClock.elapsedRealtime())
        )
        main.removeCallbacks(ticker)
        if (c.isPlaying) main.postDelayed(ticker, 500)
    }
}
