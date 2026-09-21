package com.beeboentertainment.movie.podcasts

import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.audio.AudioExtras
import com.beeboentertainment.movie.audio.AudioKind
import com.beeboentertainment.movie.audio.AudioMedia
import com.beeboentertainment.movie.audio.AudioPrefs
import com.beeboentertainment.movie.audiobooks.AudiobookLogic
import com.beeboentertainment.movie.music.MusicPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The podcast side of the app's one audio service. An episode is one item (with the rest of the
 * queue behind it); the position is sent to the computer as it plays so it follows the person to
 * their other devices. The service's notification, lock screen and headset controls are the shared
 * ones (skip back / forward, speed), so nothing here draws them.
 */
object PodcastPlayer {

    /** What the full-screen player shows besides the playing state. */
    data class Session(val episode: EpisodeDto, val queueAfter: List<EpisodeDto>, val chapters: List<AudiobookLogic.Chapter>)

    private val _session = MutableStateFlow<Session?>(null)
    val session: StateFlow<Session?> = _session.asStateFlow()
    private val _sleep = MutableStateFlow<AudiobookLogic.Sleep?>(null)
    val sleep: StateFlow<AudiobookLogic.Sleep?> = _sleep.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var loop: Job? = null
    private var lastPushAt = 0L
    private var lastPushPos = 0.0
    private var wasPlaying = false
    private var currentKey: String? = null
    private var startedAt = 0L
    private const val START_GRACE_MS = 10_000L

    private fun client() = PodcastClient.get()

    /**
     * Play [episode] from [startSec] at [speed], with [queueAfter] following it. Returns false when
     * the address the server gave is not a podcast stream of this server.
     */
    fun start(context: Context, episode: EpisodeDto, queueAfter: List<EpisodeDto>, startSec: Double, speed: Double): Boolean {
        val base = BeeboApp.instance.session.baseUrl
        val all = listOf(episode) + queueAfter.filter { it.key != episode.key }
        val items = all.mapNotNull { e ->
            val path = PodcastLogic.streamPath(e) ?: return@mapNotNull null
            val extras = Bundle().apply {
                putString(AudioExtras.ITEM_ID, e.key)
                putString(AudioExtras.GROUP_ID, e.feedId)
                putInt(AudioExtras.PART_INDEX, 0)
                putDouble(AudioExtras.PART_START_SEC, 0.0)
                putDouble(AudioExtras.PART_DURATION_SEC, e.durationSec)
                putDouble(AudioExtras.TOTAL_DURATION_SEC, e.durationSec)
            }
            AudioMedia.item(AudioKind.PODCAST, "podcast:${e.key}", path, base, PodcastLogic.title(e), e.feedTitle, com.beeboentertainment.movie.server.CoverUrls.external(e.image), extras)
        }
        // The episode itself must be playable; queue entries that are not are just left out.
        if (items.isEmpty() || AudioMedia.itemId(items.first()) != episode.key) return false
        _session.value = Session(episode, queueAfter, emptyList())
        currentKey = episode.key
        lastPushAt = 0L
        lastPushPos = startSec
        wasPlaying = false
        startedAt = SystemClock.elapsedRealtime()
        MusicPlayer.playSpoken(context, items, 0, (startSec * 1000).toLong(), AudiobookLogic.clampSpeed(speed).toFloat())
        scope.launch { loadChapters(episode) }
        ensureLoop()
        return true
    }

    /** The audio service kept playing after the app was reopened: pick the session back up without touching playback. */
    fun attach(context: Context, episode: EpisodeDto, queueAfter: List<EpisodeDto>) {
        if (_session.value?.episode?.key == episode.key) return
        _session.value = Session(episode, queueAfter, emptyList())
        currentKey = episode.key
        lastPushAt = SystemClock.elapsedRealtime()
        lastPushPos = MusicPlayer.state.value.positionMs / 1000.0
        wasPlaying = MusicPlayer.state.value.isPlaying
        startedAt = SystemClock.elapsedRealtime()
        scope.launch { loadChapters(episode) }
        ensureLoop()
    }

