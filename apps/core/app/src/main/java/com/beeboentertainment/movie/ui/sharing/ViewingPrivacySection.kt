package com.beeboentertainment.movie.ui.sharing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.ViewingPrivacyPresentation
import com.beeboentertainment.movie.data.User
import com.beeboentertainment.movie.data.ViewingPrivacyResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Only the signed-in adult can change this preference; the server checks identity again. */
@Composable
fun ViewingPrivacySection() {
    val app = BeeboApp.instance
    val session = app.session
    if (session.demoMode || !session.isLoggedIn || session.isGuest) return
    val scope = rememberCoroutineScope()
    val userId = session.userId
    val baseUrl = session.baseUrl
    var status by remember(userId, baseUrl) { mutableStateOf<ViewingPrivacyResponse?>(null) }
    var error by remember(userId, baseUrl) { mutableStateOf<String?>(null) }
    var notice by remember(userId, baseUrl) { mutableStateOf<String?>(null) }
    var loading by remember(userId, baseUrl) { mutableStateOf(true) }
    var saving by remember(userId, baseUrl) { mutableStateOf(false) }
    var reload by remember(userId, baseUrl) { mutableStateOf(0) }
    var requested by remember(userId, baseUrl) { mutableStateOf<Boolean?>(null) }
    var password by remember(userId, baseUrl) { mutableStateOf("") }

    LaunchedEffect(userId, baseUrl, reload) {
        loading = true
        status = null
        error = null
        try {
            val (code, response) = app.api.viewingPrivacy()
            if (session.userId == userId && session.baseUrl == baseUrl) {
                if (code in 200..299 && response.ok) status = response
                else error = ViewingPrivacyPresentation.error(code, response)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            error = failure.message ?: "Could not load your viewing privacy setting."
        } finally {
            loading = false
        }
    }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Viewing privacy", style = MaterialTheme.typography.titleLarge)
            val current = status
            when {
                loading -> Text("Checking your profile…")
                current != null && (current.eligible || current.enabled) -> {
                    val canChange = current.hasPassword && !saving
                    Row(
                        Modifier.fillMaxWidth().toggleable(
                            value = current.enabled,
                            enabled = canChange,
                            role = Role.Checkbox,
                            onValueChange = { requested = it; password = ""; error = null; notice = null },
                        ),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = current.enabled, onCheckedChange = null, enabled = canChange)
                        Text("Keep my viewing history private", modifier = Modifier.weight(1f))
                    }
                    Text(
                        "Hides your past and new video titles, viewing history and progress from Beebo owner and admin reports. Your own Continue Watching still works.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        "The account owner can still monitor bandwidth, connection and device status, stream counts and total watch time. Requests and anything you choose to share remain visible.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "This controls what Beebo shows. It does not encrypt history against someone who can access the storage computer directly. Turning it off makes your stored history visible again.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (!current.hasPassword) Text("Set your own Beebo sign-in password before changing this setting.")
                }
                current != null -> Text(
                    current.message.ifBlank {
                        if (!current.adult) "Available for adult profiles. The account owner can label your profile as Adult in Owner tools → Family."
                        else "Viewing privacy is unavailable for this profile. Ask the account owner to review its settings."
                    }
                )
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            notice?.let { Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium) }
            if (!loading && !saving) TextButton(onClick = { reload++ }) { Text("Refresh privacy status") }
        }
    }

    requested?.let { next ->
        AlertDialog(
            onDismissRequest = { if (!saving) { requested = null; password = "" } },
            properties = DialogProperties(securePolicy = SecureFlagPolicy.SecureOn),
            title = { Text(if (next) "Keep your viewing private?" else "Show your viewing history?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(if (next) "Confirm with your own Beebo profile password. Other devices using your profile will need to sign in again."
                        else "The owner and admins will be able to see your stored viewing history again. Confirm with your own Beebo profile password.")
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it.take(512); error = null },
                        enabled = !saving,
                        label = { Text("Your Beebo password") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = {
                TextButton(enabled = !saving && password.isNotEmpty(), onClick = {
                    val submittedPassword = password
                    val oldToken = session.token
                    val currentUser = User(
                        id = session.userId.orEmpty(), name = session.userName.orEmpty(),
                        isAdmin = session.isAdmin, restricted = session.isRestricted, guest = session.isGuest,
                    )
                    saving = true
                    error = null
                    scope.launch {
                        try {
                            val (code, response) = app.api.setViewingPrivacy(next, submittedPassword)
                            if (session.userId != userId || session.baseUrl != baseUrl || session.token != oldToken) {
                                requested = null
                                password = ""
                                return@launch
                            }
                            if (ViewingPrivacyPresentation.saved(code, response, next)) {
                                response.token?.takeIf(String::isNotBlank)?.let { session.saveLogin(it, response.user ?: currentUser) }
                                status = response
                                requested = null
                                password = ""
                                notice = if (next) "Your viewing details are now private in Beebo reports." else "Your viewing details are visible to the owner and admins."
                            } else error = ViewingPrivacyPresentation.error(code, response)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (failure: Exception) {
                            error = failure.message ?: "Could not save your privacy preference. Refresh its status before trying again."
                        } finally {
                            saving = false
                        }
                    }
                }) { Text(if (saving) "Saving…" else "Confirm") }
            },
            dismissButton = { TextButton(enabled = !saving, onClick = { requested = null; password = ""; error = null }) { Text("Cancel") } },
        )
    }
}
