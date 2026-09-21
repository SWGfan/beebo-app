package com.beeboentertainment.movie.campsite

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.music.MusicClient
import com.beeboentertainment.movie.music.MusicMedia
import com.beeboentertainment.movie.music.MusicPlayer
import com.beeboentertainment.movie.music.MusicStreamRules
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File

/**
 * The host phone's side of "Play together": takes what is queued in the Music player, gets the
 * songs onto this phone's disk (guests download them from here over the local Wi-Fi, so the
 * internet or the home computer is only needed once, up front), and drives [CampsiteMusicHub].
 *
 * The host phone is the conductor, not a speaker: starting a session pauses this phone's own Music
 * player so the same song is not playing twice a few milliseconds apart. (Playing on this phone
 * too, in sync, is a follow-up; see docs/CAMPSITE-SYNCED-AUDIO.md.)
 *
 * Guests can only ever download tracks that are in the current queue, so this cache is never a
 * window onto the whole library.
 */
internal object CampsiteMusicHost {

    data class GuestLine(
        val id: String,
        val name: String,
        val role: MusicRole,
        val unlocked: Boolean,
        val ready: Boolean,
        /** 0 green, 1 amber, 2 red, 3 not playing yet. */
        val level: Int,
        val detail: String,
    )

    data class View(
        val serverRunning: Boolean = false,
        val state: String = "idle",
        val title: String = "",
        val artist: String = "",
        val index: Int = 0,
        val queueSize: Int = 0,
        val positionMs: Long = 0,
        val durationMs: Long = 0,
        val guests: List<GuestLine> = emptyList(),
        /** A progress or problem message for the host ("Getting your songs ready..."). */
        val message: String? = null,
    )

    private val _view = MutableStateFlow(View())
    val view: StateFlow<View> = _view.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val downloadLock = Mutex()
    @Volatile private var hub: CampsiteMusicHub? = null
    private var pollJob: Job? = null
    private var prefetchJob: Job? = null
    private var setupJob: Job? = null
    private val cache by lazy { CampsiteMusicCache(File(BeeboApp.instance.cacheDir, "campsite-music")) }
    private val main = Handler(Looper.getMainLooper())

    /** The file lookup [CampsiteServer] uses to answer a guest's download. */
    fun fileFor(trackId: String): File? = cache.fileFor(trackId)

    fun attach(newHub: CampsiteMusicHub) {
        hub = newHub
        _view.value = View(serverRunning = true)
        pollJob?.cancel()
        pollJob = scope.launch {
            while (isActive) {
                // Nothing watches the host screen most of the time; do no work then.
                _view.subscriptionCount.first { it > 0 }
                refresh()
                delay(500)
            }
        }
        // Keep the current song and the next two on disk, whoever is looking.
        prefetchJob?.cancel()
        prefetchJob = scope.launch {
            while (isActive) {
                val h = hub ?: break
                val wanted = h.engine.wantedTrackIds()
                if (wanted.isNotEmpty()) {
                    for (id in wanted) if (isActive && !ensureFile(id)) break
                    cache.trim(wanted.toSet())
                }
                delay(1_000)
            }
        }
    }

    fun detach() {
        pollJob?.cancel(); pollJob = null
        prefetchJob?.cancel(); prefetchJob = null
        setupJob?.cancel(); setupJob = null
        hub = null
        runCatching { cache.clear() }
        _view.value = View()
    }

    private fun refresh() {
        val h = hub ?: return
        val s = h.engine.summary()
        _view.value = View(
            serverRunning = true,
            state = s.state.wire,
            title = s.track?.title.orEmpty(),
            artist = s.track?.artist.orEmpty(),
            index = s.index,
            queueSize = s.queueSize,
            positionMs = s.positionMs,
            durationMs = s.durationMs,
            guests = h.guests().map { g ->
                val err = g.errorMs + kotlin.math.abs(g.driftMs)
                GuestLine(
                    g.id, g.name, g.role, g.unlocked, g.ready,
                    level = when {
                        !g.unlocked || g.state != "playing" -> 3
                        err <= CampsiteMusicHub.SYNC_GOOD_MS -> 0
                        err <= 80 -> 1
                        else -> 2
                    },
                    detail = when {
                        !g.unlocked -> "waiting for a tap"
                        g.state == "playing" && g.errorMs.isFinite() -> "±${err.toInt().coerceAtLeast(1)} ms"
                        g.ready -> "ready"
                        else -> g.state
                    },
                )
            },
            message = _view.value.message,
        )
    }

    private fun say(text: String?) { _view.value = _view.value.copy(message = text) }

    // ---- host actions -----------------------------------------------------------------------

