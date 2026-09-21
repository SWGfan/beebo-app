package com.beeboentertainment.movie.account

import android.app.Activity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Settings > Delete my account. Lists each account this phone is signed in to, says exactly what
 * deleting it removes, asks for that account's password again, confirms once more, then deletes it
 * and signs this phone out of it.
 */
@Composable
fun DeleteAccountSection() {
    var open by remember { mutableStateOf(false) }
    var refresh by remember { mutableStateOf(0) }
    val accounts = remember(open, refresh) { AccountDeleter.accountsOnThisPhone() }

    Text("Delete my account", style = MaterialTheme.typography.titleLarge)
    if (!open) {
        Text(
            "Permanently delete an account you use in this app, and the personal data that goes with it.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedButton(onClick = { open = true }) { Text("Delete my account...") }
        return
    }

    if (accounts.isEmpty()) {
        Text(
            "This phone isn't signed in to an account. To delete an account without the app, visit " +
                AccountDeletion.WEB_PAGE_TEXT + " in a web browser.",
            style = MaterialTheme.typography.bodyMedium,
        )
    }
    accounts.forEach { account ->
        AccountCard(account, onDeleted = { refresh++ })
    }
    Text(
        "You can also delete these accounts on the web, without the app: " + AccountDeletion.WEB_PAGE_TEXT,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    TextButton(onClick = { open = false }) { Text("Close") }
}

@Composable
private fun AccountCard(account: AccountDeletion.Account, onDeleted: () -> Unit) {
    val scope = rememberCoroutineScope()
    val activity = LocalContext.current as? Activity
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(account.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            account.who?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            Text(account.explanation, style = MaterialTheme.typography.bodyMedium)
            OutlinedTextField(
                value = password,
                onValueChange = { password = it; message = null },
                label = { Text(if (account.kind == AccountDeletion.Kind.HOME_MEMBER) "Your password or code" else "Password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                enabled = !busy && password.isNotEmpty(),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                onClick = { confirm = true },
            ) { Text(if (busy) "Deleting..." else "Delete this account") }
            message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        }
    }

    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Delete ${account.title.replaceFirstChar { it.lowercase() }}?") },
            text = { Text("This can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    busy = true
                    scope.launch {
                        when (val out = AccountDeleter.delete(account, password)) {
                            is AccountDeletion.Outcome.Deleted -> {
                                password = ""
                                if (account.kind == AccountDeletion.Kind.HUB) onDeleted()
                                // Signed out of the home Beebo: start again at the sign-in screen.
                                else activity?.recreate()
                            }
                            is AccountDeletion.Outcome.NotDeleted -> message = out.message
                        }
                        busy = false
                    }
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
        )
    }
}
