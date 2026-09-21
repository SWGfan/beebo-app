package com.beeboentertainment.movie.audiobooks

import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.audio.AudioExtras
import com.beeboentertainment.movie.audio.AudioKind
import com.beeboentertainment.movie.audio.AudioMedia
import com.beeboentertainment.movie.audio.AudioPrefs
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
import java.util.UUID

/**
 * The audiobook side of the app's one audio service: turns a book into Media3 items (one per file),
 * keeps this listener's place in step with the server, and runs the sleep timer. What is playing
 * is [MusicPlayer]'s (so the notification, lock screen, headset and mini player all work); this
 * object holds what only a book needs: its chapters, the timer, the pending position.
 *
 * Resume is per person and the newest listen wins ([AudiobookLogic.resolveResume]). A position
 * that could not be sent (no signal on the road) is kept on this phone and sent as a batch the next
 * time the server can be reached; the server keeps whichever listen is newest.
 */
object AudiobookPlayer {

    data class Session(
        val book: BookDetail,
        val chapters: List<AudiobookLogic.Chapter>,
        val bookmarks: List<BookmarkDto>,
    )

    private val _session = MutableStateFlow<Session?>(null)
    val session: StateFlow<Session?> = _session.asStateFlow()

    private val _sleep = MutableStateFlow<AudiobookLogic.Sleep?>(null)
    val sleep: StateFlow<AudiobookLogic.Sleep?> = _sleep.asStateFlow()

    /** Set while a push is failing: shown as a quiet "not saved yet" note. */
    private val _unsaved = MutableStateFlow(false)
    val unsaved: StateFlow<Boolean> = _unsaved.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var loop: Job? = null
    private var lastPushAt = 0L
    private var lastPushPos = 0.0
    private var wasPlaying = false
    private var pushing = false
    private var startedAt = 0L
    private const val START_GRACE_MS = 10_000L

    private fun app() = BeeboApp.instance
    private fun client() = AudiobookClient.get()

    private fun deviceId(context: Context): String {
        val prefs = context.applicationContext.getSharedPreferences("beebo_audio", Context.MODE_PRIVATE)
        return prefs.getString("device_id", null) ?: ("android-" + UUID.randomUUID().toString().replace("-", "").take(16)).also {
            prefs.edit().putString("device_id", it).apply()
        }
    }

    private fun pending(): PendingPositions {
        val prefs = app().session.plain
        return PendingPositions(object : PendingPositions.StringStore {
            override fun get(key: String) = prefs.getString(key, null)
            override fun put(key: String, value: String) { prefs.edit().putString(key, value).apply() }
            override fun remove(key: String) { prefs.edit().remove(key).apply() }
        }, app().session.userId ?: "none")
    }

    /** What this phone holds for [bookId] that the server may not have. */
    fun localPosition(bookId: String): AudiobookLogic.LocalPosition? = runCatching { pending().get(bookId) }.getOrNull()

    /**
     * Start (or continue) [response]'s book at [startSec]. Returns false when the server sent nothing
     * playable (no parts, or no address that is really this server's audiobook stream).
     */
    fun start(context: Context, response: BookResponse, startSec: Double, speed: Double): Boolean {
        val book = response.book
        val base = app().session.baseUrl
        val ordered = book.parts.sortedBy { it.index }
        val art = AudioMedia.serverArt(base, book.cover, "/api/audiobooks/cover/")
        val items = ordered.mapIndexedNotNull { i, part ->
            val path = AudiobookLogic.streamPath(part) ?: return@mapIndexedNotNull null
            val extras = Bundle().apply {
                putString(AudioExtras.ITEM_ID, book.id)
                putInt(AudioExtras.PART_INDEX, i)
                putDouble(AudioExtras.PART_START_SEC, part.start)
                putDouble(AudioExtras.PART_DURATION_SEC, part.duration)
                putDouble(AudioExtras.TOTAL_DURATION_SEC, book.duration)
                book.seriesId?.let { putString(AudioExtras.GROUP_ID, it) }
            }
            AudioMedia.item(AudioKind.AUDIOBOOK, "book:${book.id}:$i", path, base, book.title, book.author, art, extras)
        }
        if (items.isEmpty() || items.size != ordered.size) return false
        val timeline = AudiobookLogic.parts(book)
        val at = com.beeboentertainment.movie.audio.SpokenTimeline.locate(timeline, startSec)
        _session.value = Session(book, AudiobookLogic.chapters(response.book.chapters), response.bookmarks)
        AudioPrefs.set(context, response.prefs.skipBack, response.prefs.skipForward)
        lastPushAt = 0L
        lastPushPos = startSec
        wasPlaying = false
        startedAt = SystemClock.elapsedRealtime()
        MusicPlayer.playSpoken(context, items, at.index, (at.offset * 1000).toLong(), AudiobookLogic.clampSpeed(speed).toFloat())
        ensureLoop(context)
        return true
    }

