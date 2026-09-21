package com.beeboentertainment.auto.ui

import android.view.SurfaceView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.Player
import com.beeboentertainment.auto.drive.VideoGate
import com.beeboentertainment.auto.hub.HubAuth
import com.beeboentertainment.auto.hub.HubException
import com.beeboentertainment.auto.party.VideoPlaceholder
import com.beeboentertainment.auto.webrtc.WebRtcConnector
import kotlinx.coroutines.launch
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/**
 * Sign-in to the Beebo account (the hub). The watch party and the home PC link
 * both need it; the car app had the hub client but no screen that ever called
 * it, so [com.beeboentertainment.auto.data.Prefs.hubToken] was always empty and
 * both features could never start.
 */
@Composable
fun HubAccountSection(hubToken: String?, onTokenChanged: (String?) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }

    Text("Beebo account", style = MaterialTheme.typography.titleMedium)
    if (!hubToken.isNullOrBlank()) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                "Signed in. Watch party is ready.",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = {
                com.beeboentertainment.auto.data.Prefs.get(context).signOutHub()
                onTokenChanged(null)
                status = ""
            }) { Text("Sign out") }
        }
        return
    }
    Text(
        "Sign in with the email and password of your Beebo account to host or join a watch party.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    OutlinedTextField(
        value = email,
        onValueChange = { email = it },
        label = { Text("Email") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
    )
    OutlinedTextField(
        value = password,
        onValueChange = { password = it },
        label = { Text("Password") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
    )
    Button(
        enabled = !busy && email.isNotBlank() && password.isNotBlank(),
        onClick = {
            busy = true
            status = "Signing in…"
            scope.launch {
                status = try {
                    val session = HubAuth.signIn(context, email.trim(), password)
                    password = ""
                    onTokenChanged(session.token)
                    ""
                } catch (e: HubException) {
                    e.message ?: "Sign-in failed."
                } catch (e: Exception) {
                    "Couldn't reach the Beebo hub. Check the phone's internet connection."
                }
                busy = false
            }
        },
    ) { Text("Sign in") }
    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    if (status.isNotBlank()) Text(status, style = MaterialTheme.typography.bodySmall)
}

/**
 * The viewer's picture: a SurfaceView bound to [player]. Only call this when
 * [VideoGate] allows video; leaving composition detaches the surface.
 */
@Composable
fun ViewerSurface(player: Player, modifier: Modifier = Modifier) {
    var view by remember { mutableStateOf<SurfaceView?>(null) }
    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { ctx -> SurfaceView(ctx).also { player.setVideoSurfaceView(it); view = it } },
    )
    DisposableEffect(player) {
        onDispose { view?.let { player.clearVideoSurfaceView(it) } }
    }
}

/**
 * A test of the Stage 2 link: WebRTC signalling through the hub's /signal
 * relay to the home PC, then a peer-to-peer video track. Only shown when a
 * Beebo account is signed in; the picture follows the same parked-only rule as
 * the watch party, and the link is closed as soon as video becomes blocked.
 */
@Composable
fun HomePcLinkSection(
    connector: WebRtcConnector?,
    videoBlock: VideoGate.Block,
    onConnect: () -> Unit,
    onClose: () -> Unit,
) {
    Text("Home PC link (test)", style = MaterialTheme.typography.titleMedium)
    Text(
        "Checks that this device can open a direct, peer-to-peer video link to your PC " +
            "through the Beebo hub. Your PC must be running the Beebo hub agent.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    val state = connector?.state?.collectAsState()?.value
    val track = connector?.remoteVideo?.collectAsState()?.value
    val blockMessage = VideoGate.message(videoBlock)

    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        val live = state is WebRtcConnector.State.Connecting || state is WebRtcConnector.State.Connected
        Button(enabled = !live && blockMessage == null, onClick = onConnect) { Text("Connect") }
        if (live) OutlinedButton(onClick = onClose) { Text("Disconnect") }
    }
    Text(
        when (state) {
            null, WebRtcConnector.State.Idle -> blockMessage ?: "Not connected."
            WebRtcConnector.State.Connecting -> "Connecting to your PC…"
            WebRtcConnector.State.Connected -> "Connected peer-to-peer."
            WebRtcConnector.State.PeerOffline ->
                "Your PC isn't connected to the Beebo hub, so there's nothing to link to."
            is WebRtcConnector.State.Failed -> state.reason
        },
        style = MaterialTheme.typography.bodySmall,
    )
    if (connector != null && state is WebRtcConnector.State.Connected && blockMessage == null) {
        Card(Modifier.fillMaxWidth()) {
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f)) {
                if (track == null) VideoPlaceholder("Waiting for your PC's picture…")
                else RemoteTrackSurface(connector, track)
            }
        }
    }
}

@Composable
private fun RemoteTrackSurface(connector: WebRtcConnector, track: VideoTrack) {
    var renderer by remember { mutableStateOf<SurfaceViewRenderer?>(null) }
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            val r = connector.createRenderer(ctx)
            renderer = r
            r?.also { track.addSink(it) } ?: android.widget.TextView(ctx).apply {
                text = "This device can't show the PC's picture."
                setPadding(32, 32, 32, 32)
            }
        },
    )
    DisposableEffect(connector, track) {
        onDispose { renderer?.let { connector.releaseRenderer(it, track) } }
    }
}

/** Shown inside system picture-in-picture. */
@Composable
fun PipStage(player: Player?, videoBlock: VideoGate.Block) {
    val message = VideoGate.message(videoBlock)
    Column(Modifier.fillMaxSize().padding(8.dp)) {
        if (player != null && message == null) ViewerSurface(player)
        else Text(message ?: "Nothing playing.", color = androidx.compose.ui.graphics.Color.White)
    }
}