    /** Play what the Music player has queued (the current song and everything after it) on every guest phone. */
    fun playTogether(withHeadphones: Boolean = false) {
        val h = hub ?: return
        if (quietRefuses(withHeadphones)) return
        setupJob?.cancel()
        setupJob = scope.launch {
            val st = MusicPlayer.state.value
            val ids = (listOfNotNull(st.trackId) + st.upNext.mapNotNull { MusicMedia.trackId(it.item) }).distinct().take(CampsiteMusicEngine.MAX_QUEUE)
            if (ids.isEmpty()) { say("Start a song in Music first, then come back and tap Play together."); return@launch }
            say("Getting your songs ready...")
            val tracks = try {
                MusicClient.get().tracksByIds(ids).items
            } catch (e: Exception) {
                say("Couldn't reach your Beebo computer to look up those songs."); return@launch
            }
            val all = tracks.map { MusicTrackInfo(it.id, it.title, it.artist, it.album, ((it.duration ?: 0.0) * 1000).toLong()) }
            val playable = CampsiteMusicEngine.sanitize(all)
            if (playable.isEmpty()) { say("None of those songs can be played together (too long, or missing a length)."); return@launch }
            if (!ensureFile(playable[0].id)) { say("Couldn't download the first song from your Beebo computer."); return@launch }
            // This phone is the conductor: hush its own player so the song is not doubled.
            if (st.isPlaying) main.post { MusicPlayer.togglePlay() }
            h.load(playable)
            val skipped = all.size - playable.size
            say(if (skipped > 0) "$skipped song${if (skipped == 1) "" else "s"} skipped (too long for phones to hold)." else null)
        }
    }

    /**
     * Quiet hours (Family Pack A): music for the whole camp is not started out loud at night. The host
     * may confirm everyone is on headphones ([withHeadphones]); otherwise the message says what to do.
     * True means "refused, do not play".
     */
    private fun quietRefuses(withHeadphones: Boolean): Boolean {
        val quiet = com.beeboentertainment.movie.campsite.quiet.QuietGate.runtime
        if (withHeadphones && quiet.isQuiet()) quiet.headphonesConfirmed = true
        if (quiet.musicDecision() == com.beeboentertainment.movie.campsite.quiet.MusicDecision.REFUSE) {
            say(com.beeboentertainment.movie.campsite.quiet.QuietMusicPolicy.REFUSED_MESSAGE)
            return true
        }
        return false
    }

    fun play() { if (quietRefuses(false)) return; hub?.play() }
    fun pause() { hub?.pause() }
    fun next() { hub?.next() }
    fun previous() { hub?.previous() }
    fun stop() { hub?.stopMusic(); say(null) }
    fun setRole(guestId: String, role: MusicRole) { hub?.setRole(guestId, role) }

    // ---- getting a song onto this phone ---------------------------------------------------------

    /** True when [id] is on disk (downloading it first if needed). Songs come one at a time. */
    private suspend fun ensureFile(id: String): Boolean {
        if (cache.fileFor(id) != null) return true
        return downloadLock.withLock {
            if (cache.fileFor(id) != null) return@withLock true
            // A failed download is not retried every second: the computer may be unreachable for a while.
            if (System.currentTimeMillis() < (retryAt[id] ?: 0L)) return@withLock false
            val ok = withContext(Dispatchers.IO) { download(id) }
            if (ok) retryAt.remove(id) else { retryAt[id] = System.currentTimeMillis() + RETRY_MS; runCatching { cache.partFor(id).delete() } }
            ok
        }
    }

    private val retryAt = HashMap<String, Long>()

    private fun download(id: String): Boolean {
        val app = BeeboApp.instance
        // Browsers decode MP3, AAC and WAV everywhere; ask the computer to convert anything else.
        val path = MusicStreamRules.withOptions("/api/music/track/$id/stream", listOf("mp3", "aac", "pcm"), "high")
        val url = UrlUtils.endpoint(app.session.baseUrl, path) ?: return false
        val token = app.session.token
        if (token.isNullOrBlank()) return false
        val part = cache.partFor(id)
        return try {
            val request = Request.Builder().url(url).header("Authorization", "Bearer $token").build()
            app.api.okHttp.newCall(request).execute().use { r ->
                if (!r.isSuccessful) return false
                val body = r.body ?: return false
                if (body.contentLength() > MAX_DOWNLOAD_BYTES) return false
                var written = 0L
                part.outputStream().use { out ->
                    body.byteStream().use { input ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            written += n
                            if (written > MAX_DOWNLOAD_BYTES) return false
                            out.write(buf, 0, n)
                        }
                    }
                }
                if (written == 0L) return false
                cache.commit(id, part, CampsiteMusicFiles.extensionFor(r.header("Content-Type")) ?: "bin")
                true
            }
        } catch (e: Exception) {
            Log.w(TAG, "download of $id failed: ${e.message}")
            false
        }
    }

    private const val TAG = "CampsiteMusicHost"
    private const val MAX_DOWNLOAD_BYTES = 90L * 1024 * 1024
    private const val RETRY_MS = 15_000L
}
