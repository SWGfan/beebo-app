package com.beeboentertainment.movie.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.AdminErrors
import com.beeboentertainment.movie.core.OwnerPin
import com.beeboentertainment.movie.core.ParentalSummary
import com.beeboentertainment.movie.data.AdminParentalResponse
import com.beeboentertainment.movie.data.AdminParentalSetRequest
import com.beeboentertainment.movie.data.AdminSharesResponse
import com.beeboentertainment.movie.data.Bedtime
import com.beeboentertainment.movie.data.CreateShareRequest
import com.beeboentertainment.movie.data.OwnerShare
import com.beeboentertainment.movie.data.ParentalExtra
import com.beeboentertainment.movie.data.ParentalMember
import com.beeboentertainment.movie.data.ParentalPolicy
import com.beeboentertainment.movie.data.ShareConsent
import com.beeboentertainment.movie.ui.LoadingBox
import kotlinx.coroutines.launch

/**
 * Owner tools > Family: parental controls per household member, the owner PIN, and sharing
 * the library with other households. Everything here is enforced by the home computer
 * (electron/contentGate.js); this screen edits the settings. Adult-facing wording only.
 */
@Composable
fun AdminFamilyTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    val scope = rememberCoroutineScope()
    var parental by remember { mutableStateOf<AdminParentalResponse?>(null) }
    var shares by remember { mutableStateOf<AdminSharesResponse?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    var editing by remember { mutableStateOf<ParentalMember?>(null) }
    var pinDialog by remember { mutableStateOf(false) }
    var shareDialog by remember { mutableStateOf(false) }
    var revoking by remember { mutableStateOf<OwnerShare?>(null) }
    var adultSaving by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(reload) {
        try {
            parental = app.api.adminParental()
            shares = app.api.adminShares()
            error = null
        } catch (t: Throwable) {
            if (isSessionFailure(t)) { onUnauthorized(); return@LaunchedEffect }
            error = adminErrorMessage(t)
        }
    }

    val p = parental
    when {
        p == null && error != null -> { AdminErrorPanel(error!!) { reload++ }; return }
        p == null -> { LoadingBox(); return }
    }
    val data = p!!

    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Text("Parental controls", fontWeight = FontWeight.Bold, fontSize = 17.sp, modifier = Modifier.padding(top = 12.dp))
            Text(
                "Set what each person can watch. Your Beebo computer hides and refuses anything over the limit on every screen: this app, the car app, casting, downloads and the website.",
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        notice?.let { item { Text(it, color = MaterialTheme.colorScheme.primary, fontSize = 13.sp) } }
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) } }
        items(data.users, key = { it.id }) { member ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(member.name.ifBlank { member.username }, fontWeight = FontWeight.SemiBold)
                    val pol = member.policy
                    Text(
                        if (member.isAdmin) "Admin: runs the server, no limits" else ParentalSummary.of(
                            pol.enabled, pol.movieMax, pol.tvMax, pol.blockUnrated, pol.allowListOnly,
                            pol.dailyLimitMinutes, pol.bedtime?.start, pol.bedtime?.end
                        ),
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = member.adult,
                            modifier = Modifier.semantics { contentDescription = "Adult profile for ${member.name.ifBlank { member.username }}" },
                            enabled = adultSaving == null && !member.viewingHistoryPrivate,
                            onCheckedChange = { adult ->
                                adultSaving = member.id
                                error = null
                                notice = null
                                scope.launch {
                                    try {
                                        val (code, result) = app.api.adminSetAdult(member.id, adult)
                                        if (code in 200..299 && result.ok) {
                                            parental = parental?.let { family -> family.copy(users = family.users.map { if (it.id == member.id) it.copy(adult = result.adult) else it }) }
                                            notice = if (adult) "${member.name.ifBlank { member.username }} is labelled Adult. They can choose their own viewing privacy in Settings."
                                                else "Adult label removed."
                                        } else {
                                            error = when {
                                                code == 404 -> "Update the Beebo desktop program to manage adult profile labels."
                                                result.message.isNotBlank() -> result.message
                                                else -> AdminErrors.message(result.error)
                                            }
                                        }
                                    } catch (failure: kotlinx.coroutines.CancellationException) {
                                        throw failure
                                    } catch (failure: Exception) {
                                        error = adminErrorMessage(failure)
                                    } finally {
                                        adultSaving = null
                                    }
                                }
                            },
                        )
                        Text("Adult profile", style = MaterialTheme.typography.bodyMedium)
                    }
                    if (member.viewingHistoryPrivate) {
                        Text(
                            "Viewing history is private. This person controls the setting. Usage totals remain available; their adult label and parental limits cannot be changed while privacy is on.",
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else if (member.adult) {
                        Text("This person can choose viewing privacy in their own Settings after setting a personal sign-in password.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!member.isAdmin) {
                        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            data.options.presets.forEach { preset ->
                                val selected = (if (pol.enabled) pol.preset else "off") == preset.id
                                FilterChip(
                                    selected = selected,
                                    enabled = !member.viewingHistoryPrivate,
                                    onClick = {
                                        scope.launch {
                                            try {
                                                val extra = if (pol.enabled) ParentalExtra(pol.dailyLimitMinutes, pol.bedtime) else null
                                                val r = app.api.adminSetParental(AdminParentalSetRequest(member.id, preset = preset.id, extra = extra))
                                                if (!r.ok) error = AdminErrors.message(r.error) else { notice = "Saved for ${member.name}."; reload++ }
                                            } catch (t: Throwable) {
                                                if (isSessionFailure(t)) onUnauthorized() else error = adminErrorMessage(t)
                                            }
                                        }
                                    },
                                    label = { Text(shortPresetLabel(preset.id, preset.label), fontSize = 11.sp) }
                                )
                            }
                        }
                        TextButton(enabled = !member.viewingHistoryPrivate, onClick = { editing = member }) { Text("Bedtime and daily limit") }
                    }
                }
            }
        }
        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text("Owner PIN ${if (data.pinSet) "(set)" else "(not set)"}", fontWeight = FontWeight.SemiBold)
                    Text(
                        "Asked for on a shared phone before anyone leaves a profile with parental controls, moves to a profile with more access, or changes a profile's limits there.",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    TextButton(onClick = { pinDialog = true }) { Text(if (data.pinSet) "Change PIN" else "Set PIN") }
                }
            }
        }

        // ---------------- sharing ----------------
        item {
            Text("Share your library with another household", fontWeight = FontWeight.Bold, fontSize = 17.sp, modifier = Modifier.padding(top = 12.dp))
            Text(
                "Invite one person at a time by email. They watch in their own Beebo app, straight from your computer. No public links, nobody can search for your library, and you can stop sharing at any time. Only share media you own or have the rights to share.",
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Button(onClick = { shareDialog = true }, modifier = Modifier.padding(top = 6.dp)) { Text("Invite someone") }
        }
        val list = shares?.shares.orEmpty()
        if (list.isEmpty()) item { Text("You aren't sharing with anyone.", fontSize = 13.sp) }
        items(list, key = { it.id }) { s ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text("${s.guestLabel} · ${s.guestEmail}", fontWeight = FontWeight.SemiBold)
                    Text(
                        shareStatus(s.status) + " · " + s.libraries.joinToString(" and ") { if (it == "movies") "Films" else "TV" } +
                            " · ${s.maxStreams} screen(s) · downloads ${if (s.downloads) "on" else "off"}",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    s.inviteCode?.let { Text("Invite code to give them: $it", fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
                    if (s.status == "pending" || s.status == "active") {
                        TextButton(onClick = { revoking = s }) { Text("Stop sharing", color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
        }
        item { Text("", modifier = Modifier.padding(bottom = 24.dp)) }
    }

    editing?.let { member ->
        TimeLimitsDialog(member, onDismiss = { editing = null }) { minutes, bedtime ->
            editing = null
            scope.launch {
                try {
                    val base = member.policy
                    val next = if (base.enabled) base.copy(dailyLimitMinutes = minutes, bedtime = bedtime, preset = "custom")
                    else ParentalPolicy(enabled = true, preset = "custom", dailyLimitMinutes = minutes, bedtime = bedtime)
                    val r = app.api.adminSetParental(AdminParentalSetRequest(member.id, policy = next))
                    if (!r.ok) error = AdminErrors.message(r.error) else { notice = "Saved for ${member.name}."; reload++ }
                } catch (t: Throwable) {
                    if (isSessionFailure(t)) onUnauthorized() else error = adminErrorMessage(t)
                }
            }
        }
    }

    if (pinDialog) {
        PinSetDialog(pinSet = data.pinSet, onDismiss = { pinDialog = false }) { newPin, current ->
            pinDialog = false
            scope.launch {
                try {
                    val (_, r) = app.api.adminSetPin(newPin, current)
                    if (r.ok) { notice = "PIN saved."; reload++ } else error = AdminErrors.message(r.error)
                } catch (t: Throwable) {
                    error = adminErrorMessage(t)
                }
            }
        }
    }

    if (shareDialog) {
        val sh = shares
        InviteDialog(statement = sh?.statement.orEmpty(), termsVersion = sh?.termsVersion.orEmpty(), onDismiss = { shareDialog = false }) { req ->
            shareDialog = false
            scope.launch {
                try {
                    val r = app.api.adminCreateShare(req)
                    val made = r.share
                    if (!r.ok || made == null) error = AdminErrors.message(r.error)
                    else {
                        notice = "Invite created for ${made.guestEmail}. If no email arrives, give them the invite code shown on their row once your computer has sent it to beebo.tv."
                        reload++
                    }
                } catch (t: Throwable) {
                    if (isSessionFailure(t)) onUnauthorized() else error = adminErrorMessage(t)
                }
            }
        }
    }

    revoking?.let { s ->
        AlertDialog(
            onDismissRequest = { revoking = null },
            title = { Text("Stop sharing with ${s.guestLabel}?") },
            text = { Text("They lose access straight away. Anything already playing stops within a minute.") },
            confirmButton = {
                TextButton(onClick = {
                    revoking = null
                    scope.launch {
                        try { app.api.adminRevokeShare(s.id); notice = "Sharing stopped."; reload++ } catch (t: Throwable) {
                            if (isSessionFailure(t)) onUnauthorized() else error = adminErrorMessage(t)
                        }
                    }
                }) { Text("Stop sharing") }
            },
            dismissButton = { TextButton(onClick = { revoking = null }) { Text("Cancel") } }
        )
    }
}

private fun shortPresetLabel(id: String, label: String): String = when (id) {
    "young" -> "Under 7"
    "kids" -> "7 to 12"
    "teens" -> "Teens"
    "off" -> "Off"
    else -> label
}

private fun shareStatus(status: String): String = when (status) {
    "pending" -> "Invited"
    "active" -> "Watching"
    "revoked" -> "Stopped"
    "left" -> "They left"
    "declined" -> "They said no"
    "expired" -> "Expired"
    else -> status
}

@Composable
private fun TimeLimitsDialog(member: ParentalMember, onDismiss: () -> Unit, onSave: (Int?, Bedtime?) -> Unit) {
    var minutes by remember { mutableStateOf(member.policy.dailyLimitMinutes?.toString() ?: "") }
    var start by remember { mutableStateOf(member.policy.bedtime?.start ?: "") }
    var end by remember { mutableStateOf(member.policy.bedtime?.end ?: "") }
    val minutesOk = minutes.isBlank() || (minutes.toIntOrNull() ?: 0) in 1..1440
    val bedtimeOk = (start.isBlank() && end.isBlank()) || (ParentalSummary.validTime(start) && ParentalSummary.validTime(end) && start != end)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Bedtime and daily limit for ${member.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(minutes, { minutes = it.filter(Char::isDigit).take(4) }, label = { Text("Minutes of watching each day (blank = no limit)") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true)
                OutlinedTextField(start, { start = it.take(5) }, label = { Text("No watching from (HH:MM, e.g. 21:00)") }, singleLine = true)
                OutlinedTextField(end, { end = it.take(5) }, label = { Text("Until (HH:MM, e.g. 07:00)") }, singleLine = true)
                if (!minutesOk || !bedtimeOk) Text("Check the times (24-hour HH:MM) and minutes.", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
            }
        },
        confirmButton = {
            TextButton(enabled = minutesOk && bedtimeOk, onClick = {
                onSave(minutes.toIntOrNull(), if (start.isBlank()) null else Bedtime(start, end))
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun PinSetDialog(pinSet: Boolean, onDismiss: () -> Unit, onSave: (String, String?) -> Unit) {
    var pin by remember { mutableStateOf("") }
    var current by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (pinSet) "Change the owner PIN" else "Set the owner PIN") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (pinSet) OutlinedTextField(current, { current = it.filter(Char::isDigit).take(8) }, label = { Text("Current PIN") },
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), singleLine = true)
                OutlinedTextField(pin, { pin = it.filter(Char::isDigit).take(8) }, label = { Text("New PIN (4 to 8 digits)") },
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), singleLine = true)
            }
        },
        confirmButton = { TextButton(enabled = OwnerPin.valid(pin) && (!pinSet || OwnerPin.valid(current)), onClick = { onSave(pin, current.ifBlank { null }) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun InviteDialog(statement: String, termsVersion: String, onDismiss: () -> Unit, onCreate: (CreateShareRequest) -> Unit) {
    var email by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var films by remember { mutableStateOf(true) }
    var tv by remember { mutableStateOf(true) }
    var downloads by remember { mutableStateOf(false) }
    var screens by remember { mutableStateOf(1) }
    var preset by remember { mutableStateOf("off") }
    var consent by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Invite someone") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(email, { email = it.trim() }, label = { Text("Their email") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
                OutlinedTextField(label, { label = it.take(60) }, label = { Text("Name to show you (optional)") }, singleLine = true)
                CheckRow("Films", films) { films = it }
                CheckRow("TV shows", tv) { tv = it }
                CheckRow("Allow downloads", downloads) { downloads = it }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Screens at once: $screens", fontSize = 13.sp)
                    TextButton(onClick = { if (screens > 1) screens-- }) { Text("-") }
                    TextButton(onClick = { if (screens < 5) screens++ }) { Text("+") }
                }
                Text("Limits for what they can watch", fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    listOf("off" to "None", "teens" to "Teens", "kids" to "7 to 12", "young" to "Under 7").forEach { (id, name) ->
                        FilterChip(selected = preset == id, onClick = { preset = id }, label = { Text(name, fontSize = 11.sp) })
                    }
                }
                Row(verticalAlignment = Alignment.Top) {
                    Checkbox(consent, { consent = it })
                    Text("$statement (Sharing terms $termsVersion. Saved with the share, with the time.)", fontSize = 12.sp, modifier = Modifier.padding(top = 12.dp))
                }
            }
        },
        confirmButton = {
            TextButton(enabled = consent && email.contains('@') && (films || tv) && termsVersion.isNotBlank(), onClick = {
                onCreate(CreateShareRequest(
                    guestEmail = email, guestLabel = label.trim(),
                    libraries = listOfNotNull("movies".takeIf { films }, "tv".takeIf { tv }),
                    maxStreams = screens, downloads = downloads, parentalPreset = preset,
                    consent = ShareConsent(accepted = true, termsVersion = termsVersion),
                ))
            }) { Text("Send invite") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun CheckRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked, onChange)
        Text(label, fontSize = 13.sp)
    }
}
