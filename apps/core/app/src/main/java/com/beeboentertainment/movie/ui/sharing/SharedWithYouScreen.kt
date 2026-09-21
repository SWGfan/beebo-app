package com.beeboentertainment.movie.ui.sharing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.InviteCode
import com.beeboentertainment.movie.core.ShareReportReason
import com.beeboentertainment.movie.core.SharedLibrary
import com.beeboentertainment.movie.rtc.RemoteAccess
import com.beeboentertainment.movie.sharing.SharedLibrarySwitcher
import kotlinx.coroutines.launch

/**
 * More > Shared with you: libraries other households shared with this person, "My home", accepting
 * an invite code, leaving a share and reporting a problem. There is no browsing or searching for
 * libraries: one only appears here after its owner invited this person by email.
 */
@Composable
fun SharedWithYouScreen(onSwitched: () -> Unit) {
    val app = BeeboApp.instance
    val session = app.session
    val scope = rememberCoroutineScope()
    var libraries by remember { mutableStateOf(SharedLibrarySwitcher.libraries(session)) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var accepting by remember { mutableStateOf(false) }
    var passwordFor by remember { mutableStateOf<Pair<SharedLibrary, String>?>(null) } // (library, action)
    var reporting by remember { mutableStateOf<SharedLibrary?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val inShared = session.isGuest

    fun open(lib: SharedLibrary, password: String?) {
        busy = true; error = null
        scope.launch {
            when (val r = SharedLibrarySwitcher.open(session, lib, password)) {
                is RemoteAccess.SignInResult.SignedIn -> { busy = false; onSwitched() }
                is RemoteAccess.SignInResult.NotConnected -> { busy = false; error = r.message }
                is RemoteAccess.SignInResult.Refused -> {
                    busy = false
                    if (password == null) passwordFor = lib to "open" else error = r.message
                }
            }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Shared with you", fontWeight = FontWeight.Bold, fontSize = 20.sp)
        Text(
            "Libraries someone in another household invited you to. You watch straight from their computer; Beebo doesn't host or see what's in them.",
            fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        message?.let { Text(it, color = MaterialTheme.colorScheme.primary, fontSize = 13.sp) }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
                Text("My home", fontWeight = FontWeight.SemiBold)
                Text(if (inShared) "You're watching a shared library right now." else "You're watching your own home's library.",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (inShared) {
                    Button(enabled = !busy, onClick = {
                        busy = true
                        scope.launch {
                            val ok = SharedLibrarySwitcher.backToMyHome(session)
                            busy = false
                            if (ok) onSwitched() else { error = "Sign in to your home again."; onSwitched() }
                        }
                    }) { Text("Back to my home") }
                }
            }
        }

        libraries.forEach { lib ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(lib.title, fontWeight = FontWeight.SemiBold)
                    Text("${lib.name}.beebo.tv · signed in as ${lib.email}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(enabled = !busy, onClick = { open(lib, null) }) { Text("Watch") }
                        TextButton(onClick = { passwordFor = lib to "leave" }) { Text("Leave") }
                        TextButton(onClick = { reporting = lib }) { Text("Report a problem") }
                    }
                }
            }
        }
        if (libraries.isEmpty()) Text("Nothing is shared with you on this phone yet.", fontSize = 13.sp)

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { accepting = true }) { Text("Enter an invite code") }
            OutlinedButton(onClick = { refreshing = true }) { Text("Find my shares") }
        }
        TextButton(onClick = { reporting = SharedLibrary(name = "", ownerLabel = "") }) { Text("Report an invite or share you didn't expect") }
    }

    if (accepting) {
        AcceptInviteDialog(onDismiss = { accepting = false }) { code, email, password, createGuest ->
            accepting = false
            busy = true; error = null
            scope.launch {
                try {
                    val lib = SharedLibrarySwitcher.accept(session, code, email, password, createGuest)
                    libraries = SharedLibrarySwitcher.libraries(session)
                    message = "${lib.title} is now shared with you. Tap Watch to open it."
                } catch (e: Exception) {
                    error = e.message
                } finally {
                    busy = false
                }
            }
        }
    }

    if (refreshing) {
        EmailPasswordDialog(title = "Find the libraries shared with your account", onDismiss = { refreshing = false }) { email, password ->
            refreshing = false
            scope.launch {
                try {
                    libraries = SharedLibrarySwitcher.refresh(session, email, password)
                    message = if (libraries.isEmpty()) "Nothing is shared with that account." else "Updated."
                } catch (e: Exception) {
                    error = e.message
                }
            }
        }
    }

    passwordFor?.let { (lib, action) ->
        PasswordDialog(
            title = if (action == "leave") "Leave ${lib.title}?" else "Sign in to ${lib.title}",
            detail = if (action == "leave") "You won't be able to watch it any more unless they invite you again. Enter the password for ${lib.email}."
            else "Enter the password for ${lib.email}.",
            onDismiss = { passwordFor = null }
        ) { password ->
            passwordFor = null
            if (action == "open") open(lib, password)
            else scope.launch {
                try {
                    SharedLibrarySwitcher.leave(session, lib, password)
                    libraries = SharedLibrarySwitcher.libraries(session)
                    message = "You left ${lib.title}."
                } catch (e: Exception) {
                    error = e.message
                }
            }
        }
    }

    reporting?.let { lib ->
        ReportDialog(lib, onDismiss = { reporting = null }) { reason, details ->
            reporting = null
            scope.launch {
                try {
                    SharedLibrarySwitcher.report(reason.code, details, lib.name.ifBlank { null }, lib.email.ifBlank { null })
                    message = "Thanks. Beebo will look into it."
                } catch (e: Exception) {
                    error = e.message
                }
            }
        }
    }
}

