package com.beeboentertainment.movie.party

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.graphics.asImageBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.Player
import com.beeboentertainment.movie.data.SessionStore
import com.beeboentertainment.movie.hub.HubClient
import com.beeboentertainment.movie.hub.HubException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * The control surface for a watch party.
 *
 * It renders the room roster, a Host / Join toggle, the [AudioDelaySlider], and
 * the viewer [VideoWindow]. It is a self-contained composable: hand it a
 * [PartyController] (see [rememberParty]) and where to slot the video, and drop
 * it wherever the app wants it — it does not touch the nav graph.
 *
 * @param controller the wired sync brain, or null to show the controls in a
 *   preview/offline state (the slider and window still work; joining is disabled
 *   because there is no player to drive).
 * @param videoContent the video surface for viewers (a PlayerView / SurfaceView).
 *   Hosted inside the movable window.
 * @param onPopOut if non-null, a "Pop out" button is shown that drops the video
 *   into a system Picture-in-Picture window. Kept a callback so the party package
 *   stays free of any dependency on the host Activity / ui package.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun PartyScreen(
    session: SessionStore,
    deviceName: String,
    controller: PartyController?,
    modifier: Modifier = Modifier,
    videoContent: @Composable () -> Unit = { VideoPlaceholder() },
    onPopOut: (() -> Unit)? = null,
) {
    val fallback = remember { MutableStateFlow<PartyState>(PartyState.Disconnected) }
    val state by (controller?.state ?: fallback).collectAsState()

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Watch party", style = MaterialTheme.typography.titleLarge)
        Text(
            "Play the same film across devices. One device hosts and plays the " +
                "audio; viewers' screens follow in sync.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // ---- Host / Join toggle ------------------------------------------------
        val activeRole = roleOf(state)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FilterChip(
                selected = activeRole == RoomRole.HOST,
                onClick = {
                    session.partyRole = "host"
                    controller?.start(deviceName, RoomRole.HOST)
                },
                enabled = controller != null,
                label = { Text("Host") },
            )
            FilterChip(
                selected = activeRole == RoomRole.VIEWER,
                onClick = {
                    session.partyRole = "viewer"
                    controller?.start(deviceName, RoomRole.VIEWER)
                },
                enabled = controller != null,
                label = { Text("Join as viewer") },
            )
            if (state !is PartyState.Disconnected) {
                OutlinedButton(onClick = { controller?.stop() }) { Text("Leave") }
            }
        }

        // ---- Car party: start one so passengers (no account) can join ----------
        CarPartyHost(session)

        Text(
            statusLine(state),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // ---- Roster ------------------------------------------------------------
        val roster = rosterOf(state)
        if (roster.isNotEmpty()) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("In the room", fontWeight = FontWeight.Bold)
                    roster.forEach { m ->
                        val self = if (m.id == youOf(state)) " (you)" else ""
                        val tag = if (m.role.equals("host", ignoreCase = true)) " — host" else ""
                        Text(
                            (m.name.ifBlank { "Device" }) + tag + self,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }

        HorizontalDivider()

        // ---- Lip-sync trim (viewer-relevant) -----------------------------------
        AudioDelaySlider(session)

        HorizontalDivider()

        // ---- Viewer video window -----------------------------------------------
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Viewer screen",
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            // Pop the video out of the app into a system floating window. Only
            // shown when the host says PIP is available on this device.
            onPopOut?.let { pop ->
                OutlinedButton(onClick = pop) { Text("Pop out") }
            }
        }
        Text(
            "Drag the bar to move it, the corner to resize, and \"Disable screen\" " +
                "to hide the picture while the audio keeps playing. \"Pop out\" floats " +
                "the video over other apps so it keeps playing when you leave.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // A bounded stage the window can roam over. 16:9 keeps it phone-friendly.
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f),
        ) {
            VideoWindow(session = session, content = videoContent)
        }
    }
}

/**
 * Host-side "car party" control: starts a party on the hub and shows the 3-digit
 * code for passengers (who have no account) to type in. Only useful when signed
 * into the hub; shown with a hint otherwise. The passenger side (entering the
 * code, playing along) is a separate guest-mode screen added once the hub is
 * deployed and the flow can be tested end to end.
 */
