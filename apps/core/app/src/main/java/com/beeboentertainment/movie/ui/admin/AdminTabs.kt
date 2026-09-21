package com.beeboentertainment.movie.ui.admin

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.AdminErrors
import com.beeboentertainment.movie.core.ContinueFormat
import com.beeboentertainment.movie.core.formatMs
import com.beeboentertainment.movie.data.AdminAccessRequest
import com.beeboentertainment.movie.data.AdminConversion
import com.beeboentertainment.movie.data.AdminFlag
import com.beeboentertainment.movie.data.AdminHistoryItem
import com.beeboentertainment.movie.data.AdminMarker
import com.beeboentertainment.movie.data.AdminMissing
import com.beeboentertainment.movie.data.AdminSettings
import com.beeboentertainment.movie.data.AdminSettingsUpdateRequest
import com.beeboentertainment.movie.ui.LoadingBox
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A pending confirmation: what to say, and what to do if they say yes. */
private data class PendingAction(
    val title: String,
    val message: String,
    val confirmLabel: String,
    val destructive: Boolean,
    val run: suspend () -> String?
)

/**
 * Shared skeleton for the list tabs. Each one loads a list, shows a notice line for the last
 * result, and runs confirmed actions that return either null (fine) or a message to show.
 */
@Composable
private fun <T> AdminListTab(
    onUnauthorized: () -> Unit,
    emptyMessage: String,
    load: suspend () -> List<T>,
    key: (T) -> Any,
    row: @Composable (T, (PendingAction) -> Unit) -> Unit
) {
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf<List<T>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var pending by remember { mutableStateOf<PendingAction?>(null) }

    LaunchedEffect(reloadKey) {
        loading = true
        try {
            items = load()
            error = null
        } catch (t: Throwable) {
            if (isSessionFailure(t)) { onUnauthorized(); return@LaunchedEffect }
            error = adminErrorMessage(t)
        } finally {
            loading = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        notice?.let {
            Text(
                it,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)
            )
        }
        when {
            loading && items.isEmpty() -> LoadingBox()
            error != null && items.isEmpty() -> AdminErrorPanel(error!!) { reloadKey++ }
            items.isEmpty() -> AdminErrorPanel(emptyMessage) { reloadKey++ }
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(items, key = key) { item ->
                    row(item) { action -> pending = action }
                }
            }
        }
    }

    pending?.let { action ->
        AdminConfirmDialog(
            title = action.title,
            message = action.message,
            confirmLabel = action.confirmLabel,
            destructive = action.destructive,
            onConfirm = {
                scope.launch {
                    try {
                        notice = action.run()
                        reloadKey++
                    } catch (t: Throwable) {
                        if (isSessionFailure(t)) onUnauthorized() else notice = adminErrorMessage(t)
                    }
                }
            },
            onDismiss = { pending = null }
        )
    }
}

/* ------------------------------- requests -------------------------------- */

@Composable
fun AdminRequestsTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    var codeToShow by remember { mutableStateOf<Pair<String, String>?>(null) }

    AdminListTab<AdminAccessRequest>(
        onUnauthorized = onUnauthorized,
        emptyMessage = "No access requests waiting.",
        load = { app.api.adminRequests("pending").requests },
        key = { it.id }
    ) { request, confirm ->
        AdminRowCard(
            title = request.name,
            subtitle = request.email,
            detail = (request.message.takeIf { it.isNotBlank() }?.plus(" · ") ?: "") +
                adminFormatTime(request.createdAt)
        ) {
            TextButton(onClick = {
                confirm(
                    PendingAction(
                        "Approve ${request.name}?",
                        "This creates their account and generates an access code, which is " +
                            "shown once and can't be looked up again.",
                        "Approve", false
                    ) {
                        val r = app.api.adminApproveRequest(request.id)
                        if (!r.ok) AdminErrors.message(r.error)
                        else {
                            r.code?.let { codeToShow = it to request.name }
                            "${request.name} approved."
                        }
                    }
                )
            }) { Text("Approve") }
            TextButton(onClick = {
                confirm(
                    PendingAction(
                        "Deny ${request.name}?",
                        "Their request is dismissed. No account is created and they aren't told.",
                        "Deny", true
                    ) {
                        val r = app.api.adminDenyRequest(request.id)
                        if (!r.ok) AdminErrors.message(r.error) else "Request denied."
                    }
                )
            }) { Text("Deny") }
        }
    }

    codeToShow?.let { (code, name) ->
        AdminCodeDialog(code, name) { codeToShow = null }
    }
}

/* --------------------------------- flags --------------------------------- */

