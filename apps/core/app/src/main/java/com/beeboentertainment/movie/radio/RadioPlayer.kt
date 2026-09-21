package com.beeboentertainment.movie.radio

import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.audio.AudioExtras
import com.beeboentertainment.movie.audio.AudioKind
import com.beeboentertainment.movie.audio.AudioMedia
import com.beeboentertainment.movie.music.MusicPlayer
import com.beeboentertainment.movie.server.CoverUrls
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
 * The radio side of the app's one audio service. The computer relays the station (and reconnects by
 * itself when it drops), so a station is a session: start it, play the relay, ask now and then what
 * is playing, and stop it (which frees the relay) when done. Only the relay's address is ever
 * played, never the station's own. Because this is the shared service, the notification and lock
 * screen work; what is playing is shown on the app's own screen.
 */
object RadioPlayer {

    data class Now(val station: Station, val session: RadioSession)

    private val _now = MutableStateFlow<Now?>(null)
    val now: StateFlow<Now?> = _now.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var loop: Job? = null
    private var startedAt = 0L
    private const val START_GRACE_MS = 10_000L

    private fun client() = RadioClient.get()

    /** Starts [station]. Throws a ServerException with a reason when the station cannot be reached. */
    suspend fun play(context: Context, station: Station) {
        val old = _now.value
        val session = withContext(Dispatchers.IO) { client().play(station.id).session }
        val path = RadioLogic.streamPath(session) ?: throw java.io.IOException("This Beebo computer sent a radio address the app can't use.")
        val extras = Bundle().apply {
            putString(AudioExtras.ITEM_ID, session.id)
            putString(AudioExtras.GROUP_ID, station.id)
        }
        val item = AudioMedia.item(
            AudioKind.RADIO, "radio:${session.id}", path, BeeboApp.instance.session.baseUrl,
            RadioLogic.name(station), "Live radio", CoverUrls.external(station.favicon), extras
        ) ?: throw java.io.IOException("This Beebo computer sent a radio address the app can't use.")
        _now.value = Now(station, session)
        startedAt = SystemClock.elapsedRealtime()
        MusicPlayer.playSpoken(context, listOf(item), 0, 0L, 1f)
        // Free the relay of whatever station was playing before this one.
        if (old != null && old.session.id != session.id) release(old.session.id)
        ensureLoop()
    }

    /** Play the same station again (after the stream dropped, or a long pause). */
    suspend fun restart(context: Context) {
        val n = _now.value ?: return
        play(context, n.station)
    }

    fun stop() {
        val n = _now.value ?: return
        _now.value = null
        MusicPlayer.stop()
        release(n.session.id)
    }

    private fun release(sessionId: String) {
        scope.launch { runCatching { withContext(Dispatchers.IO) { client().stop(sessionId) } } }
    }

    private fun ensureLoop() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            while (_now.value != null) {
                val n = _now.value ?: break
                val st = MusicPlayer.state.value
                val ours = st.kind == AudioKind.RADIO && st.itemId == n.session.id
                if (!ours && SystemClock.elapsedRealtime() - startedAt > START_GRACE_MS) {
                    // Something else took over the audio service: let the relay go.
                    _now.value = null
                    release(n.session.id)
                    break
                }
                val fresh = runCatching { withContext(Dispatchers.IO) { client().session(n.session.id).session } }.getOrNull()
                if (fresh != null && _now.value?.session?.id == n.session.id) _now.value = Now(n.station, fresh.copy(stream = n.session.stream))
                delay(RadioLogic.pollDelayMs(fresh?.state ?: n.session.state))
            }
        }
    }
}
