package com.beeboentertainment.auto.party

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.beeboentertainment.auto.data.Prefs

/**
 * The lip-sync trim control for a watch party.
 *
 * A slider from -500ms to +500ms bound to [Prefs.audioDelayMs], with a live
 * label ("Video +120 ms"), fine -10/+10 nudge buttons for the last few frames
 * of alignment, and a Reset. The stored range in [Prefs] is wider
 * (±1000ms) than what the slider exposes; the nudge buttons still clamp to the
 * slider's ±500ms so the thumb never runs off the track.
 *
 * It writes straight to [Prefs] on every change — [PartyController] reads
 * `Prefs.audioDelayMs` fresh on each seek/sync, so a drag re-aligns the picture
 * within a beat or two with no extra wiring. [onValueChange] is an optional hook
 * for a caller that wants to react immediately (e.g. force a re-lock).
 */
@Composable
fun AudioDelaySlider(
    prefs: Prefs,
    modifier: Modifier = Modifier,
    onValueChange: (Int) -> Unit = {},
) {
    var delay by remember { mutableIntStateOf(prefs.audioDelayMs) }

    fun update(newValue: Int) {
        val clamped = newValue.coerceIn(SLIDER_MIN, SLIDER_MAX)
        delay = clamped
        prefs.audioDelayMs = clamped
        onValueChange(clamped)
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Audio delay", fontWeight = FontWeight.Bold)
            Text(label(delay), style = MaterialTheme.typography.titleMedium)
        }

        Slider(
            value = delay.toFloat(),
            onValueChange = { update(it.toInt()) },
            valueRange = SLIDER_MIN.toFloat()..SLIDER_MAX.toFloat(),
            // ~5ms granularity: fine enough to matter, coarse enough that the
            // thumb doesn't feel twitchy. The nudge buttons do single-frame work.
            steps = ((SLIDER_MAX - SLIDER_MIN) / 5) - 1,
            modifier = Modifier.fillMaxWidth(),
        )

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = { update(delay - 10) }) { Text("-10 ms") }
            OutlinedButton(onClick = { update(delay + 10) }) { Text("+10 ms") }
            TextButton(onClick = { update(0) }) { Text("Reset") }
        }

        Text(
            "Passengers' video only. Nudge until lips match what the car's " +
                "Bluetooth speakers play — that audio arrives a little late, so a " +
                "positive value holds the picture back to meet it.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** e.g. 0 -> "In sync", 120 -> "Video +120 ms", -80 -> "Video -80 ms". */
private fun label(ms: Int): String = when {
    ms == 0 -> "In sync"
    ms > 0 -> "Video +$ms ms"
    else -> "Video $ms ms"
}

private const val SLIDER_MIN = -500
private const val SLIDER_MAX = 500