@Composable
fun AdminFlagsTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    AdminListTab<AdminFlag>(
        onUnauthorized = onUnauthorized,
        emptyMessage = "Nothing has been flagged for bad quality.",
        load = { app.api.adminFlags().flags },
        key = { it.id }
    ) { flag, confirm ->
        val who = flag.flaggedBy.joinToString(", ") { it.userName }.ifBlank { "someone" }
        AdminRowCard(
            title = flag.title.ifBlank { flag.displayPath },
            subtitle = flag.displayPath,
            detail = "flagged by $who · ${adminFormatTime(flag.firstFlaggedAt)}" +
                if (flag.resolved) " · resolved" else ""
        ) {
            if (!flag.resolved) {
                TextButton(onClick = {
                    confirm(
                        PendingAction(
                            "Mark as sorted?",
                            "Marks this flag resolved. The file itself isn't touched.",
                            "Mark resolved", false
                        ) {
                            val r = app.api.adminResolveFlag(flag.id)
                            if (!r.ok) AdminErrors.message(r.error) else "Flag resolved."
                        }
                    )
                }) { Text("Resolve") }
            }
            TextButton(onClick = {
                confirm(
                    PendingAction(
                        "Remove this flag?",
                        "Drops the report from the list. The file itself isn't touched.",
                        "Remove", true
                    ) {
                        val r = app.api.adminRemoveFlag(flag.id)
                        if (!r.ok) AdminErrors.message(r.error) else "Flag removed."
                    }
                )
            }) { Text("Remove") }
        }
    }
}

/* ------------------------------ missing files ---------------------------- */

@Composable
fun AdminMissingTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    AdminListTab<AdminMissing>(
        onUnauthorized = onUnauthorized,
        emptyMessage = "Nobody's asked for anything that's missing.",
        load = { app.api.adminMissing().missing },
        key = { it.id }
    ) { row, confirm ->
        val where = when {
            row.season != null && row.episode != null -> "S${row.season}E${row.episode}"
            row.collectionName != null -> row.collectionName
            else -> null
        }
        val who = row.requestedBy.joinToString(", ") { it.userName }.ifBlank { "someone" }
        AdminRowCard(
            title = listOfNotNull(row.showName ?: row.title, where).joinToString(" "),
            subtitle = row.title,
            detail = "asked for by $who · ${adminFormatTime(row.firstSeenAt)}" +
                if (row.resolved) " · resolved" else ""
        ) {
            if (!row.resolved) {
                TextButton(onClick = {
                    confirm(
                        PendingAction(
                            "Mark as sorted?",
                            "Marks this request resolved — use it once the file is on the server.",
                            "Mark resolved", false
                        ) {
                            val r = app.api.adminResolveMissing(row.id)
                            if (!r.ok) AdminErrors.message(r.error) else "Marked resolved."
                        }
                    )
                }) { Text("Resolve") }
            }
            TextButton(onClick = {
                confirm(
                    PendingAction(
                        "Remove this request?",
                        "Drops it from the list without getting the file.",
                        "Remove", true
                    ) {
                        val r = app.api.adminRemoveMissing(row.id)
                        if (!r.ok) AdminErrors.message(r.error) else "Request removed."
                    }
                )
            }) { Text("Remove") }
        }
    }
}

/* ------------------------------- conversions ------------------------------ */

/**
 * The only tab that deletes real files, so its two delete actions spell out exactly which copy
 * goes and which one survives. The server runs its own guardrails and refuses with a 200
 * {ok:false,error} — those are shown verbatim through AdminErrors rather than silently ignored.
 */