@Composable
private fun AcceptInviteDialog(onDismiss: () -> Unit, onAccept: (String, String, String, Boolean) -> Unit) {
    var code by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var createGuest by remember { mutableStateOf(false) }
    val normalized = InviteCode.normalize(code)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Enter an invite code") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(code, { code = it.take(12) }, label = { Text("Invite code (like ABCD-EFGH)") }, singleLine = true)
                OutlinedTextField(email, { email = it.trim() }, label = { Text("The email the invite was sent to") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
                OutlinedTextField(password, { password = it }, label = { Text("Your Beebo password") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(createGuest, { createGuest = it })
                    Text("No Beebo account? Make a free guest sign-in for this email with this password (8 or more characters).", fontSize = 12.sp)
                }
            }
        },
        confirmButton = { TextButton(enabled = normalized != null && email.contains('@') && password.isNotEmpty(), onClick = { onAccept(normalized!!, email, password, createGuest) }) { Text("Accept") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun EmailPasswordDialog(title: String, onDismiss: () -> Unit, onDone: (String, String) -> Unit) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(email, { email = it.trim() }, label = { Text("Email") }, singleLine = true)
                OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
            }
        },
        confirmButton = { TextButton(enabled = email.contains('@') && password.isNotEmpty(), onClick = { onDone(email, password) }) { Text("OK") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun PasswordDialog(title: String, detail: String, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    var password by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(detail, fontSize = 13.sp)
                OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
            }
        },
        confirmButton = { TextButton(enabled = password.isNotEmpty(), onClick = { onDone(password) }) { Text("OK") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun ReportDialog(lib: SharedLibrary, onDismiss: () -> Unit, onSend: (ShareReportReason, String) -> Unit) {
    var reason by remember { mutableStateOf(ShareReportReason.UNWANTED) }
    var details by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (lib.name.isBlank()) "Report a problem" else "Report a problem with ${lib.title}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ShareReportReason.entries.forEach { r ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(reason == r, { reason = r })
                        Text(r.label, fontSize = 13.sp)
                    }
                }
                OutlinedTextField(details, { details = it.take(2000) }, label = { Text("Anything else Beebo should know (optional)") })
                Text("Goes to Beebo, not to the library's owner.", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = { TextButton(onClick = { onSend(reason, details) }) { Text("Send") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}