    private suspend fun loadChapters(e: EpisodeDto) {
        if (!e.hasChapters) return
        val list = runCatching { withContext(Dispatchers.IO) { client().chapters(e.key) } }.getOrNull() ?: return
        val chapters = PodcastLogic.chapters(list.chapters)
        _session.value = _session.value?.takeIf { it.episode.key == e.key }?.copy(chapters = chapters) ?: _session.value
    }

    fun setSpeed(speed: Double, feedId: String?, forShowOnly: Boolean) {
        val s = AudiobookLogic.clampSpeed(speed)
        MusicPlayer.setSpeed(s.toFloat())
        scope.launch { runCatching { withContext(Dispatchers.IO) { client().setSpeed(s, if (forShowOnly) feedId else null) } } }
    }

    fun skipBack(context: Context) = MusicPlayer.skipSpoken(-AudioPrefs.skipBackSeconds(context))
    fun skipForward(context: Context) = MusicPlayer.skipSpoken(AudioPrefs.skipForwardSeconds(context))

    fun seekToChapter(index: Int) {
        val c = _session.value?.chapters?.getOrNull(index) ?: return
        MusicPlayer.seekToBook(c.start)
    }

    /* ------------------------------ sleep timer ------------------------------ */

    fun sleepInMinutes(minutes: Int) { _sleep.value = AudiobookLogic.sleepMinutes(minutes, System.currentTimeMillis()) }

    fun sleepAtEpisodeEnd(): Boolean {
        val d = _session.value?.episode?.durationSec ?: return false
        _sleep.value = PodcastLogic.sleepAtEpisodeEnd(d) ?: return false
        return true
    }

    fun cancelSleep() { _sleep.value = null; MusicPlayer.setVolume(1f) }

    /* ------------------------------ progress sync ------------------------------ */

    private fun ensureLoop() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            while (_session.value != null) {
                tick()
                delay(1_000)
            }
        }
    }

    private fun tick() {
        val session = _session.value ?: return
        val st = MusicPlayer.state.value
        if (st.kind != AudioKind.PODCAST || !st.hasSong) {
            if (SystemClock.elapsedRealtime() - startedAt < START_GRACE_MS) return
            if (wasPlaying) pushNow(session.episode.key, session.episode.durationSec, force = true)
            wasPlaying = false
            if (_sleep.value != null) cancelSleep()
            _session.value = null
            return
        }
        val key = st.itemId ?: return
        if (key != currentKey) {
            // The queue moved on: the episode that just ended is finished, the next one is now playing.
            val old = session.episode
            if (old.key == currentKey && old.durationSec > 0) pushNow(old.key, old.durationSec, force = true, atEnd = true)
            currentKey = key
            val next = session.queueAfter.firstOrNull { it.key == key }
            if (next != null) {
                _session.value = Session(next, session.queueAfter.dropWhile { it.key != key }.drop(1), emptyList())
                scope.launch { loadChapters(next) }
            }
            lastPushAt = 0L
            lastPushPos = 0.0
        }
        val episode = _session.value?.episode ?: return
        val position = st.positionMs / 1000.0
        val timer = _sleep.value
        if (timer != null) {
            val status = AudiobookLogic.sleepStatus(timer, System.currentTimeMillis(), position)
            if (status.done) { _sleep.value = null; MusicPlayer.pause(); MusicPlayer.setVolume(1f) } else MusicPlayer.setVolume(status.volume)
        }
        val playing = st.isPlaying
        val stopped = wasPlaying && !playing
        wasPlaying = playing
        val due = PodcastLogic.shouldPush(lastPushAt, lastPushPos, SystemClock.elapsedRealtime(), position)
        if (stopped || (playing && due)) pushNow(episode.key, episode.durationSec, force = stopped)
    }

    private fun pushNow(key: String, durationSec: Double, force: Boolean, atEnd: Boolean = false) {
        val position = if (atEnd) durationSec else MusicPlayer.state.value.positionMs / 1000.0
        lastPushAt = SystemClock.elapsedRealtime()
        lastPushPos = position
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { client().saveProgress(key, position, durationSec) } }
        }
    }

    fun stop() {
        val s = _session.value
        if (s != null) pushNow(s.episode.key, s.episode.durationSec, force = true)
        _sleep.value = null
        MusicPlayer.stop()
        MusicPlayer.setVolume(1f)
        _session.value = null
    }
}
