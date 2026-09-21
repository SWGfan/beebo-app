package com.beeboentertainment.movie.ui.sharing

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.AdminErrors
import com.beeboentertainment.movie.core.OwnerPin
import com.beeboentertainment.movie.data.ParentalStatusResponse
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.data.User
import kotlinx.coroutines.launch

/**
 * More > Switch profile: a shared phone or TV moving between the household's profiles. Leaving a
 * profile with parental controls, or moving to one with more access, needs the owner PIN (the
 * home computer checks it and locks after five wrong tries).
 */
@Composable
fun ProfilesScreen(onSwitched: () -> Unit, onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    val scope = rememberCoroutineScope()
    var profiles by remember { mutableStateOf<List<User>>(emptyList()) }
    var status by remember { mutableStateOf<ParentalStatusResponse?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var askPinFor by remember { mutableStateOf<User?>(null) }

    LaunchedEffect(Unit) {
        try {
            profiles = app.api.profiles().profiles
            status = runCatching { app.api.parentalStatus() }.getOrNull()
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            error = e.message
        }
    }

    fun switchTo(user: User, pin: String?) {
        scope.launch {
            try {
                val (code, r) = app.api.switchProfile(user.id, pin)
                val token = r.token
                if (code == 200 && r.ok && token != null) {
                    app.session.saveLogin(token, r.user)
                    onSwitched()
                } else if (code == 401 && pin == null) {
                    askPinFor = user
                } else {
                    error = AdminErrors.message(r.error)
                }
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Switch profile", fontWeight = FontWeight.Bold, fontSize = 20.sp)
        status?.let { s ->
            if (s.restricted && !s.guest) {
                Text(
                    "This profile has parental controls on." + (if (!s.canWatchNow) " ${s.message.orEmpty()}" else ""),
                    fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
        profiles.forEach { p ->
            val current = p.id == app.session.userId
            Card(Modifier.fillMaxWidth().clickable(enabled = !current) { switchTo(p, null) }) {
                Column(Modifier.padding(12.dp)) {
                    Text(p.name + if (current) "  (this profile)" else "", fontWeight = FontWeight.SemiBold)
                    Text(
                        when {
                            p.viewingHistoryPrivate -> "Private viewing · sign in with this person's own password"
                            p.isAdmin -> "Runs this Beebo"
                            p.restricted -> "Parental controls on"
                            p.adult -> "Adult profile"
                            else -> "No limits"
                        },
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }

    askPinFor?.let { user ->
        var pin by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { askPinFor = null },
            title = { Text("Owner PIN") },
            text = {
                Column {
                    Text("Switching to ${user.name} needs the owner PIN.", fontSize = 13.sp)
                    OutlinedTextField(pin, { pin = it.filter(Char::isDigit).take(8) }, label = { Text("PIN") }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
                }
            },
            confirmButton = { TextButton(enabled = OwnerPin.valid(pin), onClick = { askPinFor = null; switchTo(user, pin) }) { Text("Switch") } },
            dismissButton = { TextButton(onClick = { askPinFor = null }) { Text("Cancel") } }
        )
    }
}