    /**
     * The audio service kept playing a book after the app was closed and reopened: pick the session
     * back up (chapters, bookmarks, progress sync, sleep timer) without touching playback.
     */
    fun attach(context: Context, response: BookResponse) {
        if (_session.value?.book?.id == response.book.id) return
        _session.value = Session(response.book, AudiobookLogic.chapters(response.book.chapters), response.bookmarks)
        AudioPrefs.set(context, response.prefs.skipBack, response.prefs.skipForward)
        lastPushAt = SystemClock.elapsedRealtime()
        lastPushPos = MusicPlayer.bookPositionSec()
        wasPlaying = MusicPlayer.state.value.isPlaying
        startedAt = SystemClock.elapsedRealtime()
        ensureLoop(context)
    }

    /** Is [bookId] what the audio service is playing right now? */
    fun isCurrent(bookId: String): Boolean {
        val st = MusicPlayer.state.value
        return st.kind == AudioKind.AUDIOBOOK && st.itemId == bookId
    }

    fun setSpeed(speed: Double) {
        val s = AudiobookLogic.clampSpeed(speed)
        MusicPlayer.setSpeed(s.toFloat())
        scope.launch { runCatching { withContext(Dispatchers.IO) { client().setPrefs(speed = s) } } }
    }

    fun skipBack(context: Context) = MusicPlayer.skipSpoken(-AudioPrefs.skipBackSeconds(context))
    fun skipForward(context: Context) = MusicPlayer.skipSpoken(AudioPrefs.skipForwardSeconds(context))

    fun seekToChapter(index: Int) {
        val c = _session.value?.chapters?.getOrNull(index) ?: return
        MusicPlayer.seekToBook(c.start)
    }

    fun previousChapter() {
        val s = _session.value ?: return
        AudiobookLogic.previousChapterStart(s.chapters, MusicPlayer.bookPositionSec())?.let { MusicPlayer.seekToBook(it) }
    }

    fun nextChapter() {
        val s = _session.value ?: return
        AudiobookLogic.nextChapterStart(s.chapters, MusicPlayer.bookPositionSec())?.let { MusicPlayer.seekToBook(it) }
    }

    /* ------------------------------ sleep timer ------------------------------ */

    fun sleepInMinutes(minutes: Int) {
        _sleep.value = AudiobookLogic.sleepMinutes(minutes, System.currentTimeMillis())
        rememberSleepChoice(minutes, false)
    }

    /** False when the book has no chapters (or the playhead is not inside one). */
    fun sleepAtChapterEnd(): Boolean {
        val s = _session.value ?: return false
        val t = AudiobookLogic.sleepAtChapterEnd(s.chapters, MusicPlayer.bookPositionSec()) ?: return false
        _sleep.value = t
        rememberSleepChoice(0, true)
        return true
    }

    fun cancelSleep() {
        _sleep.value = null
        MusicPlayer.setVolume(1f)
    }

    private fun rememberSleepChoice(minutes: Int, endOfChapter: Boolean) {
        scope.launch { runCatching { withContext(Dispatchers.IO) { client().setPrefs(sleepMinutes = minutes, sleepEndOfChapter = endOfChapter) } } }
    }

    /* ------------------------------ bookmarks ------------------------------ */

