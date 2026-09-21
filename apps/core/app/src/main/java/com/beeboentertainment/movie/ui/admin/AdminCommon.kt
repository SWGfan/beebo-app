package com.beeboentertainment.movie.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.core.AdminErrors
import com.beeboentertainment.movie.data.ForbiddenException
import com.beeboentertainment.movie.data.UnauthorizedException

/**
 * Shared pieces for the admin area.
 *
 * The one thing worth calling out: a 403 from an admin route is NOT a session problem. It means
 * either the connection isn't TLS (`https_required`) or this account isn't an admin
 * (`admin_only`), and both deserve their own explanation rather than being flattened into
 * "please sign in again".
 */

/** Turn any throwable from an admin call into something worth reading. */
fun adminErrorMessage(t: Throwable): String = when (t) {
    is ForbiddenException -> t.message ?: AdminErrors.message(t.error)
    is UnauthorizedException -> AdminErrors.message(AdminErrors.UNAUTHORIZED)
    else -> t.message ?: "Something went wrong talking to the server."
}

/** True when this failure means the session really is gone and we should bounce to login. */
fun isSessionFailure(t: Throwable): Boolean = t is UnauthorizedException

/**
 * Error panel. The HTTPS case gets its own emphasis, because it is the one the owner can fix
 * himself and the one most likely to look like a mysterious outage.
 */
@Composable
fun AdminErrorPanel(message: String, onRetry: (() -> Unit)? = null) {
    val isHttps = message.contains("secure connection", ignoreCase = true)
    Box(
        Modifier
            .fillMaxSize()
            .padding(20.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (isHttps) {
                Text("🔒", fontSize = 32.sp)
                Spacer(Modifier.height(8.dp))
            }
            Text(
                message,
                textAlign = TextAlign.Center,
                color = if (isHttps) MaterialTheme.colorScheme.onBackground
                else MaterialTheme.colorScheme.error
            )
            if (onRetry != null) {
                TextButton(onClick = onRetry) { Text("Try again") }
            }
        }
    }
}

/** A labelled count tile for the Overview grid. */
@Composable
fun AdminStatCard(
    label: String,
    value: String,
    detail: String? = null,
    highlight: Boolean = false,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier,
        colors = if (highlight) {
            CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary)
        } else CardDefaults.cardColors()
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(
                value,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = if (highlight) MaterialTheme.colorScheme.onPrimary
                else MaterialTheme.colorScheme.onSurface
            )
            Text(
                label,
                fontSize = 12.sp,
                color = if (highlight) MaterialTheme.colorScheme.onPrimary
                else MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (!detail.isNullOrBlank()) {
                Text(
                    detail,
                    fontSize = 10.sp,
                    color = if (highlight) MaterialTheme.colorScheme.onPrimary
                    else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/** One row in a list of things, with its actions underneath. */
@Composable
fun AdminRowCard(
    title: String,
    subtitle: String? = null,
    detail: String? = null,
    actions: @Composable () -> Unit = {}
) {
    Card(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp)
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(title, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            if (!subtitle.isNullOrBlank()) {
                Text(subtitle, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!detail.isNullOrBlank()) {
                Text(detail, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.height(4.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End
            ) { actions() }
        }
    }
}

/**
 * Every destructive admin action goes through this: the message names exactly what will happen,
 * because several of these delete real files that have no other copy.
 */
@Composable
fun AdminConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String,
    destructive: Boolean = true,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = {
            TextButton(onClick = { onDismiss(); onConfirm() }) {
                Text(
                    confirmLabel,
                    color = if (destructive) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.primary
                )
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

/**
 * The one-shot credential dialog.
 *
 * regenerate-code and requests/approve are the only places this API ever returns a credential,
 * and it can never be read back — so this is deliberately blunt about writing it down.
 */
@Composable
fun AdminCodeDialog(code: String, forName: String, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Access code for $forName") },
        text = {
            Column {
                Text(
                    code,
                    fontSize = 30.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )
                Spacer(Modifier.height(10.dp))
                Text(
                    "Write this down now — it can't be shown again. If it's lost, generate a " +
                        "new one, which replaces this.",
                    fontSize = 12.sp
                )
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("I've saved it") } }
    )
}

/** Byte counts for the storage card. */
fun adminFormatBytes(bytes: Long): String = com.beeboentertainment.movie.core.formatBytes(bytes)

/** Millisecond timestamps as something short and human. */
fun adminFormatTime(epochMs: Long?): String {
    if (epochMs == null || epochMs <= 0L) return "—"
    return runCatching {
        java.text.SimpleDateFormat("d MMM yyyy, HH:mm", java.util.Locale.getDefault())
            .format(java.util.Date(epochMs))
    }.getOrDefault("—")
}

@Composable
fun AdminSpacerWidth(width: Int) = Spacer(Modifier.width(width.dp))
