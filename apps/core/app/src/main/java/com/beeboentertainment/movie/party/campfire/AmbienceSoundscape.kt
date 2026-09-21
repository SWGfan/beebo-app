package com.beeboentertainment.movie.party.campfire

import android.content.Context
import android.media.MediaPlayer

/**
 * One built-in looping ambience for Campfire Mode.
 *
 * [rawResName] is the *name* of a `res/raw` resource (no extension) the audio file will
 * live under once it's added — e.g. dropping `campfire_fire.ogg` into `app/src/main/res/raw/`
 * makes ["fire"] audible. We resolve it by name at runtime (see [AmbiencePlayer.apply]) rather
 * than referencing `R.raw.*` directly, so the app compiles and runs with NO audio files present:
 * Without a file (the normal case today) the sound is made on the phone by [AmbienceSynth], so
 * every ambience is audible. A recorded loop dropped into res/raw under that name takes precedence.
 */
data class Ambience(
    val id: String,
    val label: String,
    val emoji: String,
    val rawResName: String,
)

/** The fixed set of ambiences the host can choose from. Ids are stable — they ride the wire. */
val AMBIENCES: List<Ambience> = listOf(
    Ambience("fire", "Crackling fire", "🔥", "campfire_fire"),
    Ambience("crickets", "Night crickets", "🦗", "campfire_crickets"),
    Ambience("rain", "Gentle rain", "🌧️", "campfire_rain"),
    Ambience("waves", "Ocean waves", "🌊", "campfire_waves"),
)

fun ambienceById(id: String?): Ambience? = id?.let { key -> AMBIENCES.firstOrNull { it.id == key } }

/**
 * A tiny looping player for the ambience soundscape, wrapping a single [MediaPlayer].
 *
 * It is deliberately forgiving: if no audio output can be opened, [apply] reports back `false`
 * so the UI can say so instead of crashing, and the synced *state* (which track, playing or
 * paused) keeps working on every phone.
 *
 * Not thread-safe; call from the main thread (the Compose UI does).
 */
class AmbiencePlayer(private val context: Context) {

    private var player: MediaPlayer? = null
    private var synth: SynthStream? = null
    private var loadedId: String? = null

    /**
     * Bring the player in line with the desired [ambienceId] (null = no track) and [playing]
     * state. Returns true when audio is available for the selection: a bundled file if one was
     * added under res/raw, otherwise the sound made on the phone by [AmbienceSynth].
     */
    @android.annotation.SuppressLint("DiscouragedApi")
    fun apply(ambienceId: String?, playing: Boolean): Boolean {
        if (ambienceId == null) {
            stop()
            return false
        }
        if (ambienceId != loadedId) {
            release()
            loadedId = ambienceId
            val amb = ambienceById(ambienceId) ?: return false
            // Resolve the raw resource by NAME so a missing file is a 0 id, not a build error.
            val resId = context.resources.getIdentifier(amb.rawResName, "raw", context.packageName)
            player = if (resId == 0) null else runCatching {
                MediaPlayer.create(context, resId)?.apply { isLooping = true }
            }.getOrNull()
            if (player == null) synth = SynthStream(AmbienceSynth(amb.id))
        }
        player?.let { p ->
            runCatching {
                if (playing) {
                    if (!p.isPlaying) p.start()
                } else {
                    if (p.isPlaying) p.pause()
                }
            }
            return true
        }
        val s = synth ?: return false
        return s.setPlaying(playing)
    }

    /** Pause and forget the current selection, keeping the player object for reuse. */
    fun stop() {
        runCatching { player?.takeIf { it.isPlaying }?.pause() }
        synth?.setPlaying(false)
    }

    /** Fully release the underlying players. Call from onDispose. */
    fun release() {
        runCatching { player?.release() }
        player = null
        synth?.close()
        synth = null
        loadedId = null
    }
}

/** Streams an [AmbienceSynth] to an AudioTrack on its own thread while playing. */
private class SynthStream(private val synth: AmbienceSynth) {
    @Volatile private var playing = false
    @Volatile private var closed = false
    private var thread: Thread? = null
    private var track: android.media.AudioTrack? = null

    /** False when the device couldn't open an audio output. */
    fun setPlaying(on: Boolean): Boolean {
        if (closed) return false
        playing = on
        if (on && thread == null) {
            val t = runCatching { openTrack() }.getOrNull() ?: return false
            track = t
            thread = Thread({ run(t) }, "campfire-ambience").apply { isDaemon = true; start() }
        }
        return true
    }

    private fun openTrack(): android.media.AudioTrack {
        val rate = synth.sampleRate
        val min = android.media.AudioTrack.getMinBufferSize(
            rate, android.media.AudioFormat.CHANNEL_OUT_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT)
        return android.media.AudioTrack.Builder()
            .setAudioAttributes(
                android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build())
            .setAudioFormat(
                android.media.AudioFormat.Builder()
                    .setSampleRate(rate)
                    .setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT)
                    .build())
            .setBufferSizeInBytes(maxOf(min, rate / 5 * 2))
            .setTransferMode(android.media.AudioTrack.MODE_STREAM)
            .build()
    }

    private fun run(t: android.media.AudioTrack) {
        val buf = ShortArray(synth.sampleRate / 20)
        try {
            while (!closed) {
                if (playing) {
                    if (t.playState != android.media.AudioTrack.PLAYSTATE_PLAYING) t.play()
                    synth.fill(buf)
                    if (t.write(buf, 0, buf.size) < 0) break
                } else {
                    if (t.playState == android.media.AudioTrack.PLAYSTATE_PLAYING) { t.pause(); t.flush() }
                    Thread.sleep(60)
                }
            }
        } catch (_: Exception) {
            // Audio output went away (or the thread was interrupted on close): stop quietly.
        } finally {
            runCatching { t.stop() }
            runCatching { t.release() }
        }
    }

    fun close() {
        closed = true
        playing = false
        thread?.interrupt()
        thread = null
        track = null
    }
}
