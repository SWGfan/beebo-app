package com.beeboentertainment.movie.campsite.quiet

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.beeboentertainment.movie.party.campfire.AmbiencePlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * The phone side of Bedtime Wind-Down: a real voice (the phone's own text-to-speech, on device) and
 * the real ambience player, driven by the pure [WindDownRunner] once a second.
 *
 * It deliberately does NOT go through the campsite narrator gate: Wind-Down is the host choosing
 * gentle sound at bedtime, on purpose, at a low level. Quiet hours silence everything else.
 *
 * Needs a real phone to check: how long the voice takes, how it behaves with the screen off, and how
 * gentle the level is on the phone's speaker. See docs/CAMPSITE-FAMILY-PACK-A.md.
 */
internal object WindDownController {

    data class Ui(
        val phase: WindDownPhase = WindDownPhase.IDLE,
        val remainingMs: Long = 0L,
        val storyTitle: String = "",
    )

    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var job: Job? = null
    private var audio: WindDownAudio? = null
    private var runner: WindDownRunner? = null

    fun start(context: Context, config: WindDownConfig) {
        if (runner?.running == true) return
        val sound = WindDownAudio(context.applicationContext) { runner?.storyFinished(System.currentTimeMillis()) }
        audio = sound
        val r = WindDownRunner(sound)
        runner = r
        r.start(System.currentTimeMillis(), config)
        publish(r)
        job?.cancel()
        job = scope.launch {
            while (isActive) {
                delay(1_000)
                r.tick(System.currentTimeMillis())
                publish(r)
                if (!r.running) break
            }
            // Finished by itself: nothing may be left playing.
            sound.release()
            if (audio === sound) audio = null
        }
    }

    /** The visible Cancel. */
    fun cancel() {
        val r = runner ?: return
        r.cancel()
        publish(r)
        job?.cancel()
        job = null
        audio?.release()
        audio = null
    }

    private fun publish(r: WindDownRunner) {
        _ui.value = Ui(r.phase, r.remainingMs(System.currentTimeMillis()), r.storyTitle)
    }
}

/** On-device voice and the ambience player behind [WindDownEffects]. Main thread only, except TTS callbacks. */
private class WindDownAudio(private val context: Context, private val onStoryDone: () -> Unit) : WindDownEffects {
    private val main = Handler(Looper.getMainLooper())
    private var engine: TextToSpeech? = null
    @Volatile private var ready = false
    @Volatile private var released = false
    private var pending: String? = null
    private val ambience = AmbiencePlayer(context)

    init {
        engine = runCatching {
            TextToSpeech(context) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    ready = true
                    runCatching {
                        engine?.language = Locale.getDefault()
                        engine?.setSpeechRate(0.82f)
                        engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                            override fun onStart(utteranceId: String?) {}
                            override fun onDone(utteranceId: String?) {
                                if (utteranceId == LAST_ID) main.post { if (!released) onStoryDone() }
                            }
                            @Deprecated("Deprecated in Java")
                            override fun onError(utteranceId: String?) {
                                if (utteranceId == LAST_ID) main.post { if (!released) onStoryDone() }
                            }
                        })
                    }
                    pending?.let { text -> pending = null; main.post { speak(text) } }
                } else {
                    // No voice on this phone: skip the story rather than waiting for it.
                    main.post { if (!released) onStoryDone() }
                }
            }
        }.getOrNull()
        if (engine == null) main.post { if (!released) onStoryDone() }
    }

    override fun speak(text: String) {
        if (released) return
        if (!ready) { pending = text; return }
        val e = engine ?: return
        val parts = split(text)
        runCatching {
            parts.forEachIndexed { i, part ->
                val id = if (i == parts.lastIndex) LAST_ID else "wd-$i"
                val params = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 0.7f) }
                e.speak(part, if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, params, id)
            }
        }
    }

    override fun stopSpeaking() {
        pending = null
        runCatching { engine?.stop() }
    }

    override fun startAmbience(id: String) {
        if (released) return
        ambience.apply(id, true)
    }

    override fun setAmbienceVolume(level: Float) {
        if (released) return
        ambience.setVolume(level)
    }

    override fun stopAmbience() {
        ambience.stop()
    }

    fun release() {
        released = true
        pending = null
        runCatching { engine?.stop() }
        runCatching { engine?.shutdown() }
        engine = null
        ambience.stop()
        ambience.release()
    }

    private fun split(text: String): List<String> {
        val out = ArrayList<String>()
        val sentence = StringBuilder()
        text.split(". ").forEach { piece ->
            val s = piece.trim()
            if (s.isEmpty()) return@forEach
            if (sentence.length + s.length > 220 && sentence.isNotEmpty()) { out += sentence.toString().trim(); sentence.clear() }
            sentence.append(s).append(if (s.endsWith(".") || s.endsWith("?") || s.endsWith("!")) " " else ". ")
        }
        if (sentence.isNotBlank()) out += sentence.toString().trim()
        return out.ifEmpty { listOf(text) }
    }

    private companion object {
        const val LAST_ID = "wd-last"
    }
}
