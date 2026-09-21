package com.beeboentertainment.movie.spacesaver

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.core.content.ContextCompat
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.NoteAdd
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.formatBytes
import com.beeboentertainment.movie.ui.ConfirmDialog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Space Saver: copy chosen folders to the user's home computer (the Beebo server), verify they
 * landed, then delete the local copies to free phone storage. Nothing is ever deleted
 * automatically — deletion is always an explicit, confirmed action, and only files the server has
 * confirmed it holds can be selected for deletion.
 *
 * Follows the app's convention of holding state with remember/mutableStateOf (no ViewModel). The
 * backed-up set and the picked folders are persisted in [SpaceSaverStore], so progress survives
 * app restarts and re-scans. The backup run itself is handed to [SpaceSaverService] — a foreground
 * service — so it keeps going with this screen closed or the app in the background; this screen only
 * starts/stops it and mirrors its live progress from [SpaceSaverProgress].
 */
@Composable
fun SpaceSaverScreen(onUnauthorized: () -> Unit = {}) {
    val app = BeeboApp.instance
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val store = remember { SpaceSaverStore(app.session.plain) }
    val client = remember { SpaceSaverClient(app.session, app.api.okHttp) }

    // Not signed in: the screen can be opened before a server/token exists. Guard rather than crash.
    if (app.session.baseUrl.isNullOrBlank() || app.session.token.isNullOrBlank()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text(
                "Sign in to Beebo first to use Space Saver.",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        return
    }

    var folders by remember { mutableStateOf(store.folders()) }
    var pickedFiles by remember { mutableStateOf(store.files()) }
    var scanned by remember { mutableStateOf<List<ScanFile>?>(null) }
    var backedKeys by remember { mutableStateOf(store.backedUpKeys().toSet()) }
    var revoked by remember { mutableStateOf<List<PickedFolder>>(emptyList()) }
    var revokedFiles by remember { mutableStateOf<List<PickedFile>>(emptyList()) }

    // "Only back up over Wi-Fi", default true. Persisted; read live by the service each network
    // check, so toggling it takes effect for the current run as well as future ones.
    var wifiOnly by remember { mutableStateOf(store.wifiOnly()) }

    var scanning by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    // Set when a scan couldn't reach the server to verify what's really backed up. While non-null the
    // review list is shown from the (possibly stale) cache but is NOT to be trusted for deletion.
    var verifyWarning by remember { mutableStateOf<String?>(null) }

    // Backup run state now lives in the foreground service; observe its process-wide progress so
    // this screen shows live status whether the service runs in foreground or in the background.
    val progress by SpaceSaverProgress.state.collectAsState()
    val running = progress.running

    // When a run ends (here or in the background), refresh the backed-up set so the review list and
    // the summary reflect what the service persisted while we weren't looking.
    // The service reconciles the store against the server (source of truth) as it runs, so once it
    // ends the persisted set is trustworthy — clear any stale "couldn't verify" note from a prior
    // offline scan along with refreshing the backed-up set.
    LaunchedEffect(running) {
        if (!running) {
            backedKeys = store.backedUpKeys().toSet()
            verifyWarning = null
        }
        // The service may have flipped "Wi-Fi only" off via the notification's "Use mobile data"
        // action; re-read so the checkbox stays truthful.
        wifiOnly = store.wifiOnly()
    }

    // Same re-read when the run enters/leaves the paused state (covers "Use mobile data" tapped
    // from the notification while the run is still alive).
    LaunchedEffect(progress.paused) {
        wifiOnly = store.wifiOnly()
    }

    // Review / delete state.
    val selected = remember { mutableStateOf(setOf<String>()) } // keyed by document Uri string
    var confirmDelete by remember { mutableStateOf(false) }

    // Folder picker: persist read+write so we can delete later, and remember the display name.
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        if (uri != null) {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            val took = runCatching { context.contentResolver.takePersistableUriPermission(uri, flags) }.isSuccess
            if (took) {
                val name = runCatching {
                    androidx.documentfile.provider.DocumentFile.fromTreeUri(context, uri)?.name
                }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/') ?: "Folder"
                store.addFolder(PickedFolder(uri.toString(), name))
                folders = store.folders()
                scanned = null // a new folder invalidates the current scan
                message = null
                error = null
            } else {
                error = "Couldn't keep access to that folder. Try picking it again."
            }
        }
    }

    fun removeFolder(folder: PickedFolder) {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        runCatching { context.contentResolver.releasePersistableUriPermission(Uri.parse(folder.uri), flags) }
        store.removeFolder(folder.uri)
        folders = store.folders()
        scanned = null
        revoked = revoked.filter { it.uri != folder.uri }
    }

    // Read the display name + size for a picked document Uri. Falls back gracefully if the provider
    // omits either column (SIZE can be null for e.g. a synthetic document).
    fun resolveFileInfo(uri: Uri): Pair<String, Long> {
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        var size = 0L
        runCatching {
            context.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null, null, null
            )?.use { c ->
                if (c.moveToFirst()) {
                    val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIdx >= 0 && !c.isNull(nameIdx)) c.getString(nameIdx)?.let { name = it }
                    val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getLong(sizeIdx)
                }
            }
        }
        return name to size
    }

    // File picker: ACTION_OPEN_DOCUMENT with multi-select and persistable read+write, so a picked
    // file can be streamed to the server and later deleted locally. Handles both a single result Uri
    // and clipData (multiple). Uses a raw Intent so we control the exact flags requested.
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val data = result.data ?: return@rememberLauncherForActivityResult
        val uris = ArrayList<Uri>()
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris += it } }
        if (uris.isEmpty()) data.data?.let { uris += it }
        if (uris.isEmpty()) return@rememberLauncherForActivityResult

        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        var added = 0
        var failed = 0
        for (uri in uris) {
            val took = runCatching { context.contentResolver.takePersistableUriPermission(uri, flags) }.isSuccess
            if (!took) { failed++; continue }
            val (name, size) = resolveFileInfo(uri)
            store.addFile(PickedFile(uri.toString(), name, size))
            added++
        }
        pickedFiles = store.files()
        if (added > 0) {
            scanned = null // new files invalidate the current scan
            message = null
            error = null
        }
        if (failed > 0) {
            error = "Couldn't keep access to $failed file${if (failed == 1) "" else "s"}. Try picking again."
        }
    }

    fun launchFilePicker() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            type = "*/*"
            addCategory(Intent.CATEGORY_OPENABLE)
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        runCatching { filePicker.launch(intent) }
            .onFailure { error = "No app available to pick files on this device." }
    }

    fun removeFile(file: PickedFile) {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        runCatching { context.contentResolver.releasePersistableUriPermission(Uri.parse(file.uri), flags) }
        store.removeFile(file.uri)
        pickedFiles = store.files()
        scanned = null
        revokedFiles = revokedFiles.filter { it.uri != file.uri }
    }

    fun startScan() {
        if (scanning || running) return
        scanning = true
        error = null
        message = null
        verifyWarning = null
        scope.launch {
            try {
                val result = SpaceSaverScanner.scan(context, folders, pickedFiles)
                scanned = result.files
                revoked = result.revoked
                revokedFiles = result.revokedFiles
                selected.value = emptySet()

                // The SERVER is the source of truth for "safely on the computer". Ask /check about
                // every scanned file and reconcile the local cache to match: keep only the keys the
                // server currently confirms (have==true), drop the rest (a file deleted from the
                // computer must NOT show as safe to delete). The review list and counts below are
                // built from this reconciled, server-confirmed set.
                val reconciled = runCatching {
                    val results = client.check(result.files.map { CheckItem(it.relPath, it.size) })
                    val havePaths = results.filter { it.have }.map { it.path }.toSet()
                    val confirmed = result.files.filter { it.relPath in havePaths }
                        .map { it.key }.toSet()
                    // Reconcile only the keys we actually re-checked this scan; leave marks for files
                    // outside this scan (e.g. a temporarily revoked folder) untouched.
                    val scannedKeys = result.files.map { it.key }.toSet()
                    val merged = store.backedUpKeys().apply {
                        removeAll(scannedKeys)
                        addAll(confirmed)
                    }
                    store.setBackedUp(merged)
                    merged.toSet()
                }
                if (reconciled.isSuccess) {
                    backedKeys = reconciled.getOrThrow()
                } else {
                    // Offline / server unreachable: don't silently claim files are safe. Fall back to
                    // the cached set for display, but warn prominently so the user rescans first.
                    backedKeys = store.backedUpKeys().toSet()
                    verifyWarning = "Couldn't verify with your computer just now — rescan when " +
                        "connected before deleting."
                }
            } catch (ce: CancellationException) {
                throw ce
            } catch (e: Exception) {
                error = e.message ?: "Couldn't read those folders."
            } finally {
                scanning = false
            }
        }
    }

    // Actually hand the run to the foreground service. It rescans the persisted trees itself, calls
    // /check, then uploads the rest — persisting each success to the store as it goes — so the work
    // outlives this screen. Progress comes back through [SpaceSaverProgress]; store refreshed above.
    // Wrapped so nothing here can crash the app; on any failure surface a message instead.
    fun launchBackupService() {
        runCatching { SpaceSaverService.start(context) }
            .onFailure { error = "Couldn't start the backup. Please try again." }
    }

    // Android 13+ needs POST_NOTIFICATIONS granted for the foreground-service notification to show.
    // Requesting it must never block the feature: whatever the user chooses, we start the backup —
    // a denied permission only means the ongoing notification won't appear, the service still runs.
    val notifPermLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        launchBackupService()
    }

    fun startBackup() {
        if (running) return
        error = null
        message = null
        try {
            val needsPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(
                    context, Manifest.permission.POST_NOTIFICATIONS
                ) != PackageManager.PERMISSION_GRANTED
            if (needsPermission) {
                notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                launchBackupService()
            }
        } catch (t: Throwable) {
            // Never let the permission dance crash the tap — fall back to starting directly.
            launchBackupService()
        }
    }

    fun stopBackup() {
        SpaceSaverService.stop(context)
    }

    fun setWifiOnly(value: Boolean) {
        store.setWifiOnly(value)
        wifiOnly = value
    }

    // "Use mobile data" while paused for Wi-Fi: flip the setting off and tell the service, which
    // resumes a paused run. Update local state immediately so the checkbox reflects the change.
    fun useMobileData() {
        setWifiOnly(false)
        runCatching { SpaceSaverService.useMobileData(context) }
    }

    fun deleteSelected() {
        val files = scanned ?: return
        val ids = selected.value
        if (ids.isEmpty()) return
        val toDelete = files.filter { it.uri.toString() in ids && it.key in backedKeys }
        scope.launch {
            var removed = 0
            var failed = 0
            val goneIds = HashSet<String>()
            for (f in toDelete) {
                // A provider that doesn't support delete throws (or returns false) — never crash;
                // just leave that file in the list and count it as a failure.
                val ok = runCatching {
                    DocumentsContract.deleteDocument(context.contentResolver, f.uri)
                }.getOrDefault(false)
                if (ok) {
                    goneIds += f.uri.toString()
                    removed++
                } else {
                    failed++
                }
            }
            if (goneIds.isNotEmpty()) {
                scanned = files.filter { it.uri.toString() !in goneIds }
            }
            selected.value = emptySet()
            message = when {
                removed > 0 && failed == 0 ->
                    "Freed space by deleting $removed file${if (removed == 1) "" else "s"}. The copies on your computer are kept."
                removed > 0 ->
                    "Deleted $removed file${if (removed == 1) "" else "s"}; $failed couldn't be deleted here (that app doesn't allow it). The copies on your computer are kept."
                failed > 0 ->
                    "Couldn't delete $failed file${if (failed == 1) "" else "s"} — that app doesn't allow deleting from here. The copies on your computer are kept."
                else -> "Nothing was deleted."
            }
        }
    }

    // ------------------------------- derived -------------------------------
    val files = scanned
    val totalFiles = files?.size ?: 0
    val totalSize = files?.sumOf { it.size } ?: 0L
    val backedUpFiles = files?.filter { it.key in backedKeys } ?: emptyList()
    val backedUpSize = backedUpFiles.sumOf { it.size }
    val notBackedCount = totalFiles - backedUpFiles.size
    val notBackedSize = totalSize - backedUpSize
    val reclaimableSelectedSize = backedUpFiles
        .filter { it.uri.toString() in selected.value }
        .sumOf { it.size }

    // ------------------------------- layout --------------------------------
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Spacer(Modifier.height(6.dp))
            Text("Space Saver", style = MaterialTheme.typography.headlineSmall)
            Text(
                "Copy folders or individual files from this phone to your home computer, make sure " +
                    "they arrived, then delete the copies here to free up space. Your files are never " +
                    "deleted automatically.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        // --- Folders ---
        item {
            HorizontalDivider()
            Text("Folders", style = MaterialTheme.typography.titleMedium)
        }
        items(folders, key = { "folder:" + it.uri }) { folder ->
            Card(Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Filled.Folder, contentDescription = null, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.size(10.dp))
                    Text(folder.name, Modifier.weight(1f), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    IconButton(onClick = { removeFolder(folder) }, enabled = !running && !scanning) {
                        Icon(Icons.Filled.Close, contentDescription = "Remove folder")
                    }
                }
            }
        }
        item {
            if (folders.isEmpty()) {
                Text(
                    "No folders added yet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { picker.launch(null) }, enabled = !running) {
                    Icon(Icons.Filled.CreateNewFolder, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(6.dp))
                    Text("Add a folder")
                }
                OutlinedButton(onClick = { launchFilePicker() }, enabled = !running) {
                    Icon(Icons.Filled.NoteAdd, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(6.dp))
                    Text("Add files")
                }
            }
        }

        // --- Revoked folders notice ---
        if (revoked.isNotEmpty()) {
            item {
                Text(
                    "These folders can no longer be read (access was removed): " +
                        revoked.joinToString { it.name } + ". Remove and add them again to keep backing them up.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error
                )
            }
        }

        // --- Files (individually picked) ---
        if (pickedFiles.isNotEmpty()) {
            item {
                HorizontalDivider()
                Text("Files", style = MaterialTheme.typography.titleMedium)
            }
            items(pickedFiles, key = { "file:" + it.uri }) { file ->
                Card(Modifier.fillMaxWidth()) {
                    Row(
                        Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(Icons.Filled.InsertDriveFile, contentDescription = null, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.size(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(file.name, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                            if (file.size > 0) {
                                Text(
                                    formatBytes(file.size),
                                    fontSize = 11.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1
                                )
                            }
                        }
                        IconButton(onClick = { removeFile(file) }, enabled = !running && !scanning) {
                            Icon(Icons.Filled.Close, contentDescription = "Remove file")
                        }
                    }
                }
            }
        }

        // --- Revoked files notice ---
        if (revokedFiles.isNotEmpty()) {
            item {
                Text(
                    "These files can no longer be read (moved, deleted, or access was removed): " +
                        revokedFiles.joinToString { it.name } + ". Remove and add them again to keep backing them up.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error
                )
            }
        }

        // --- Backup settings: Wi-Fi only ---
        item {
            HorizontalDivider()
            Row(
                Modifier.fillMaxWidth().clickable { setWifiOnly(!wifiOnly) },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Checkbox(checked = wifiOnly, onCheckedChange = { setWifiOnly(it) })
                Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
                    Text("Only back up over Wi-Fi", fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    Text(
                        "Off = also use mobile data, which may use up your data plan.",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        // --- Scan / summary ---
        item {
            HorizontalDivider()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = { startScan() },
                    enabled = (folders.isNotEmpty() || pickedFiles.isNotEmpty()) && !scanning && !running
                ) {
                    Text(if (files == null) "Scan" else "Rescan")
                }
                if (scanning) {
                    Spacer(Modifier.size(12.dp))
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(8.dp))
                    Text("Scanning…", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        if (files != null && !scanning) {
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        val sources = buildList {
                            add("${folders.size} folder${if (folders.size == 1) "" else "s"}")
                            if (pickedFiles.isNotEmpty())
                                add("${pickedFiles.size} file${if (pickedFiles.size == 1) "" else "s"}")
                        }.joinToString(", ")
                        Text(
                            "$sources · $totalFiles file${if (totalFiles == 1) "" else "s"} · ${formatBytes(totalSize)}",
                            fontWeight = FontWeight.Medium
                        )
                        Text(
                            "Backed up: ${backedUpFiles.size} (${formatBytes(backedUpSize)})",
                            fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            "Not yet backed up: $notBackedCount (${formatBytes(notBackedSize)})",
                            fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }

        // --- Couldn't-verify-with-server banner (offline scan) ---
        if (verifyWarning != null && files != null && !scanning) {
            item {
                Card(
                    Modifier.fillMaxWidth(),
                    colors = androidx.compose.material3.CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer
                    )
                ) {
                    Text(
                        verifyWarning!!,
                        Modifier.padding(14.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.onErrorContainer
                    )
                }
            }
        }

        // --- Back up now / live progress ---
        // While the service runs, show its progress regardless of whether this screen has a fresh
        // scan (it may have been reopened mid-run), and offer Stop. Otherwise show the start button.
        if (running && progress.paused) {
            // Parked waiting for Wi-Fi. Offer the escape hatch (mobile data) plus Stop.
            item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        progress.statusMessage ?: "Paused — waiting for Wi-Fi",
                        fontSize = 13.sp, fontWeight = FontWeight.Medium
                    )
                    Text(
                        "Backup will continue automatically when Wi-Fi is back. It’ll resume where it left off — files already copied stay done.",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { useMobileData() }) {
                            Text("Use mobile data")
                        }
                        OutlinedButton(onClick = { stopBackup() }) {
                            Icon(Icons.Filled.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(6.dp))
                            Text("Stop")
                        }
                    }
                }
            }
        } else if (running) {
            item {
                val total = progress.total
                val done = progress.done
                val pct = if (total > 0) (done * 100 / total) else 0
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        if (total > 0) "Backing up $done of $total · $pct%" else "Preparing backup…",
                        fontSize = 13.sp, fontWeight = FontWeight.Medium
                    )
                    progress.currentName?.let {
                        Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                    if (total > 0) {
                        LinearProgressIndicator(progress = { done.toFloat() / total }, modifier = Modifier.fillMaxWidth())
                    } else {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                    OutlinedButton(onClick = { stopBackup() }) {
                        Icon(Icons.Filled.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(6.dp))
                        Text("Stop")
                    }
                }
            }
        } else if (files != null && !scanning) {
            item {
                Button(onClick = { startBackup() }, enabled = notBackedCount > 0) {
                    Text(
                        if (notBackedCount > 0)
                            "Back up now ($notBackedCount · ${formatBytes(notBackedSize)})"
                        else "Everything backed up"
                    )
                }
            }
        }

        // --- Review & free up space ---
        if (backedUpFiles.isNotEmpty() && !scanning) {
            item {
                HorizontalDivider()
                Text("Review & free up space", style = MaterialTheme.typography.titleMedium)
                if (verifyWarning != null) {
                    Text(
                        "Showing the last known list — not verified with your computer just now. " +
                            "Rescan when connected before deleting.",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.error
                    )
                } else {
                    Text(
                        "These files are safely on your computer, so deleting them here is safe. " +
                            "Total reclaimable: ${formatBytes(backedUpSize)}.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val allIds = backedUpFiles.map { it.uri.toString() }.toSet()
                    val allSelected = selected.value.containsAll(allIds) && allIds.isNotEmpty()
                    TextButton(onClick = {
                        selected.value = if (allSelected) emptySet() else allIds
                    }) { Text(if (allSelected) "Clear selection" else "Select all") }
                    Spacer(Modifier.weight(1f))
                    Button(
                        onClick = { confirmDelete = true },
                        enabled = selected.value.isNotEmpty() && !running
                    ) {
                        Icon(Icons.Filled.Delete, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(6.dp))
                        Text("Delete (${selected.value.size})")
                    }
                }
            }
            items(backedUpFiles, key = { "backed:" + it.uri.toString() }) { f ->
                val id = f.uri.toString()
                val checked = id in selected.value
                Row(
                    Modifier.fillMaxWidth().clickable {
                        selected.value = if (checked) selected.value - id else selected.value + id
                    },
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Checkbox(checked = checked, onCheckedChange = { on ->
                        selected.value = if (on) selected.value + id else selected.value - id
                    })
                    Column(Modifier.weight(1f)) {
                        Text(f.name, fontSize = 13.sp, maxLines = 1)
                        Text(
                            "${f.relPath.substringBeforeLast('/', "")} · ${formatBytes(f.size)}",
                            fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1
                        )
                    }
                }
            }
        }

        // --- Messages ---
        item {
            // Errors/summaries from the background service (shown once it has finished) plus any
            // local scan/delete messages.
            val serviceError = if (!running) progress.lastError else null
            val serviceMessage = if (!running) progress.lastMessage else null
            (error ?: serviceError)?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            (message ?: serviceMessage)?.let {
                Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
            }
            Spacer(Modifier.height(16.dp))
        }
    }

    if (confirmDelete) {
        val count = selected.value.size
        ConfirmDialog(
            title = "Delete $count file${if (count == 1) "" else "s"}?",
            message = "Free ${formatBytes(reclaimableSelectedSize)} on this phone? " +
                "The copies on your computer are kept.",
            confirmLabel = "Delete",
            onConfirm = { deleteSelected() },
            onDismiss = { confirmDelete = false }
        )
    }
}
