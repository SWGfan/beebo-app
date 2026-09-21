package com.beeboentertainment.movie.campsite

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.badges.BadgeStore
import com.beeboentertainment.movie.trip.TripControlCard
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter

/**
 * Campsite Mode control surface. Games open straight away with nothing running. Host taps
 * Invite guests → their phone starts serving, they pick how guests reach the Wi-Fi, a big QR
 * appears, guests scan it and watch or play in a browser. No app, no sign-up.
 */
@Composable
fun CampsiteScreen(
    onOpenOther: () -> Unit = {},
    onOpenGuestGames: () -> Unit = {},
    onOpenSlides: () -> Unit = {},
) {
    val context = LocalContext.current
    val state by CampsiteHost.state.collectAsState()
    // Parking at a campsite is a trip milestone, so count today (at most once per day)
    // towards the "Road Trip Veteran" badge. Purely local; no network.
    LaunchedEffect(Unit) {
        runCatching {
            BadgeStore.recordTripToday(BeeboApp.instance.session.plain)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("🏕️", fontSize = 44.sp)
        Text("Campsite Mode", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        if (!state.running) {
            // Host-facing explainer. Once running, the phone is being held up to
            // guests, so the join codes go at the top instead of a paragraph.
            Text(
                "Turn this phone into a little theatre and game room. Guests scan a code, type a name, and watch the videos you downloaded or play along — over local Wi-Fi. No internet, no data, nothing saved to their phone.",
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 14.sp,
            )
        }
        Spacer(Modifier.height(if (state.running) 12.dp else 20.dp))

        // Also reachable from Other → Games. Always open: with Campsite stopped, Games plays
        // on this phone against the computer and starts nothing - no server, no hotspot.
        Card(
            Modifier
                .fillMaxWidth()
                .clickable { onOpenGuestGames() }
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("🎮", fontSize = 28.sp)
                Spacer(Modifier.size(14.dp))
                Column {
                    Text(
                        "Games",
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 16.sp,
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(
                        if (state.running)
                            "Open the same games as your guests. Everyone plays on their own phone."
                        else "Play now against the computer on this phone. No Wi-Fi or hotspot needed.",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Spacer(Modifier.height(12.dp))

        TripControlCard()
        Spacer(Modifier.height(12.dp))

        Button(onClick = onOpenSlides, modifier = Modifier.fillMaxWidth()) {
            Text("Shared photos & videos")
        }
        Text("Take turns presenting. Swipe to change the photo for everyone, or play a video together.",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 8.dp))
        OutlinedButton(onClick = onOpenOther, modifier = Modifier.fillMaxWidth()) {
            Text("Open Play — games & outdoors")
        }
        if (state.running) {
            Text("You can browse activities while your guests keep watching.",
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center)
        }
        Spacer(Modifier.height(12.dp))


        if (!state.running) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Before you start", fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "1. Download the videos you want while you still have Wi-Fi.\n" +
                            "2. Tap Invite guests, then pick how they connect: Beebo's own\n" +
                            "    Wi-Fi, your phone's hotspot, or the Wi-Fi you're all on.\n" +
                            "3. You'll get the codes: one that puts your guests on the Wi-Fi\n" +
                            "    (if they need it), and one that opens the theatre and games.",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(14.dp))
                    OutlinedButton(onClick = {
                        runCatching {
                            context.startActivity(
                                Intent(Settings.ACTION_WIRELESS_SETTINGS)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                    }) { Text("Open hotspot settings") }
                }
            }
            Spacer(Modifier.height(18.dp))
            // Starts the guest server only. No permission prompt and no hotspot: Step 1 asks
            // how guests connect, and only "Start BeeboTV Wi-Fi" makes a network.
            Button(onClick = { CampsiteInvite.invitePlayers() }, modifier = Modifier.fillMaxWidth()) {
                Text("Invite guests")
            }
            Text(
                "Starts Campsite Mode so other phones can watch and play. You pick the Wi-Fi next.",
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            val url = state.url

            // --- Step 1: put the guest ON the Wi-Fi. Without this the watch QR
            // opens a browser with nowhere to send the request ("not connected to
            // a network"), which reads as Beebo being broken when it isn't.
            // Beebo makes the network itself where Android allows; see CampsiteWifiCard.
            WifiStepCard()

            Spacer(Modifier.height(16.dp))

            if (url != null) {
                Text("Step 2  \u2014  open the theatre", fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                val qr = remember(url) { qrBitmap(url, 720) }
                if (qr != null) {
                    Image(qr.asImageBitmap(), contentDescription = "Join code", modifier = Modifier.size(240.dp))
                }
                Spacer(Modifier.height(10.dp))
                Text("Guests: scan this, or open", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(url, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                Spacer(Modifier.height(6.dp))
                Text(
                    "If a guest sees \"not connected to a network\", they skipped Step 1 \u2014 or their phone is in Airplane mode with Wi-Fi off.",
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text(
                    "Server is on, but I can't see a local network address yet. Turn on your hotspot (or join a Wi-Fi), and the join code will appear.",
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 14.sp,
                )
            }

            Spacer(Modifier.height(18.dp))
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text("Sharing ${state.sharedCount} downloaded ${if (state.sharedCount == 1) "video" else "videos"}", fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(8.dp))
                    if (state.guests.isEmpty()) {
                        Text(
                            "No one connected yet. Campsite stops by itself after 15 minutes with nobody connected.",
                            fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        // "Watching" now means a live watch-together session, which is
                        // the card below. This one is simply who is on the hotspot.
                        Text("Connected now (${state.guests.size}):", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(4.dp))
                        state.guests.forEach { g -> Text("• $g", fontSize = 14.sp) }
                    }
                }
            }

            // --- Who is watching what -----------------------------------------
            // Read-only on purpose. Playback authority in CampsiteWatch belongs to a
            // viewer identity handed out at /join and carried in a cookie, and this
            // screen has no such identity because the Android app is not a viewer.
            // Minting one here would take playback off whichever guest is actually
            // holding it, and would leave two clocks - ExoPlayer on this phone and
            // the web session over there - each certain it was the right one. So the
            // host joins the same way everybody else does: through the browser page.
            if (state.watching.isNotEmpty()) {
                Spacer(Modifier.height(18.dp))
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text("Watching together", fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(2.dp))
                        Text(
                            "Guests see these on their own library page and can tap straight in, already in sync.",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        state.watching.forEach { w ->
                            Spacer(Modifier.height(14.dp))
                            Text(w.title, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                            Spacer(Modifier.height(2.dp))
                            val people = if (w.viewers == 1) "1 phone" else "${w.viewers} phones"
                            val where = when (w.state) {
                                "playing" -> "Playing \u00b7 ${clockText(w.positionMs)}"
                                "ended" -> "Finished"
                                else -> "Paused \u00b7 ${clockText(w.positionMs)}"
                            }
                            Text(
                                where + "  \u00b7  " + people +
                                    (if (w.hostName.isNotBlank()) "  \u00b7  ${w.hostName} has playback" else ""),
                                fontSize = 13.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (url != null) {
                                TextButton(onClick = {
                                    runCatching {
                                        context.startActivity(
                                            Intent(
                                                Intent.ACTION_VIEW,
                                                Uri.parse("$url/watch?id=" + Uri.encode(w.videoId)),
                                            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                        )
                                    }
                                }) { Text("Watch this on my phone too") }
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "Play, pause and seek live on the browser page rather than here \u2014 whoever opened the video is holding playback, and the page hands it on if they wander off.",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            Spacer(Modifier.height(18.dp))
            MusicTogetherCard()

            Spacer(Modifier.height(18.dp))
            OutlinedButton(onClick = { CampsiteInvite.stop() }, modifier = Modifier.fillMaxWidth()) {
                Text("Stop Campsite Mode")
            }
        }

        Spacer(Modifier.height(20.dp))
        Text(
            "Guests must stay near your phone to keep their signal — just like staying near a home Wi-Fi. Go too far and they lose it.",
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 12.sp,
        )
    }
}

/** m:ss, or h:mm:ss past an hour, for the host's read-only view of a session. */
private fun clockText(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0L)
    val h = total / 3600
    val m = (total / 60) % 60
    val s = total % 60
    return if (h > 0) String.format(java.util.Locale.US, "%d:%02d:%02d", h, m, s)
    else String.format(java.util.Locale.US, "%d:%02d", m, s)
}

/** Encode [text] as a black-on-white QR bitmap of [size] px. */
internal fun qrBitmap(text: String, size: Int): Bitmap? = runCatching {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
    val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    for (x in 0 until size) {
        for (y in 0 until size) {
            bmp.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
        }
    }
    bmp
}.getOrNull()
