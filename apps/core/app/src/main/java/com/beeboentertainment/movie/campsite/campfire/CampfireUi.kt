package com.beeboentertainment.movie.campsite.campfire

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.campsite.games.CampsiteHistoryStore
import com.beeboentertainment.movie.campsite.games.MatchPlayer
import com.beeboentertainment.movie.campsite.games.MatchRecord
import com.beeboentertainment.movie.tts.chunkForSpeech
import java.util.Locale
import java.util.UUID

/*
 * Shared pieces for the offline campfire activities (Sep 16): Hot Potato, Nature Bingo
 * and Campfire Stories on the host phone. None of these needs the campsite server, the
 * hotspot, or a network connection.
 */

/** Text size steps the A- / A+ buttons move through, on top of the system font scale. */
internal val TEXT_STEPS = listOf(0.85f, 1f, 1.2f, 1.45f, 1.75f)

/**
 * The frame every campfire screen sits in: an optional dim red "night" palette for
 * reading around a fire without ruining anyone's night vision, and a text-size
 * multiplier that respects (multiplies) the phone's own accessibility font scale.
 */
@Composable
internal fun CampfireFrame(night: Boolean, textStep: Int, content: @Composable () -> Unit) {
    val base = LocalDensity.current
    val scale = TEXT_STEPS[textStep.coerceIn(0, TEXT_STEPS.lastIndex)]
    val density = Density(base.density, base.fontScale * scale)
    val scheme = if (night) NIGHT_SCHEME else MaterialTheme.colorScheme
    CompositionLocalProvider(LocalDensity provides density) {
        MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography, shapes = MaterialTheme.shapes) {
            Box(Modifier.fillMaxSize().background(scheme.background)) { content() }
        }
    }
}

/** Deep red on near-black: dim, low-blue light that is kind to eyes adjusted to the dark. */
private val NIGHT_SCHEME = darkColorScheme(
    primary = Color(0xFFC23B2E),
    onPrimary = Color(0xFF140000),
    primaryContainer = Color(0xFF3A0B07),
    onPrimaryContainer = Color(0xFFE0685B),
    secondary = Color(0xFFA8392D),
    onSecondary = Color(0xFF140000),
    secondaryContainer = Color(0xFF2E0906),
    onSecondaryContainer = Color(0xFFD45A4C),
    tertiary = Color(0xFFB0433A),
    background = Color(0xFF070101),
    onBackground = Color(0xFFB8463B),
    surface = Color(0xFF0E0202),
    onSurface = Color(0xFFB8463B),
    surfaceVariant = Color(0xFF1E0504),
    onSurfaceVariant = Color(0xFF94382F),
    surfaceContainer = Color(0xFF160303),
    surfaceContainerHigh = Color(0xFF1C0404),
    surfaceContainerHighest = Color(0xFF220505),
    surfaceContainerLow = Color(0xFF120303),
    outline = Color(0xFF5E1D17),
    outlineVariant = Color(0xFF3E120E),
    error = Color(0xFFE0685B),
)

/** Night mode and text size controls, shown at the top of each campfire screen. */
@Composable
internal fun CampfireDisplayBar(
    night: Boolean,
    onNight: (Boolean) -> Unit,
    textStep: Int,
    onTextStep: (Int) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedButton(onClick = { onNight(!night) }) { Text(if (night) "Normal colours" else "Night red") }
        OutlinedButton(
            onClick = { onTextStep((textStep - 1).coerceAtLeast(0)) },
            enabled = textStep > 0,
            modifier = Modifier.semantics { contentDescription = "Smaller text" },
        ) { Text("A−") }
        OutlinedButton(
            onClick = { onTextStep((textStep + 1).coerceAtMost(TEXT_STEPS.lastIndex)) },
            enabled = textStep < TEXT_STEPS.lastIndex,
            modifier = Modifier.semantics { contentDescription = "Larger text" },
        ) { Text("A+") }
    }
}

