package com.beeboentertainment.movie.campsite

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Campsite screen card for synced group music: the "Play together" button, transport controls,
 * and one row per guest phone with its sync state and a left / right / everything switch.
 * Shown only while Campsite is running.
 */
@Composable
internal fun MusicTogetherCard() {
    val v by CampsiteMusicHost.view.collectAsState()
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("Music together", fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(2.dp))
            Text(
                "Every guest's phone plays the same song at the same moment. They open the Music tab on their page and tap once to turn sound on.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(10.dp))

            if (v.state == "idle") {
                Button(onClick = { CampsiteMusicHost.playTogether() }, modifier = Modifier.fillMaxWidth()) { Text("Play together") }
                Text(
                    "Plays what is queued in Music (start a song there first). This phone stays quiet and conducts.",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
            } else {
                Text(v.title.ifBlank { "Getting ready..." }, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                val place = when (v.state) {
                    "preparing" -> "Waiting for guest phones to load the song..."
                    "playing" -> "Playing · ${clock(v.positionMs)} / ${clock(v.durationMs)}"
                    "paused" -> "Paused · ${clock(v.positionMs)} / ${clock(v.durationMs)}"
                    else -> "Finished"
                }
                Text(
                    listOf(v.artist, place).filter { it.isNotBlank() }.joinToString("  ·  ") + "  (${v.index + 1} of ${v.queueSize})",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(onClick = { CampsiteMusicHost.previous() }) { Text("⏮") }
                    if (v.state == "playing" || v.state == "preparing") Button(onClick = { CampsiteMusicHost.pause() }) { Text("Pause") }
                    else Button(onClick = { CampsiteMusicHost.play() }) { Text(if (v.state == "ended") "Again" else "Play") }
                    OutlinedButton(onClick = { CampsiteMusicHost.next() }) { Text("⏭") }
                    TextButton(onClick = { CampsiteMusicHost.stop() }) { Text("Stop") }
                }
            }

            v.message?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
            }

            if (v.guests.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text("Guest phones", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                v.guests.forEach { g -> GuestRow(g) }
                Text(
                    "Two phones set to Left and Right, one either side of the camp, make a stereo pair.",
                    fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun GuestRow(g: CampsiteMusicHost.GuestLine) {
    val dot = when (g.level) { 0 -> Color(0xFF4CD08A); 1 -> Color(0xFFE5B94E); 2 -> Color(0xFFE8615C); else -> Color(0xFF8A94A8) }
    Column(Modifier.padding(top = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("● ", color = dot, fontSize = 14.sp)
            Text(g.name, fontSize = 14.sp, modifier = Modifier.weight(1f))
            Text(g.detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for ((role, label) in listOf(MusicRole.EVERYONE to "All", MusicRole.LEFT to "Left", MusicRole.RIGHT to "Right")) {
                val selected = g.role == role || (role == MusicRole.EVERYONE && g.role == MusicRole.VOICE)
                if (selected) Button(onClick = {}, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp)) { Text(label, fontSize = 12.sp) }
                else OutlinedButton(onClick = { CampsiteMusicHost.setRole(g.id, role) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp)) { Text(label, fontSize = 12.sp) }
            }
        }
    }
}

private fun clock(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0L)
    return String.format(java.util.Locale.US, "%d:%02d", total / 60, total % 60)
}
