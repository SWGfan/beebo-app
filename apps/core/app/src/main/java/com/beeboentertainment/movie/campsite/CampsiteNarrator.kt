package com.beeboentertainment.movie.campsite

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.webkit.JavascriptInterface
import java.util.Locale

/**
 * The host phone's voice for the party games (Campfire Werewolf reads the night out).
 *
 * Same on-device [TextToSpeech] engine the star chart and BeeboSchool use, so it works in
 * airplane mode at a dark campsite. A phone browser's own speech API is not available
 * inside an Android WebView, which is why the games page asks this bridge instead; a
 * guest's browser has no bridge and simply stays silent - only the host narrates.
 *
 * Exposed to the page as `window.BeeboHost`. The WebView it is attached to only ever
 * loads the campsite's own 127.0.0.1 pages (see [GuestGamesScreen]), and the bridge can
 * do exactly three harmless things: say a line, stop talking, and open the invite screen.
 */
internal class CampsiteNarrator(context: Context, private val onInvite: () -> Unit) {
    private var engine: TextToSpeech? = null
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var ready = false
    @Volatile private var released = false
    @Volatile private var pending: String? = null

    init {
        engine = runCatching {
            TextToSpeech(context.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    ready = true
                    runCatching {
                        engine?.language = Locale.getDefault()
                        engine?.setSpeechRate(0.92f)
                    }
                    pending?.let { queued -> pending = null; say(queued) }
                }
            }
        }.getOrNull()
    }

    private fun say(text: String) {
        if (released) return
        // Quiet hours (Family Pack A): the narrator stays silent so the neighbours can sleep.
        if (com.beeboentertainment.movie.campsite.quiet.QuietGate.isQuietNow()) return
        val line = text.filter { !it.isISOControl() }.trim().take(600)
        if (line.isEmpty()) return
        val e = engine ?: return
        if (!ready) { pending = line; return }
        runCatching { e.speak(line, TextToSpeech.QUEUE_FLUSH, null, "campsite-narrator") }
    }

    @JavascriptInterface
    fun speak(text: String?) { say(text.orEmpty()) }

    @JavascriptInterface
    fun stopSpeaking() {
        pending = null
        runCatching { engine?.stop() }
    }

    @JavascriptInterface
    fun canSpeak(): Boolean = engine != null && !released

    /** "Needs other phones - Invite players": opens the host's join QR codes. */
    @JavascriptInterface
    fun invitePlayers() { main.post { if (!released) onInvite() } }

    fun release() {
        released = true
        pending = null
        val e = engine
        engine = null
        ready = false
        runCatching { e?.stop() }
        runCatching { e?.shutdown() }
    }
}
