package com.beeboentertainment.movie.badges

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp

/*
 * "Explorer" badges screen. Earned badges are shown colourful; locked ones are greyed with
 * a one-line "how to earn". Earned state is (re)computed from the existing local stores every time
 * the screen opens (see [BadgeStore.refresh]) and persisted in SessionStore.plain, so a badge lights
 * up the next time you visit after you've done the thing.
 */

@Composable
fun BadgesScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }

    // Recompute + persist earned state when the screen opens.
    var earned by remember { mutableStateOf(BadgeStore.earnedIds(session.plain)) }
    LaunchedEffect(Unit) { earned = BadgeStore.refresh(session.plain) }

    val earnedCount = BADGES.count { it.id in earned }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Explorer Badges", style = MaterialTheme.typography.titleLarge)
        Text(
            "$earnedCount of ${BADGES.size} earned. Keep watching, playing and exploring together to " +
                "collect them all.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        BADGES.forEach { badge ->
            BadgeRow(badge = badge, unlocked = badge.id in earned)
        }
    }
}

@Composable
private fun BadgeRow(badge: Badge, unlocked: Boolean) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(16.dp)
                .alpha(if (unlocked) 1f else 0.45f),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // The little graphic: a coloured disc for an earned badge, a flat grey one when locked.
            Box(
                Modifier
                    .size(52.dp)
                    .clip(CircleShape)
                    .background(
                        if (unlocked) MaterialTheme.colorScheme.primaryContainer
                        else MaterialTheme.colorScheme.surfaceVariant
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(badge.emoji, fontSize = 26.sp)
            }
            Column(
                Modifier
                    .weight(1f)
                    .padding(start = 14.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    badge.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    if (unlocked) "Earned!" else badge.howTo,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (unlocked) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