@Composable
fun AdminConversionsTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    val scope = rememberCoroutineScope()

    var conversions by remember { mutableStateOf<List<AdminConversion>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var pending by remember { mutableStateOf<PendingAction?>(null) }
    val lifecycleOwner = LocalLifecycleOwner.current

    // Progress is live, so this one refreshes while anything is actually converting — but only
    // while the app is on screen (STARTED); in the background the loop is suspended.
    LaunchedEffect(reloadKey) {
        var signedOut = false
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if (signedOut) return@repeatOnLifecycle
            while (true) {
                try {
                    conversions = app.api.adminConversions().conversions
                    error = null
                } catch (t: Throwable) {
                    if (isSessionFailure(t)) { signedOut = true; onUnauthorized(); return@repeatOnLifecycle }
                    error = adminErrorMessage(t)
                } finally {
                    loading = false
                }
                delay(if (conversions.any { it.isRunning }) 5_000 else 30_000)
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        notice?.let {
            Text(
                it,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)
            )
        }
        when {
            loading && conversions.isEmpty() -> LoadingBox()
            error != null && conversions.isEmpty() -> AdminErrorPanel(error!!) { reloadKey++ }
            conversions.isEmpty() -> AdminErrorPanel("Nothing in the conversion queue.") { reloadKey++ }
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(conversions, key = { it.id }) { c ->
                    AdminRowCard(
                        title = c.fileName,
                        subtitle = c.statusLabel + ((c.error ?: c.notNeededReason?.takeIf { c.status == "not-needed" || c.status == "skipped" })?.let { " — $it" } ?: ""),
                        detail = "original ${adminFormatBytes(c.originalBytes)}" +
                            (c.convertedBytes?.let { " → ${adminFormatBytes(it)}" } ?: "") +
                            (if (c.originalDeleted) " · original deleted" else "")
                    ) {
                        if (c.isRetryable) {
                            TextButton(onClick = {
                                pending = PendingAction(
                                    "Convert again?",
                                    "Puts \"${c.fileName}\" back in the queue.",
                                    "Convert again", false
                                ) {
                                    val r = app.api.adminRetryConversion(c.id)
                                    if (!r.ok) AdminErrors.message(r.error) else "Re-queued."
                                }
                            }) { Text("Retry") }
                        }
                        if (c.isDone && !c.originalDeleted) {
                            TextButton(onClick = {
                                pending = PendingAction(
                                    "Delete the ORIGINAL file?",
                                    "Permanently deletes the original of \"${c.fileName}\" " +
                                        "(${adminFormatBytes(c.originalBytes)}) from the server's " +
                                        "disk. The converted copy is kept. This cannot be undone.",
                                    "Delete original", true
                                ) {
                                    val r = app.api.adminDeleteOriginal(c.id)
                                    if (!r.ok) AdminErrors.message(r.error) else "Original deleted."
                                }
                            }) { Text("Delete original") }
                        }
                        if (!c.outputPath.isNullOrBlank()) {
                            TextButton(onClick = {
                                pending = PendingAction(
                                    "Delete the CONVERTED copy?",
                                    "Permanently deletes the converted copy of \"${c.fileName}\". " +
                                        "The original is kept, and this entry is marked rejected " +
                                        "so it won't be converted again automatically.",
                                    "Delete converted", true
                                ) {
                                    val r = app.api.adminDeleteConverted(c.id)
                                    if (!r.ok) AdminErrors.message(r.error) else "Converted copy deleted."
                                }
                            }) { Text("Delete converted") }
                        }
                        TextButton(onClick = {
                            pending = PendingAction(
                                "Forget this entry?",
                                "Removes the row from the queue list. No file on disk is touched.",
                                "Forget", false
                            ) {
                                val r = app.api.adminForgetConversion(c.id)
                                if (!r.ok) AdminErrors.message(r.error) else "Entry forgotten."
                            }
                        }) { Text("Forget") }
                    }
                    if (c.isRunning) {
                        LinearProgressIndicator(
                            progress = { (c.progressPct.coerceIn(0, 100)) / 100f },
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 22.dp)
                        )
                        Text(
                            "${c.progressPct}%",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 22.dp, bottom = 6.dp)
                        )
                    }
                }
            }
        }
    }

    pending?.let { action ->
        AdminConfirmDialog(
            title = action.title,
            message = action.message,
            confirmLabel = action.confirmLabel,
            destructive = action.destructive,
            onConfirm = {
                scope.launch {
                    try {
                        notice = action.run()
                        reloadKey++
                    } catch (t: Throwable) {
                        if (isSessionFailure(t)) onUnauthorized() else notice = adminErrorMessage(t)
                    }
                }
            },
            onDismiss = { pending = null }
        )
    }
}

/* --------------------------------- history -------------------------------- */