    suspend fun addBookmark(note: String): BookmarkDto? {
        val s = _session.value ?: return null
        val made = client().addBookmark(s.book.id, MusicPlayer.bookPositionSec(), note).bookmark ?: return null
        _session.value = _session.value?.let { it.copy(bookmarks = (it.bookmarks + made).sortedBy { b -> b.at }) }
        return made
    }

    suspend fun removeBookmark(id: String) {
        val s = _session.value ?: return
        client().deleteBookmark(s.book.id, id)
        _session.value = _session.value?.let { it.copy(bookmarks = it.bookmarks.filter { b -> b.id != id }) }
    }

    /* ------------------------------ progress sync ------------------------------ */

    /** Send anything this phone is holding (positions saved while the server was out of reach). */
    suspend fun flushPending(context: Context) {
        val store = runCatching { pending() }.getOrNull() ?: return
        val items = store.all()
        if (items.isEmpty()) return
        val ok = runCatching { withContext(Dispatchers.IO) { client().saveBatch(items, deviceId(context)) } }.getOrNull()
        if (ok != null && ok.ok) store.clearSent(items)
    }

    private fun ensureLoop(context: Context) {
        if (loop?.isActive == true) return
        val appContext = context.applicationContext
        loop = scope.launch {
            while (_session.value != null) {
                tick(appContext)
                delay(1_000)
            }
        }
    }

    private fun tick(context: Context) {
        val session = _session.value ?: return
        val st = MusicPlayer.state.value
        val ours = st.kind == AudioKind.AUDIOBOOK && st.itemId == session.book.id
        if (!ours) {
            // The service takes a moment to report the new book after start(); until then the old state is stale.
            if (SystemClock.elapsedRealtime() - startedAt < START_GRACE_MS) return
            // Something else took over the audio service (music, a podcast): the book is no longer "current".
            if (wasPlaying) pushNow(context, session, force = true)
            wasPlaying = false
            if (_sleep.value != null) cancelSleep()
            if (!st.hasSong || st.kind != AudioKind.AUDIOBOOK) _session.value = null
            return
        }
        val position = MusicPlayer.bookPositionSec()

        val timer = _sleep.value
        if (timer != null) {
            val status = AudiobookLogic.sleepStatus(timer, System.currentTimeMillis(), position)
            if (status.done) {
                _sleep.value = null
                MusicPlayer.pause()
                MusicPlayer.setVolume(1f)
            } else {
                MusicPlayer.setVolume(status.volume)
            }
        }

        val playing = st.isPlaying
        val stopped = wasPlaying && !playing
        wasPlaying = playing
        val due = AudiobookLogic.shouldPush(lastPushAt, lastPushPos, SystemClock.elapsedRealtime(), position)
        if (stopped || (playing && due)) pushNow(context, session, force = stopped)
    }

    private fun pushNow(context: Context, session: Session, force: Boolean) {
        val position = MusicPlayer.bookPositionSec()
        val at = System.currentTimeMillis()
        val speed = AudiobookLogic.clampSpeed(MusicPlayer.state.value.speed.toDouble())
        lastPushAt = SystemClock.elapsedRealtime()
        lastPushPos = position
        val local = AudiobookLogic.LocalPosition(session.book.id, position, at, speed)
        // Kept first, so nothing is lost if the app is killed or there is no signal.
        runCatching { pending().put(local) }
        if (pushing && !force) return
        pushing = true
        scope.launch {
            try {
                val answer = withContext(Dispatchers.IO) { client().saveProgress(local.bookId, local.position, local.speed, deviceId(context), local.updatedAt) }
                if (answer.ok) {
                    runCatching { pending().clearSent(listOf(local)) }
                    _unsaved.value = false
                    flushPending(context)
                } else {
                    _unsaved.value = true
                }
            } catch (_: com.beeboentertainment.movie.data.UnauthorizedException) {
                _unsaved.value = true
            } catch (_: Exception) {
                _unsaved.value = true
            } finally {
                pushing = false
            }
        }
    }

    /** Stop playing and forget the session. The position was already saved when playback paused. */
    fun stop() {
        val s = _session.value
        if (s != null) pushNow(BeeboApp.instance, s, force = true)
        _sleep.value = null
        MusicPlayer.stop()
        MusicPlayer.setVolume(1f)
        _session.value = null
    }
}
