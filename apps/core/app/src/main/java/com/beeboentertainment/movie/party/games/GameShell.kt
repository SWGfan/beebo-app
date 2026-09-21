package com.beeboentertainment.movie.party.games

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * One tap-answer choice in a [GameShell]: a stable [id] used on the wire, and the [label]
 * the player sees.
 */
@kotlinx.serialization.Serializable
data class GameOption(val id: String, val label: String)

/**
 * A small, reusable shell for a synced "everyone taps, then reveal" party game.
 *
 * It owns none of the game's rules or networking — it is pure presentation with three
 * stacked regions so every future game looks and feels the same:
 *
 *  1. **Prompt area** — a headline plus the current [prompt] (or a waiting hint).
 *  2. **Tap-answer row** — one big button per [GameOption]; tapping calls [onSelect].
 *     Two options sit side by side; three or more stack. The current [selectedId] is
 *     outlined, and taps are ignored while [locked].
 *  3. **Results / reveal** — once [revealed] each option shows its tally from [results]
 *     with a proportion bar, plus an "N of M answered" line.
 *
 * [controls] is an optional slot at the bottom for game-specific host buttons (new
 * prompt, reveal, …) so the shell never has to know what drives it.
 */
@Composable
fun GameShell(
    headline: String,
    status: String,
    prompt: String?,
    options: List<GameOption>,
    selectedId: String?,
    locked: Boolean,
    revealed: Boolean,
    results: Map<String, Int>,
    totalPlayers: Int,
    totalAnswered: Int,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    correctOptionId: String? = null,
    compactOptions: Boolean = false,
    beforeOptions: @Composable () -> Unit = {},
    controls: @Composable () -> Unit = {},
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // ---- Prompt area -------------------------------------------------------
        Text(headline, style = MaterialTheme.typography.titleLarge)
        Text(
            status,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(20.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .heightIn(min = 96.dp)
                .padding(20.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                prompt ?: "Waiting for a prompt…",
                textAlign = TextAlign.Center,
                fontSize = if (prompt != null) 26.sp else 18.sp,
                fontWeight = FontWeight.Bold,
                color = if (prompt != null) MaterialTheme.colorScheme.onSurfaceVariant
                else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            )
        }

        beforeOptions()

        // ---- Tap-answer row ----------------------------------------------------
        val maxCount = (results.values.maxOrNull() ?: 0).coerceAtLeast(1)
        if (options.size == 2) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                options.forEach { opt ->
                    AnswerButton(
                        option = opt,
                        selected = opt.id == selectedId,
                        correct = revealed && opt.id == correctOptionId,
                        showCorrectness = revealed && correctOptionId != null,
                        compact = compactOptions,
                        locked = locked,
                        revealed = revealed,
                        count = results[opt.id] ?: 0,
                        maxCount = maxCount,
                        onSelect = onSelect,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                options.forEach { opt ->
                    AnswerButton(
                        option = opt,
                        selected = opt.id == selectedId,
                        correct = revealed && opt.id == correctOptionId,
                        showCorrectness = revealed && correctOptionId != null,
                        compact = compactOptions,
                        locked = locked,
                        revealed = revealed,
                        count = results[opt.id] ?: 0,
                        maxCount = maxCount,
                        onSelect = onSelect,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        // ---- Results / reveal --------------------------------------------------
        Text(
            if (revealed) "Results — $totalAnswered of $totalPlayers answered"
            else "$totalAnswered of $totalPlayers answered so far",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        controls()
    }
}

@Composable
private fun AnswerButton(
    option: GameOption,
    selected: Boolean,
    correct: Boolean,
    showCorrectness: Boolean,
    compact: Boolean,
    locked: Boolean,
    revealed: Boolean,
    count: Int,
    maxCount: Int,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val container = when {
        correct -> scheme.tertiaryContainer
        showCorrectness && selected -> scheme.errorContainer
        selected -> scheme.primaryContainer
        else -> scheme.secondaryContainer
    }
    val onContainer = when {
        correct -> scheme.onTertiaryContainer
        showCorrectness && selected -> scheme.onErrorContainer
        selected -> scheme.onPrimaryContainer
        else -> scheme.onSecondaryContainer
    }
    // Proportion of the winning tally, animated in on reveal.
    val fill by animateFloatAsState(
        targetValue = if (revealed) (count.toFloat() / maxCount) else 0f,
        label = "reveal-fill",
    )

    Box(
        modifier = modifier
            .heightIn(min = if (compact) 88.dp else BUTTON_HEIGHT_DP.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(container)
            .then(
                if (correct) Modifier.border(3.dp, scheme.tertiary, RoundedCornerShape(20.dp))
                else if (selected) Modifier.border(3.dp, scheme.primary, RoundedCornerShape(20.dp))
                else Modifier
            )
            .clickable(enabled = !locked) { onSelect(option.id) },
    ) {
        // Reveal bar grows from the bottom to show relative votes. The button is a
        // fixed 140dp tall, so a fraction of that height is a faithful proportion bar.
        if (revealed && fill > 0f && !compact) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height((BUTTON_HEIGHT_DP * fill).dp)
                    .align(Alignment.BottomCenter)
                    .background(scheme.primary.copy(alpha = 0.22f)),
            )
        }
        Column(
            Modifier
                .fillMaxWidth()
                .padding(16.dp)
                .align(Alignment.Center),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                option.label,
                textAlign = TextAlign.Center,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = onContainer,
            )
            if (showCorrectness && (correct || selected)) {
                Text(if (correct) "✓ Correct answer" else "Your answer · Incorrect",
                    color = onContainer, fontWeight = FontWeight.Bold)
            }
            if (revealed) {
                Spacer(Modifier.height(2.dp))
                Text(
                    if (showCorrectness) { if (count == 1) "1 player chose this" else "$count players chose this" }
                    else if (count == 1) "1 vote" else "$count votes",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Medium,
                    color = onContainer,
                )
            }
        }
    }
}

/** Fixed height of a tap-answer button, shared by the reveal proportion bar. */
private const val BUTTON_HEIGHT_DP = 140f