@Composable
fun AdminHistoryTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    AdminListTab<AdminHistoryItem>(
        onUnauthorized = onUnauthorized,
        emptyMessage = "Nobody's watched anything yet.",
        load = { app.api.adminHistory().items },
        key = { it.sessionId }
    ) { row, confirm ->
        AdminRowCard(
            title = row.title,
            subtitle = "${row.userName} · ${row.fileName}",
            detail = ContinueFormat.subtitle(null, row.currentTime, row.duration) +
                " · ${adminFormatTime(row.lastUpdate)}"
        ) {
            TextButton(onClick = {
                confirm(
                    PendingAction(
                        "Remove this entry?",
                        "Removes ${row.userName}'s history for \"${row.fileName}\". " +
                            "Only their history is affected.",
                        "Remove", true
                    ) {
                        val r = app.api.adminClearHistory("one", row.userId, fileName = row.fileName)
                        if (!r.ok) AdminErrors.message(r.error) else "Removed ${r.removed} entry."
                    }
                )
            }) { Text("Remove") }
            TextButton(onClick = {
                confirm(
                    PendingAction(
                        "Remove all of this show?",
                        "Removes every entry ${row.userName} has for \"${row.title}\".",
                        "Remove show", true
                    ) {
                        val r = app.api.adminClearHistory("show", row.userId, title = row.title)
                        if (!r.ok) AdminErrors.message(r.error) else "Removed ${r.removed} entries."
                    }
                )
            }) { Text("All of show") }
            TextButton(onClick = {
                confirm(
                    PendingAction(
                        "Clear ALL of ${row.userName}'s history?",
                        "Removes everything ${row.userName} has ever watched. This can't be undone.",
                        "Clear all", true
                    ) {
                        val r = app.api.adminClearHistory("all", row.userId)
                        if (!r.ok) AdminErrors.message(r.error) else "Removed ${r.removed} entries."
                    }
                )
            }) { Text("Clear user") }
        }
    }
}

/* --------------------------------- markers -------------------------------- */

@Composable
fun AdminMarkersTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    AdminListTab<AdminMarker>(
        onUnauthorized = onUnauthorized,
        emptyMessage = "No intro or credits markers have been set.",
        load = { app.api.adminMarkers().markers },
        key = { it.id }
    ) { marker, confirm ->
        val intro = marker.introEndSeconds?.let { "intro ends ${formatMs((it * 1000).toLong())}" }
        val credits = marker.creditsStartSeconds?.let { "credits start ${formatMs((it * 1000).toLong())}" }
        AdminRowCard(
            title = marker.key,
            subtitle = listOfNotNull(intro, credits).joinToString(" · ").ifBlank { "no values set" },
            detail = "${marker.scope} · set by ${marker.setBy?.userName ?: "someone"} · " +
                adminFormatTime(marker.updatedAt)
        ) {
            TextButton(onClick = {
                confirm(
                    PendingAction(
                        "Clear these markers?",
                        if (marker.scope == "show")
                            "Removes the intro and credits points for \"${marker.key}\". Every " +
                                "episode of that show goes back to playing in full."
                        else
                            "Removes the intro and credits points for \"${marker.key}\".",
                        "Clear", true
                    ) {
                        val r = app.api.adminClearMarker(marker.scope, marker.key)
                        if (!r.ok) AdminErrors.message(r.error) else "Markers cleared."
                    }
                )
            }) { Text("Clear") }
        }
    }
}

/* -------------------------------- settings -------------------------------- */

/**
 * Read-mostly. Only the folder paths the server itself lists in `settableFields` are editable —
 * everything else is shown for reference. The secrets are deliberately visible as
 * "configured / not configured" with a plain explanation of where to set them, rather than hidden,
 * so the owner knows the field exists and where it lives.
 */
