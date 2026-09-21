package com.beeboentertainment.auto.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.beeboentertainment.auto.data.ApiClient
import com.beeboentertainment.auto.data.Prefs
import com.beeboentertainment.auto.remote.AutoRemote
import com.beeboentertainment.auto.remote.CarSignIn
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.rtc.RemoteMessages
import com.beeboentertainment.movie.rtc.Route
import com.beeboentertainment.movie.rtc.SignInPlan
import com.beeboentertainment.movie.rtc.TunnelConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The phone screen's sign-in: the phone app's one sign-in (Home, username, password), so the car
 * reaches the home computer at home or away with no open port and no DuckDNS. A direct address is
 * still accepted under Advanced, for setups from before, but nothing needs it.
 *
 * Signing in happens here, on the phone, never on the car's display.
 */
@Composable
fun HomeSignInSection(
    prefs: Prefs,
    api: ApiClient,
    scope: CoroutineScope,
    openUrl: (String) -> Unit,
    onSignedInChanged: (Boolean) -> Unit,
) {
    val saved = remember { AutoRemote.savedSignIn() }
    val savedBase = remember { prefs.baseUrl }
    var home by remember {
        mutableStateOf(saved?.home ?: UrlUtils.beeboTvName(savedBase)?.let { "$it.beebo.tv" } ?: "")
    }
    var username by remember { mutableStateOf(saved?.id ?: prefs.lastUsername) }
    var password by remember { mutableStateOf("") }
    var direct by remember {
        mutableStateOf(prefs.directBaseUrl ?: savedBase.takeIf { UrlUtils.beeboTvName(it) == null }.orEmpty())
    }
    var showAdvanced by remember { mutableStateOf(home.isBlank() && direct.isNotBlank()) }
    var busy by remember { mutableStateOf(false) }
    var signedIn by remember { mutableStateOf(prefs.isConfigured) }
    var message by remember { mutableStateOf(initialMessage(prefs)) }
    var showConnectionTest by remember { mutableStateOf(false) }
    val tunnel by AutoRemote.status.collectAsState()
    val route by AutoRemote.route.collectAsState()

    fun signedInAs(how: String) {
        signedIn = true
        onSignedInChanged(true)
        password = ""
        prefs.lastUsername = username.trim()
        message = "Signed in as ${prefs.userName.ifBlank { username.trim() }}$how. " +
            "Connect to Android Auto and look for Beebo Entertainment Auto under media apps."
    }

    fun submit() {
        showConnectionTest = false
        val plan = CarSignIn.plan(home, username, password, direct, AutoRemote.currentNetwork)
        if (plan is CarSignIn.Plan.Invalid) { message = plan.message; return }
        plan as CarSignIn.Plan.Attempt
        busy = true
        message = "Signing in…"
        scope.launch {
            try {
                // The address under Advanced is the home computer's own, used at home (or cleared).
                if (plan.signIn != null) prefs.directBaseUrl = plan.direct
                for (step in plan.steps) {
                    when (step) {
                        is SignInPlan.Step.Direct -> {
                            val result = runCatching { api.login(username.trim(), password, step.baseUrl) }
                            val r = result.getOrNull()
                            val token = r?.token
                            if (r != null && r.ok && !token.isNullOrBlank()) {
                                val signIn = plan.signIn
                                if (signIn == null) {
                                    AutoRemote.onBaseUrlChanged(step.baseUrl)
                                    prefs.baseUrl = step.baseUrl
                                    prefs.directBaseUrl = step.baseUrl
                                } else {
                                    AutoRemote.rememberForLater(signIn, step.baseUrl)
                                }
                                prefs.saveLogin(token, r.user, username.trim())
                                signedInAs(if (signIn == null) "" else ", at home")
                                return@launch
                            }
                            if (plan.signIn == null) {
                                message = if (r != null) CarSignIn.loginProblem(r.error, r.locked, r.minutesRemaining)
                                else "Couldn't reach ${step.baseUrl}. ${result.exceptionOrNull()?.message.orEmpty()}".trim()
                                return@launch
                            }
                            // A name or email: the computer isn't answering here, so try away from home.
                        }
                        is SignInPlan.Step.Remote -> {
                            message = "Connecting to your home…"
                            when (val r = AutoRemote.signIn(plan.signIn!!)) {
                                is AutoRemote.SignInResult.SignedIn -> signedInAs("")
                                is AutoRemote.SignInResult.Refused -> message = r.message
                                is AutoRemote.SignInResult.NotConnected -> {
                                    message = r.message + "\n\nBeebo keeps trying. The car is ready as soon as it connects."
                                    showConnectionTest = r.showConnectionTest
                                }
                            }
                            return@launch
                        }
                    }
                }
            } catch (e: Exception) {
                message = e.message ?: "Couldn't sign in."
            } finally {
                busy = false
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Your home Beebo", style = MaterialTheme.typography.titleMedium)
        Text(
            "Sign in once, here on your phone, with the same username and password as Beebo at " +
                "home. The car then reaches your home computer at home or away. No router setup needed.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedTextField(
            value = home,
            onValueChange = { home = it },
            label = { Text("Home") },
            supportingText = { Text("Your home's name (like thesmiths or thesmiths.beebo.tv), or the email of whoever pays for Beebo") },
            singleLine = true,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                capitalization = KeyboardCapitalization.None,
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Next,
            ),
        )
        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("Username") },
            singleLine = true,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                capitalization = KeyboardCapitalization.None,
                imeAction = ImeAction.Next,
            ),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            enabled = !busy,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
        )

        TextButton(onClick = { showAdvanced = !showAdvanced }) {
            Text(if (showAdvanced) "Hide advanced" else "Advanced: direct address")
        }
        if (showAdvanced) {
            OutlinedTextField(
                value = direct,
                onValueChange = { direct = it },
                label = { Text("Home computer's address (optional)") },
                placeholder = { Text("192.168.1.10") },
                supportingText = {
                    Text(
                        "Not needed. With Home filled in, Beebo uses this address while you're on " +
                            "the home Wi-Fi and your private connection everywhere else. With Home " +
                            "empty, it signs in straight to this address, as older setups did. " +
                            "Port 47811 is added automatically."
                    )
                },
                singleLine = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(enabled = !busy, onClick = { submit() }) {
                Text(if (signedIn) "Sign in again" else "Sign in")
            }
            OutlinedButton(
                enabled = !busy && prefs.baseUrl.isNotBlank(),
                onClick = {
                    busy = true
                    message = "Checking…"
                    scope.launch {
                        message = try {
                            val p = api.ping()
                            if (p.ok) "Your home computer answered (API v${p.apiVersion})."
                            else "Reached something, but it isn't Beebo."
                        } catch (e: Exception) {
                            e.message ?: "No answer."
                        }
                        busy = false
                    }
                },
            ) { Text("Test") }
            if (signedIn) {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        prefs.signOut()
                        AutoRemote.signOut()
                        signedIn = false
                        onSignedInChanged(false)
                        message = "Signed out."
                    },
                ) { Text("Sign out") }
            }
        }

        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())

        if (UrlUtils.beeboTvName(prefs.baseUrl) != null) {
            val line = connectionLine(tunnel, route)
            Text(
                line,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (tunnel is TunnelConnection.Status.Failed || tunnel is TunnelConnection.Status.Retrying) {
                TextButton(onClick = { AutoRemote.retryNow() }) { Text("Try again now") }
            }
        }

        if (message.isNotBlank()) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(message)
                    if (showConnectionTest) {
                        TextButton(onClick = { openUrl(RemoteMessages.CONNECTION_TEST_URL) }) {
                            Text("Run the connection test", fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}

private fun connectionLine(status: TunnelConnection.Status, route: Route): String = when {
    route is Route.Direct -> "At home: connected straight to your computer."
    status is TunnelConnection.Status.Open ->
        status.pathLabel?.let { "Connected to your home. $it." }
            ?: if (status.relayed) "Connected to your home through a relay." else "Connected to your home."
    status is TunnelConnection.Status.Connecting -> "Connecting to your home…"
    status is TunnelConnection.Status.Retrying -> status.message
    status is TunnelConnection.Status.Failed -> status.message
    else -> "Beebo connects to your home when the car asks for something."
}

private fun initialMessage(prefs: Prefs): String = when {
    prefs.isConfigured -> "Signed in as ${prefs.userName}."
    else -> ""
}
