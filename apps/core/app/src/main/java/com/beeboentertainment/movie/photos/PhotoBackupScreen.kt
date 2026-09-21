package com.beeboentertainment.movie.photos

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.beeboentertainment.movie.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Settings › Photo backup. Copies the phone's camera photos and videos to the home PC, like Google
 * Photos backup but to your own computer. Nothing on the phone is ever deleted or changed.
 *
 * Permission flow (Google Play photo and video permissions policy):
 *  1. The explanation below is always shown first. In the Play build the person must tap
 *     "Agree and continue" before Android's permission prompt appears.
 *  2. Android 13+: READ_MEDIA_IMAGES (+ READ_MEDIA_VIDEO when videos are on). Android 14+ adds
 *     READ_MEDIA_VISUAL_USER_SELECTED so the prompt offers "Select photos" as well as "Allow all";
 *     with selected-only access Beebo backs up just those and offers to choose more.
 *     Android 12 and older: READ_EXTERNAL_STORAGE.
 *  3. Declining leaves backup off; nothing else in the app asks for these permissions.
 */
@Composable
fun PhotoBackupScreen(onOpenPhotos: () -> Unit = {}) {
    val context = LocalContext.current
    val store = remember { PhotoBackupStore.get(context) }
    val settings by store.settings.collectAsState()
    val state by store.state.collectAsState()
    var access by remember { mutableStateOf(PhoneMedia.access(context, settings.includeVideos)) }
    var albums by remember { mutableStateOf<List<PhoneMedia.Album>>(emptyList()) }
    var account by remember { mutableStateOf<PhotoAccess?>(null) }
    var accountError by remember { mutableStateOf<String?>(null) }
    var onPc by remember { mutableStateOf<BackupDevice?>(null) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    var refresh by remember { mutableIntStateOf(0) }
    val isTv = com.beeboentertainment.movie.ui.tv.LocalIsTv.current
    val device = remember { PhotoBackupLogic.deviceFolderName(Build.MANUFACTURER, Build.MODEL) }

    val enableAfterGrant = remember { mutableStateOf(false) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        access = PhoneMedia.access(context, store.settings.value.includeVideos)
        if (enableAfterGrant.value && access != PhotoBackupLogic.MediaAccess.NONE) {
            val s = store.updateSettings { it.copy(enabled = true, paused = false, enabledAtSec = if (it.enabledAtSec == 0L) System.currentTimeMillis() / 1000 else it.enabledAtSec) }
            PhotoBackupScheduler.apply(context, s)
            PhotoBackupScheduler.runSoon(context, s)
        }
        enableAfterGrant.value = false
        refresh++
    }
    fun askPermission(enable: Boolean) {
        enableAfterGrant.value = enable
        permissionLauncher.launch(PhotoBackupLogic.permissionsToRequest(Build.VERSION.SDK_INT, store.settings.value.includeVideos).toTypedArray())
    }
    fun turnOn() {
        if (PhoneMedia.access(context, settings.includeVideos) == PhotoBackupLogic.MediaAccess.NONE) askPermission(enable = true)
        else {
            val s = store.updateSettings { it.copy(enabled = true, paused = false, enabledAtSec = if (it.enabledAtSec == 0L) System.currentTimeMillis() / 1000 else it.enabledAtSec) }
            PhotoBackupScheduler.apply(context, s)
            PhotoBackupScheduler.runSoon(context, s)
        }
    }
    fun change(apply: (BackupSettings) -> BackupSettings) {
        val s = store.updateSettings(apply)
        PhotoBackupScheduler.apply(context, s)
    }

    // Permissions can change in system settings while we are away: re-check on every resume.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(refresh) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            access = PhoneMedia.access(context, store.settings.value.includeVideos)
            if (access != PhotoBackupLogic.MediaAccess.NONE) albums = withContext(Dispatchers.IO) { runCatching { PhoneMedia.albums(context) }.getOrDefault(emptyList()) }
            val client = PhotosClient()
            runCatching { client.status() }.onSuccess { account = it.access; accountError = null }.onFailure { accountError = it.message }
            runCatching { client.backupSummary(device) }.onSuccess { onPc = it.device }
            while (true) { now = System.currentTimeMillis(); delay(5000) }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Photo backup", style = MaterialTheme.typography.headlineSmall)
        if (isTv) {
            Text("Photo backup runs on phones. Open Photos to see everything that's already on your computer.")
            Button(onClick = onOpenPhotos) { Text("Open Photos") }
            return@Column
        }

        // Always-visible explanation (the prominent disclosure).
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("How photo backup works", fontWeight = FontWeight.SemiBold)
                Text("• Beebo copies photos and videos from the albums you choose (Camera by default) to your own home computer, into Pictures › Phone backups › $device.")
                Text("• To do that, Beebo needs to read the photos and videos on this phone, including in the background when new ones are taken. They go only to your own Beebo computer (encrypted on the way when you're away from home). Beebo never keeps a copy and never shares them.")
                Text("• Nothing on this phone is ever deleted, moved or changed.")
                Text("• You can pause it or turn it off at any time, and choose \"Select photos\" instead of allowing all.")
            }
        }

        val accountBlocked = account?.backup == false
        if (accountBlocked) {
            Text("The owner of this Beebo hasn't allowed photo backup for your account. Ask them to switch it on in Beebo on the computer (Photos › Folders & backup › Who can use Photos).", color = MaterialTheme.colorScheme.error)
        } else if (account == null && accountError != null) {
            Text("Couldn't check with your home computer: $accountError", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        if (!settings.enabled) {
            if (PhotoBackupLogic.needsDisclosureConsent(BuildConfig.IS_PLAY_BUILD, settings)) {
                Button(enabled = !accountBlocked, onClick = {
                    store.updateSettings { it.copy(disclosureAcceptedVersion = PhotoBackupLogic.DISCLOSURE_VERSION) }
                    turnOn()
                }) { Text("Agree and continue") }
                TextButton(onClick = onOpenPhotos) { Text("Not now") }
            } else {
                Button(enabled = !accountBlocked, onClick = { turnOn() }) { Text("Turn on photo backup") }
            }
            return@Column
        }

        // ---- status ----
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val waiting = if (!state.running && !settings.paused && state.pending > 0) (if (settings.wifiOnly) "Wi-Fi" else null) else null
                Text(PhotoBackupLogic.statusLine(state.copy(waitingFor = waiting), settings, now), fontWeight = FontWeight.SemiBold)
                if (state.running && state.total > 0) {
                    LinearProgressIndicator(progress = { (state.done + state.currentProgress) / state.total.coerceAtLeast(1) }, modifier = Modifier.fillMaxWidth())
                    state.currentName?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
                onPc?.let { Text("On your computer from this phone: ${it.files} file${if (it.files == 1) "" else "s"}", style = MaterialTheme.typography.bodySmall) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !settings.paused, onClick = { PhotoBackupScheduler.runSoon(context, settings) }) { Text("Back up now") }
                    OutlinedButton(onClick = { change { it.copy(paused = !it.paused) }; if (settings.paused) PhotoBackupScheduler.runSoon(context, store.settings.value) }) {
                        Text(if (settings.paused) "Resume" else "Pause")
                    }
                }
            }
        }

        when (access) {
            PhotoBackupLogic.MediaAccess.NONE -> {
                Text("Beebo can't see your photos, so backup is waiting.", color = MaterialTheme.colorScheme.error)
                Button(onClick = { askPermission(enable = false) }) { Text("Allow access to photos") }
                TextButton(onClick = { openAppSettings(context) }) { Text("Open app settings") }
            }
            PhotoBackupLogic.MediaAccess.PARTIAL -> {
                Text("Beebo can only see the photos and videos you selected, so only those are backed up.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { askPermission(enable = false) }) { Text("Choose photos") }
                    TextButton(onClick = { openAppSettings(context) }) { Text("Allow all") }
                }
            }
            PhotoBackupLogic.MediaAccess.FULL -> Unit
        }

        HorizontalDivider()
        Text("Albums to back up", style = MaterialTheme.typography.titleMedium)
        if (albums.isEmpty()) Text("Albums appear here once Beebo can see your photos.", style = MaterialTheme.typography.bodySmall)
        albums.forEach { a ->
            val checked = PhotoBackupLogic.albumSelected(a.name, settings.albums)
            Row(Modifier.fillMaxWidth().toggleable(value = checked, role = Role.Checkbox, onValueChange = { on ->
                change { s ->
                    val names = if (PhotoBackupLogic.albumSelected(a.name, setOf(BackupSettings.CAMERA_ALBUM))) BackupSettings.CAMERA_ALBUM else a.name
                    s.copy(albums = if (on) s.albums + names else s.albums - names - a.name)
                }
            }), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = checked, onCheckedChange = null)
                Text("${a.name.ifBlank { "Other" }}  (${a.count})")
            }
        }

        HorizontalDivider()
        SwitchRow("Only on Wi-Fi", "Don't use mobile data.", settings.wifiOnly) { on -> change { it.copy(wifiOnly = on) } }
        SwitchRow("Only while charging", "Save battery on big backups.", settings.chargingOnly) { on -> change { it.copy(chargingOnly = on) } }
        SwitchRow("Include videos", "Videos can be large.", settings.includeVideos) { on ->
            change { it.copy(includeVideos = on) }
            if (on && Build.VERSION.SDK_INT >= 33 && PhoneMedia.access(context, true) != PhotoBackupLogic.MediaAccess.FULL) askPermission(enable = false)
        }

        HorizontalDivider()
        Text("What to back up", style = MaterialTheme.typography.titleMedium)
        RadioRow("Everything in those albums, including photos already on the phone", !settings.onlyNew) { change { it.copy(onlyNew = false) } }
        RadioRow("Only new photos and videos from now on", settings.onlyNew) {
            change { it.copy(onlyNew = true, enabledAtSec = if (it.onlyNew) it.enabledAtSec else System.currentTimeMillis() / 1000) }
        }

        HorizontalDivider()
        TextButton(onClick = { store.clearFailures(); store.flush(); PhotoBackupScheduler.runSoon(context, settings) }) { Text("Try files that failed again") }
        TextButton(onClick = onOpenPhotos) { Text("See your photos") }
        TextButton(onClick = {
            val s = store.updateSettings { it.copy(enabled = false, paused = false) }
            PhotoBackupScheduler.apply(context, s)
        }) { Text("Turn off photo backup") }
        Text("Turning backup off keeps everything already on your computer. Nothing on this phone is deleted.", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun SwitchRow(title: String, detail: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().toggleable(value = value, role = Role.Switch, onValueChange = onChange), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = value, onCheckedChange = null)
    }
}

@Composable
private fun RadioRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().selectable(selected = selected, role = Role.RadioButton, onClick = onClick), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected = selected, onClick = null)
        Text(label)
    }
}

private fun openAppSettings(context: android.content.Context) {
    runCatching {
        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
