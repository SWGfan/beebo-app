package com.beeboentertainment.movie.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.DistributionPolicy
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.rtc.RemoteAccess
import com.beeboentertainment.movie.rtc.RemoteMessages
import com.beeboentertainment.movie.rtc.TunnelConnection
import kotlinx.coroutines.delay

/**
 * Away from home, over the top of the library: small, never blocking it.
 *  - reconnecting after a network change ("Reconnecting to your home...");
 *  - not connected, still trying: the plain reason, Try again, and the connection test when the
 *    two networks couldn't reach each other;
 *  - just connected: for a few seconds, how ("Direct connection" or "Through Beebo Relay");
 *  - not connected and not trying (signed out, subscription lapsed): the reason and Sign in;
 *  - the Beebo Relay balance banner, in the viewer page's own words, as text only. The app never
 *    shows the page's top-up or pay-as-you-go links: nothing in the app leads to a purchase
 *    (Google Play Payments policy). PaymentsGuardTest checks this.
 * Shows nothing for a plain server address.
 */
@Composable
fun RemoteBanners(modifier: Modifier = Modifier, onSignInAgain: () -> Unit) {
    val app = BeeboApp.instance
    if (UrlUtils.beeboTvName(app.session.baseUrl) == null) return
    val status by RemoteAccess.status.collectAsState()
    val wallet by RemoteAccess.wallet.collectAsState()
    val context = LocalContext.current
    val websiteLinks = DistributionPolicy.opensWebsiteLinks(DistributionPolicy.current)
    fun open(url: String) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    Column(modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        when (val s = status) {
            is TunnelConnection.Status.Connecting -> if (s.reconnecting) Pill {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("Reconnecting to your home…", fontSize = 13.sp)
                }
            }
            is TunnelConnection.Status.Retrying -> Pill {
                Column {
                    Text(s.message, fontSize = 13.sp)
                    Row {
                        TextButton(onClick = { RemoteAccess.retryNow() }) { Text("Try again", fontSize = 13.sp) }
                        if (s.code in setOf("no_direct_path", "ice_failed") && websiteLinks) {
                            TextButton(onClick = { open(RemoteMessages.CONNECTION_TEST_URL) }) { Text("Connection test", fontSize = 13.sp) }
                        }
                    }
                    // Google Play build: the website's menu links to Pricing, so name the page instead.
                    if (s.code in setOf("no_direct_path", "ice_failed") && !websiteLinks) {
                        Text("Connection test: " + DistributionPolicy.plainAddress(RemoteMessages.CONNECTION_TEST_URL), fontSize = 12.sp)
                    }
                }
            }
            is TunnelConnection.Status.Failed -> Pill {
                Column {
                    Text(s.message, fontSize = 13.sp)
                    TextButton(onClick = onSignInAgain) { Text("Sign in", fontSize = 13.sp) }
                }
            }
            is TunnelConnection.Status.Open -> {
                // How the phone reached home, briefly, each time the connection opens.
                var shown by remember { mutableStateOf(false) }
                LaunchedEffect(s) { shown = true; delay(4_000); shown = false }
                val label = s.pathLabel
                if (shown) Pill { Text("Connected to your home · ${label ?: "Checking connection route…"}", fontSize = 13.sp) }
            }
            else -> {}
        }
        wallet?.let { w ->
            Pill {
                Column {
                    Text(w.text, fontSize = 13.sp)
                    Row {
                        TextButton(onClick = { RemoteAccess.dismissWallet() }) { Text("Dismiss", fontSize = 13.sp) }
                    }
                }
            }
        }
    }
}

@Composable
private fun Pill(content: @Composable () -> Unit) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        tonalElevation = 6.dp,
        shadowElevation = 4.dp,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) { content() }
    }
}
