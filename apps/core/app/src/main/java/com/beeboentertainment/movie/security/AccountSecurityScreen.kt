package com.beeboentertainment.movie.security

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.server.ServerException
import com.beeboentertainment.movie.server.SafeText
import com.beeboentertainment.movie.server.rememberServerLoad
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import kotlinx.coroutines.launch

private enum class Pending { REVOKE_ONE, EVERYWHERE_ELSE, EVERYWHERE }

/**
 * Account security: what protects this account and where it is signed in. A device list with
 * "Sign out" per device and "Sign out everywhere". Setting up two-factor, recovery codes and
 * changing the password stay on the website (they show a QR code and a page of codes to save,
 * which need a bigger screen and a printer or notes app), so this screen says so.
 */
@Composable
fun AccountSecurityScreen(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    val client = remember { AccountSecurityClient.get() }
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pending?>(null) }
    var pendingDevice by remember { mutableStateOf<SecurityLogic.DeviceRow?>(null) }
    val loaded = rememberServerLoad("security", onUnauthorized, reload) { client.overview() }
    val overview = loaded.value

    fun run(block: suspend () -> Unit) {
        busy = true
        message = null
        scope.launch {
            try {
                block()
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: ServerException) {
                message = SecurityLogic.refusalMessage(e.code, e.message)
            } catch (e: Exception) {
                message = e.message ?: "That didn't work."
            } finally {
                busy = false
            }
        }
    }

    when {
        loaded.error != null && overview == null -> ErrorBox(loaded.error, onRetry = { reload++ })
        overview == null -> LoadingBox()
        else -> Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("Account security", style = MaterialTheme.typography.headlineSmall)
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Two-factor sign-in", style = MaterialTheme.typography.titleMedium)
                    Text(SecurityLogic.twoFactorLine(overview.twoFactor, overview.policy), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (overview.privateProfile) {
                        Text("This profile keeps its viewing history private.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                    }
                }
            }

            Text("Signed-in devices", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 4.dp))
            val now = System.currentTimeMillis()
            val rows = SecurityLogic.devices(overview.sessions)
            if (rows.isEmpty()) Text("No devices are listed.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            rows.forEach { row ->
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                row.title + if (row.current) " (this device)" else "",
                                fontWeight = if (row.current) FontWeight.Bold else FontWeight.Normal
                            )
                            Text(
                                listOfNotNull(row.detail.ifBlank { null }, "Last seen " + SecurityLogic.lastSeen(now, row.lastSeenAt)).joinToString(" · "),
                                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        if (SecurityLogic.canRevoke(row)) {
                            OutlinedButton(enabled = !busy, onClick = { pendingDevice = row; pending = Pending.REVOKE_ONE }) { Text("Sign out") }
                        }
                    }
                }
            }

            Spacer(Modifier.height(4.dp))
            Button(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { pending = Pending.EVERYWHERE_ELSE }) {
                Text("Sign out everywhere else")
            }
            OutlinedButton(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { pending = Pending.EVERYWHERE }) {
                Text("Sign out everywhere, including here")
            }
            message?.let { Text(it, color = MaterialTheme.colorScheme.error) }

            if (overview.events.isNotEmpty()) {
                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                Text("Recent activity on your account", style = MaterialTheme.typography.titleMedium)
                overview.events.take(10).forEach { e ->
                    Text(
                        SafeText.clean(e.label, 120) + "  ·  " + SecurityLogic.lastSeen(now, e.time),
                        fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            Text(
                "To turn two-factor on or off, get new recovery codes or change your password, sign in to Beebo on the website and open Account security.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp)
            )
        }
    }

    val what = pending
    if (what != null) {
        val device = pendingDevice
        AlertDialog(
            onDismissRequest = { pending = null },
            title = {
                Text(
                    when (what) {
                        Pending.REVOKE_ONE -> "Sign out ${device?.title ?: "that device"}?"
                        Pending.EVERYWHERE_ELSE -> "Sign out everywhere else?"
                        Pending.EVERYWHERE -> "Sign out everywhere?"
                    }
                )
            },
            text = {
                Text(
                    when (what) {
                        Pending.REVOKE_ONE -> "It will need your password (and a code, if you use two-factor) to sign in again."
                        Pending.EVERYWHERE_ELSE -> "Every other phone, TV and browser is signed out. This one stays signed in."
                        Pending.EVERYWHERE -> "Every phone, TV and browser is signed out, including this one. You will sign in again here."
                    }
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    pending = null
                    when (what) {
                        Pending.REVOKE_ONE -> device?.let { d ->
                            run {
                                client.revoke(d.id)
                                reload++
                                message = "Signed out ${d.title}."
                            }
                        }
                        Pending.EVERYWHERE_ELSE -> run {
                            val answer = client.revokeAll(includeCurrent = false)
                            // This device's old token ended with the rest: keep the fresh one the server made for it.
                            SecurityLogic.replacementToken(answer, keptThisDevice = true)?.let { app.session.token = it }
                            reload++
                            val others = SecurityLogic.othersEnded(answer.ended, keptThisDevice = true)
                            message = "Signed out $others other ${if (others == 1) "device" else "devices"}."
                        }
                        Pending.EVERYWHERE -> run {
                            client.revokeAll(includeCurrent = true)
                            onUnauthorized()
                        }
                    }
                }) { Text("Sign out") }
            },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("Cancel") } }
        )
    }
}