@Composable
private fun CarPartyHost(session: SessionStore) {
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val signedIn = !session.hubToken.isNullOrBlank()

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Car party", fontWeight = FontWeight.Bold)
            Text(
                "Let passengers with no account join in to play games and follow along. " +
                    "Tap start, then read out the code.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val shown = code
            if (shown != null) {
                Text("Party code", style = MaterialTheme.typography.labelMedium)
                Text(
                    shown,
                    fontSize = 44.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                )
                // A scannable QR of the join URL: a passenger with no app just
                // points their phone camera at it and lands in the web party.
                val joinUrl = "${HubClient.HUB_BASE_URL}/party/$shown"
                val qr = remember(shown) { qrBitmap(joinUrl, 480) }
                if (qr != null) {
                    Image(
                        bitmap = qr.asImageBitmap(),
                        contentDescription = "Scan to join the car party",
                        modifier = Modifier.size(180.dp),
                    )
                }
                Text(
                    "Passengers: scan the code above (no app needed), or open the app → " +
                        "“Join a car party” → enter $shown",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Button(
                    enabled = signedIn && !busy,
                    onClick = {
                        val token = session.hubToken
                        if (token.isNullOrBlank()) {
                            error = "Sign in to the hub first."
                        } else {
                            error = null
                            busy = true
                            scope.launch {
                                try {
                                    code = HubClient(session).startParty(token).code
                                } catch (e: HubException) {
                                    error = e.message
                                } catch (e: Exception) {
                                    error = "Couldn't reach the hub. Check your connection."
                                } finally {
                                    busy = false
                                }
                            }
                        }
                    },
                ) { Text(if (busy) "Starting…" else "Start car party") }
                if (!signedIn) {
                    Text(
                        "Sign in to the hub to start a party.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** Encode [content] as a black-and-white QR [Bitmap], or null if encoding fails. */
private fun qrBitmap(content: String, size: Int): Bitmap? {
    return try {
        val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
        val black = android.graphics.Color.BLACK
        val white = android.graphics.Color.WHITE
        for (x in 0 until size) {
            for (y in 0 until size) {
                bmp.setPixel(x, y, if (matrix[x, y]) black else white)
            }
        }
        bmp
    } catch (_: Exception) {
        null
    }
}

/**
 * Builds and remembers a [PartyController] wired to [player], or null when there
 * is nothing to drive (no player, or not signed in to the hub). The controller is
 * stopped automatically when it leaves composition.
 *
 * [player] is a Media3 [androidx.media3.common.Player]: on the HOST bind it to
 * the app's session player (the core ExoPlayer); on a VIEWER bind it to the local
 * video player that renders into the [VideoWindow].
 */
@Composable
fun rememberParty(
    session: SessionStore,
    player: Player?,
    onLoadVideo: ((videoId: String) -> Unit)? = null,
): PartyController? {
    val hubToken = session.hubToken
    val controller = remember(player, hubToken) {
        if (player == null || hubToken.isNullOrBlank()) {
            null
        } else {
            PartyController(
                player = player,
                session = session,
                room = RoomClient(hubToken),
                onLoadVideo = onLoadVideo,
            )
        }
    }
    DisposableEffect(controller) {
        onDispose { controller?.stop() }
    }
    return controller
}

@Composable
private fun VideoPlaceholder() {
    Box(Modifier.fillMaxWidth()) {
        Text(
            "Video appears here",
            modifier = Modifier.padding(16.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// -------------------------------------------------------------- state helpers

private fun roleOf(s: PartyState): RoomRole? = when (s) {
    is PartyState.Hosting -> RoomRole.HOST
    is PartyState.Following -> RoomRole.VIEWER
    else -> null
}

private fun rosterOf(s: PartyState): List<RoomMember> = when (s) {
    is PartyState.Connected -> s.roster
    is PartyState.Hosting -> s.roster
    is PartyState.Following -> s.roster
    PartyState.Disconnected -> emptyList()
}

private fun youOf(s: PartyState): String = when (s) {
    is PartyState.Connected -> s.you
    is PartyState.Hosting -> s.you
    is PartyState.Following -> s.you
    PartyState.Disconnected -> ""
}

private fun statusLine(s: PartyState): String = when (s) {
    PartyState.Disconnected -> "Not in a party."
    is PartyState.Connected -> "Connected."
    is PartyState.Hosting -> "Hosting — this device plays the audio."
    is PartyState.Following -> "Following the host. Your screen is muted and synced."
}
