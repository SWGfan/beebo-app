package com.beeboentertainment.auto.family

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.io.File
import java.io.IOException
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Turns a [SpokenItem] into a WAV file using the phone's own text-to-speech engine, so the car's
 * media player can play it like any recording and the car's Next and Pause buttons just work.
 *
 * ON THE PHONE ONLY. The text ships inside the app; the engine is the phone's own; the result goes
 * to the app's private cache folder and is used for playback only. Nothing is recorded, nothing
 * leaves the phone, and no microphone is involved: text to speech is output only, and this app has
 * no RECORD_AUDIO permission (a unit test checks the manifest).
 *
 * Some phones' speech engines fetch a voice from the network the first time; that is the engine's
 * own behaviour, not this app's. If no voice is available the render fails with a plain message.
 *
 * Blocking: call from a loader or background thread, never the main thread.
 */
internal class TtsRenderer(context: Context) {

    private val app = context.applicationContext
    private val pending = ConcurrentHashMap<String, CountDownLatch>()
    private val failed = ConcurrentHashMap<String, Boolean>()

    @Volatile private var engine: TextToSpeech? = null
    @Volatile private var ready = false

    /** The rendered file for [item], from the cache if the same words were rendered before. */
    @Synchronized
    fun render(item: SpokenItem): File {
        val dir = File(app.cacheDir, "family-tts").apply { mkdirs() }
        val key = SpeechCache.key(item)
        val out = File(dir, "$key.wav")
        if (out.isFile && out.length() > 44) {
            out.setLastModified(System.currentTimeMillis())
            return out
        }
        val tts = ensureEngine()
        tts.setSpeechRate(item.speechRate)
        val parts = ArrayList<WavPart>()
        val max = runCatching { TextToSpeech.getMaxSpeechInputLength() }.getOrDefault(3900).coerceIn(200, 3900) - 100
        var n = 0
        for (step in item.script.steps) {
            when (step) {
                is Step.Pause -> parts += WavPart.Silence(step.ms)
                is Step.Say -> for (piece in SpeechCache.chunks(step.text, max)) {
                    val part = File(dir, "$key-${n++}.part")
                    try {
                        synthesize(tts, piece, part, "beebo-$key-$n")
                        parts += WavPart.Clip(WavStitcher.parse(part.readBytes()))
                    } finally {
                        part.delete()
                    }
                }
            }
        }
        val bytes = try {
            WavStitcher.stitch(parts)
        } catch (e: IllegalArgumentException) {
            throw IOException(e.message ?: "Could not prepare the voice.", e)
        }
        val tmp = File(dir, "$key.tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(out)) { tmp.delete(); throw IOException("Could not save the voice.") }
        trim(dir)
        return out
    }

    /** Free the engine (the service is going away). */
    @Synchronized
    fun shutdown() {
        runCatching { engine?.shutdown() }
        engine = null
        ready = false
    }

    private fun ensureEngine(): TextToSpeech {
        engine?.takeIf { ready }?.let { return it }
        runCatching { engine?.shutdown() }
        val latch = CountDownLatch(1)
        var status = TextToSpeech.ERROR
        val created = TextToSpeech(app) { s -> status = s; latch.countDown() }
        if (!latch.await(INIT_TIMEOUT_S, TimeUnit.SECONDS) || status != TextToSpeech.SUCCESS) {
            runCatching { created.shutdown() }
            throw IOException("This phone's voice is not ready. Check the phone's text-to-speech settings.")
        }
        created.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { utteranceId?.let { pending.remove(it)?.countDown() } }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                utteranceId?.let { failed[it] = true; pending.remove(it)?.countDown() }
            }
            override fun onError(utteranceId: String?, errorCode: Int) { onError(utteranceId) }
        })
        // The words are English: use an English voice even when the phone is set to another language.
        val wanted = Locale.getDefault().takeIf { it.language == "en" } ?: Locale.US
        val r = created.setLanguage(wanted)
        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
            val fallback = created.setLanguage(Locale.US)
            if (fallback == TextToSpeech.LANG_MISSING_DATA || fallback == TextToSpeech.LANG_NOT_SUPPORTED) {
                runCatching { created.shutdown() }
                throw IOException("This phone has no English voice installed.")
            }
        }
        engine = created
        ready = true
        return created
    }

    private fun synthesize(tts: TextToSpeech, text: String, file: File, id: String) {
        val latch = CountDownLatch(1)
        pending[id] = latch
        failed.remove(id)
        val r = tts.synthesizeToFile(text, Bundle(), file, id)
        if (r != TextToSpeech.SUCCESS) {
            pending.remove(id)
            throw IOException("The phone's voice could not start.")
        }
        if (!latch.await(UTTERANCE_TIMEOUT_S, TimeUnit.SECONDS)) {
            pending.remove(id)
            throw IOException("The phone's voice took too long.")
        }
        if (failed.remove(id) == true || !file.isFile || file.length() < 45) {
            throw IOException("The phone's voice could not make that sound.")
        }
    }

    private fun trim(dir: File) {
        val files = dir.listFiles { f -> f.isFile && f.extension == "wav" } ?: return
        val plan = SpeechCache.trimPlan(files.map { it.name to it.lastModified() })
        plan.forEach { name -> if (!File(dir, name).delete()) Log.w(TAG, "could not delete $name") }
    }

    private companion object {
        const val TAG = "TtsRenderer"
        const val INIT_TIMEOUT_S = 15L
        const val UTTERANCE_TIMEOUT_S = 45L
    }
}
