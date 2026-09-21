package com.beeboentertainment.auto.party

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.media3.common.Player
import com.beeboentertainment.auto.data.Prefs
import com.beeboentertainment.auto.drive.VideoGate
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * The phone/tablet control surface for a watch party: roster, Host / Join
 * toggle, lip-sync slider and the passenger video window.
 *
 * Video is parked-only. [videoBlock] comes from [VideoGate]; while it is not
 * NONE the window shows why instead of a picture, the controller holds the
 * viewer paused, and "Pop out" is hidden.
 *
 * @param controller the wired sync brain, or null when not signed in to a
 *   Beebo account (the slider still works; joining is disabled).
 * @param onConfirmPassenger shown as an "I'm a passenger" button when the gate
 *   needs that confirmation.
 * @param onPopOut non-null shows "Pop out" (system picture-in-picture). Pass
 *   null wherever [VideoGate.pipAllowed] says no.
 */
@Composable
fun PartyScreen(
    prefs: Prefs,
    deviceName: String,
    controller: PartyController?,
    videoBlock: VideoGate.Block,
    modifier: Modifier = Modifier,
    onConfirmPassenger: (() -> Unit)? = null,
    videoContent: @Composable () -> Unit = { VideoPlaceholder("Video appears here") },
    onPopOut: (() -> Unit)? = null,
) {
    val fallback = remember { MutableStateFlow<PartyState>(PartyState.Disconnected) }
    val noNotice = remember { MutableStateFlow<String?>(null) }
    val state by (controller?.state ?: fallback).collectAsState()
    val notice by (controller?.notice ?: noNotice).collectAsState()

    LaunchedEffect(controller, videoBlock) {
        controller?.setVideoBlocked(videoBlock != VideoGate.Block.NONE)
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Watch party", style = MaterialTheme.typography.titleLarge)
        Text(
            "Play the same film across the car. The phone connected to the car hosts " +
                "and plays the sound; passengers' phones and tablets show the picture " +
                "in sync, muted. Start the film in the car first, then host.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (controller == null) {
            Text(
                "Sign in to your Beebo account above to host or join.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        val activeRole = roleOf(state)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FilterChip(
                selected = activeRole == RoomRole.HOST,
                onClick = {
                    prefs.partyRole = "host"
                    controller?.start(deviceName, RoomRole.HOST)
                },
                enabled = controller?.canHost == true,
                label = { Text("Host") },
            )
            FilterChip(
                selected = activeRole == RoomRole.VIEWER,
                onClick = {
                    prefs.partyRole = "viewer"
                    controller?.start(deviceName, RoomRole.VIEWER)
                },
                enabled = controller?.canView == true,
                label = { Text("Join as viewer") },
            )
            if (state !is PartyState.Disconnected) {
                OutlinedButton(onClick = { controller?.stop() }) { Text("Leave") }
            }
        }

        Text(
            statusLine(state),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        notice?.let {
            Card(Modifier.fillMaxWidth()) { Text(it, Modifier.padding(16.dp)) }
        }

        val roster = rosterOf(state)
        if (roster.isNotEmpty()) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("In the room", fontWeight = FontWeight.Bold)
                    roster.forEach { m ->
                        val self = if (m.id == youOf(state)) " (you)" else ""
                        val tag = if (m.role.equals("host", ignoreCase = true)) " — host" else ""
                        Text((m.name.ifBlank { "Device" }) + tag + self, style = MaterialTheme.typography.bodyMedium)
                    }
                    if (state is PartyState.Following && roster.none { it.role.equals("host", true) }) {
                        Text(
                            "No one is hosting yet. The phone connected to the car should tap Host.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        HorizontalDivider()
        AudioDelaySlider(prefs)
        HorizontalDivider()

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Passenger screen", fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            if (videoBlock == VideoGate.Block.NONE) {
                onPopOut?.let { pop -> OutlinedButton(onClick = pop) { Text("Pop out") } }
            }
        }

        val blockMessage = VideoGate.message(videoBlock)
        if (blockMessage != null) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(blockMessage)
                    if (videoBlock == VideoGate.Block.NEEDS_PASSENGER_CONFIRMATION && onConfirmPassenger != null) {
                        Button(onClick = onConfirmPassenger) { Text("I'm a passenger") }
                    }
                }
            }
        } else {
            Text(
                "Drag the bar to move the picture, the corner to resize, and \"Disable screen\" " +
                    "to hide it. \"Pop out\" floats it over other apps.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f)) {
                VideoWindow(prefs = prefs, content = videoContent)
            }
        }
    }
}

/**
 * Builds and remembers a [PartyController], or null when there is no Beebo
 * account session to join a room with. Stopped when it leaves composition.
 */
@Composable
fun rememberParty(
    prefs: Prefs,
    hubToken: String?,
    hostPlayer: Player?,
    viewerPlayer: Player?,
    onLoadVideo: (suspend (videoId: String) -> String?)? = null,
): PartyController? {
    val controller = remember(hubToken, hostPlayer, viewerPlayer) {
        if (hubToken.isNullOrBlank() || (hostPlayer == null && viewerPlayer == null)) null
        else PartyController(
            prefs = prefs,
            room = RoomClient(hubToken),
            hostPlayer = hostPlayer,
            viewerPlayer = viewerPlayer,
            onLoadVideo = onLoadVideo,
        )
    }
    DisposableEffect(controller) {
        onDispose { controller?.stop() }
    }
    return controller
}

@Composable
fun VideoPlaceholder(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun roleOf(s: PartyState): RoomRole? = when (s) {
    is PartyState.Hosting -> RoomRole.HOST
    is PartyState.Following -> RoomRole.VIEWER
    else -> null
}

private fun rosterOf(s: PartyState): List<RoomMember> = when (s) {
    is PartyState.Connected -> s.roster
    is PartyState.Hosting -> s.roster
    is PartyState.Following -> s.roster
    else -> emptyList()
}

private fun youOf(s: PartyState): String = when (s) {
    is PartyState.Connected -> s.you
    is PartyState.Hosting -> s.you
    is PartyState.Following -> s.you
    else -> ""
}

private fun statusLine(s: PartyState): String = when (s) {
    PartyState.Disconnected -> "Not in a party."
    is PartyState.Joining -> s.message
    is PartyState.Connected -> "Connected."
    is PartyState.Hosting -> "Hosting — the car plays this device's audio."
    is PartyState.Following -> "Following the host. Your screen is muted and synced."
}