/** A collapsible "How to play" card. */
@Composable
internal fun HowToPlayCard(steps: List<String>, note: String? = null) {
    var open by rememberSaveable { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            TextButton(onClick = { open = !open }) { Text(if (open) "Hide how to play" else "How to play") }
            if (open) {
                steps.forEachIndexed { i, step ->
                    Text("${i + 1}. $step", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(vertical = 3.dp))
                }
                if (note != null) {
                    Text(note, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(top = 8.dp, bottom = 8.dp))
                }
            }
        }
    }
}

/**
 * Read-aloud with the phone's built-in [TextToSpeech] engine - the same on-device voice
 * the Star Chart and Read It To Me use, so it works in airplane mode. Speed is set per
 * call. Created when the screen opens and shut down when it closes; a phone with no
 * engine simply stays quiet.
 */
internal class CampfireVoice(context: Context) {
    private var engine: TextToSpeech? = null
    @Volatile private var ready = false
    @Volatile private var released = false
    @Volatile private var pending: Pair<String, Float>? = null

    init {
        engine = runCatching {
            TextToSpeech(context.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    ready = true
                    runCatching { engine?.language = Locale.getDefault() }
                    pending?.let { (text, rate) -> pending = null; speak(text, rate) }
                }
            }
        }.getOrNull()
    }

    fun speak(text: String, rate: Float = 1f) {
        if (released) return
        val t = text.trim()
        if (t.isEmpty()) return
        val e = engine ?: return
        if (!ready) { pending = t to rate; return }
        runCatching {
            e.setSpeechRate(rate.coerceIn(0.5f, 2f))
            chunkForSpeech(t).forEachIndexed { i, chunk ->
                e.speak(chunk, if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, "campfire-$i")
            }
        }
    }

    fun stop() {
        pending = null
        runCatching { engine?.stop() }
    }

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

@Composable
internal fun rememberCampfireVoice(): CampfireVoice {
    val context = LocalContext.current
    val voice = remember { CampfireVoice(context) }
    DisposableEffect(voice) { onDispose { voice.release() } }
    return voice
}

/**
 * A short alarm that respects the phone's ringer: sound and vibration when the ringer is
 * on, vibration only on vibrate, and nothing at all on silent (the screen still flashes).
 */
internal object CampfireAlarm {
    fun ring(context: Context, sound: Boolean = true) {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val mode = audio?.ringerMode ?: AudioManager.RINGER_MODE_NORMAL
        if (sound && mode == AudioManager.RINGER_MODE_NORMAL) {
            runCatching {
                // The notification stream follows the ringer volume and Do Not Disturb.
                val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 100)
                tone.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 900)
                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ runCatching { tone.release() } }, 1_200)
            }
        }
        if (mode != AudioManager.RINGER_MODE_SILENT) vibrate(context)
    }

    private fun vibrate(context: Context) {
        runCatching {
            val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= 31) {
                (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
            if (vibrator?.hasVibrator() != true) return
            val pattern = longArrayOf(0, 350, 120, 350, 120, 600)
            if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
            else @Suppress("DEPRECATION") vibrator.vibrate(pattern, -1)
        }
    }
}

/**
 * Save a finished offline match to the same match history the guest games use, so the
 * results show up in "Recent games" and the standings. Only real named players count;
 * a game on one phone has no bots in it.
 */
internal object CampfireHistory {
    fun record(
        gameId: String,
        title: String,
        scores: Map<String, Int>,
        winner: String?,
        startedAt: Long,
        rated: Boolean = true,
        outcome: String = if (winner.isNullOrBlank()) "scores" else "winner",
    ) {
        runCatching {
            val now = System.currentTimeMillis()
            CampsiteHistoryStore(BeeboApp.instance.session).record(
                MatchRecord(
                    id = UUID.randomUUID().toString().take(12),
                    game = gameId,
                    title = title,
                    players = scores.map { (name, score) -> MatchPlayer(name = name, score = score, won = name == winner) },
                    winner = winner.orEmpty(),
                    outcome = outcome,
                    endedAt = now,
                    durationMs = (now - startedAt).coerceAtLeast(0L),
                    rated = rated,
                ),
            )
        }
    }
}