@Composable
fun AdminSettingsTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    val scope = rememberCoroutineScope()

    var settings by remember { mutableStateOf<AdminSettings?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var edits by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

    LaunchedEffect(reloadKey) {
        loading = true
        try {
            val r = app.api.adminSettings()
            settings = r.settings
            edits = emptyMap()
            error = null
        } catch (t: Throwable) {
            if (isSessionFailure(t)) { onUnauthorized(); return@LaunchedEffect }
            error = adminErrorMessage(t)
        } finally {
            loading = false
        }
    }

    fun save() {
        val s = settings ?: return
        scope.launch {
            try {
                fun v(field: String, current: String) = edits[field]?.takeIf { it != current }
                val update = AdminSettingsUpdateRequest(
                    moviesDir = v("moviesDir", s.folders.moviesDir),
                    tvShowsDir = v("tvShowsDir", s.folders.tvShowsDir),
                    newFilesDir = v("newFilesDir", s.folders.newFilesDir),
                    viewerAppDir = v("viewerAppDir", s.folders.viewerAppDir),
                    tmdbCacheDir = v("tmdbCacheDir", s.folders.tmdbCacheDir)
                )
                val r = app.api.adminSaveSettings(update)
                notice = if (!r.ok) {
                    // Validation is all-or-nothing server-side: nothing changed.
                    AdminErrors.message(r.error, r.field)
                } else {
                    settings = r.settings
                    edits = emptyMap()
                    if (r.changed.isEmpty()) "Nothing needed changing."
                    else "Saved: ${r.changed.joinToString(", ") { AdminErrors.friendlyField(it) }}"
                }
            } catch (t: Throwable) {
                if (isSessionFailure(t)) onUnauthorized() else notice = adminErrorMessage(t)
            }
        }
    }

    val s = settings
    when {
        loading && s == null -> LoadingBox()
        error != null && s == null -> AdminErrorPanel(error!!) { reloadKey++ }
        s == null -> AdminErrorPanel("No settings available.") { reloadKey++ }
        else -> LazyColumn(Modifier.fillMaxSize()) {
            item {
                notice?.let {
                    Text(
                        it,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)
                    )
                }
                SettingsHeader("Server")
                SettingsReadOnly("Address", "${s.domain}:${s.port}")
                SettingsReadOnly(
                    "HTTPS",
                    if (s.https.active) {
                        "On" + (s.https.daysRemaining?.let { " · $it days left" } ?: "")
                    } else "Off" + (s.https.reason?.let { " · $it" } ?: "")
                )
            }

            item { SettingsHeader("Folders") }
            val folderFields = listOf(
                "moviesDir" to s.folders.moviesDir,
                "tvShowsDir" to s.folders.tvShowsDir,
                "newFilesDir" to s.folders.newFilesDir,
                "viewerAppDir" to s.folders.viewerAppDir,
                "tmdbCacheDir" to s.folders.tmdbCacheDir
            )
            items(folderFields, key = { it.first }) { (field, current) ->
                val editable = field in s.settableFields
                if (editable) {
                    OutlinedTextField(
                        value = edits[field] ?: current,
                        onValueChange = { edits = edits + (field to it) },
                        label = { Text(AdminErrors.friendlyField(field)) },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 14.dp, vertical = 4.dp)
                    )
                } else {
                    SettingsReadOnly(AdminErrors.friendlyField(field), current)
                }
            }

            item {
                if (s.folders.extraMoviesDirs.isNotEmpty() || s.folders.extraTvShowsDirs.isNotEmpty()) {
                    SettingsReadOnly(
                        "Extra Movies folders",
                        s.folders.extraMoviesDirs.joinToString("\n").ifBlank { "none" }
                    )
                    SettingsReadOnly(
                        "Extra TV Shows folders",
                        s.folders.extraTvShowsDirs.joinToString("\n").ifBlank { "none" }
                    )
                }
                TextButton(
                    onClick = { save() },
                    enabled = edits.isNotEmpty(),
                    modifier = Modifier.padding(horizontal = 14.dp)
                ) { Text("Save folder changes") }
            }

            item {
                SettingsHeader("Keys and passwords")
                Text(
                    "These live on the PC. They're passwords for other services, so they can't " +
                        "be changed from a phone — set them in the desktop app, in front of the " +
                        "machine.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp)
                )
                SettingsReadOnly("TMDB API key", configuredLabel(s.secrets.tmdbApiKeyConfigured))
                SettingsReadOnly("Email app password", configuredLabel(s.secrets.emailPasswordConfigured))
                SettingsReadOnly("Email sending", configuredLabel(s.secrets.emailConfigured))
                SettingsReadOnly("DuckDNS token", configuredLabel(s.secrets.duckdnsTokenConfigured))
            }

            item {
                SettingsHeader("Conversion")
                Text(
                    if (s.conversion.configurable) "Adjustable on the PC."
                    else "Fixed in the app — nothing to change here.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 14.dp)
                )
                SettingsReadOnly(
                    "Video",
                    "${s.conversion.videoCodec} · ${s.conversion.preset} · CRF ${s.conversion.crf}"
                )
                SettingsReadOnly("Audio", "${s.conversion.audioCodec} · ${s.conversion.audioBitrate}")
                SettingsReadOnly(
                    "Keep original until converted copy is at least",
                    adminFormatBytes(s.conversion.minConvertedBytesBeforeOriginalDeletable)
                )

                SettingsHeader("Sign-in protection")
                SettingsReadOnly(
                    "Lockout",
                    "${s.login.lockoutThreshold} bad attempts · " +
                        "${s.login.lockoutDurationMinutes} minute lockout"
                )
                SettingsReadOnly("Alert after", "${s.login.alertThreshold} attempts")
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

private fun configuredLabel(configured: Boolean) =
    if (configured) "Configured" else "Not set"

@Composable
private fun SettingsHeader(text: String) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 14.dp, top = 16.dp, bottom = 4.dp)
    )
}

@Composable
private fun SettingsReadOnly(label: String, value: String) {
    Column(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
        Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value.ifBlank { "—" }, fontSize = 13.sp)
    }
}
