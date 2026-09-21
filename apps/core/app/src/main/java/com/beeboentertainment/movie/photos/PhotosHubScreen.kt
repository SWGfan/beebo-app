package com.beeboentertainment.movie.photos

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.ProfileLimits
import com.beeboentertainment.movie.spacesaver.SpaceSaverScreen
import com.beeboentertainment.movie.spacesaver.gallery.SpaceSaverGalleryScreen
import com.beeboentertainment.movie.ui.tv.LocalIsTv

/** A single home for photos and backups. Existing workers, stores and folders stay intact. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhotosHubScreen(initialSection: String = "library", onUnauthorized: () -> Unit = {}) {
    val session = BeeboApp.instance.session
    val allowed = ProfileLimits.of(session.isAdmin, session.isRestricted, session.isGuest).showSpaceSaver
    val canBackUp = allowed && !LocalIsTv.current
    var section by rememberSaveable { mutableStateOf(if (canBackUp && initialSection != "files") initialSection else "library") }
    var folders by rememberSaveable { mutableStateOf(initialSection == "files" && allowed) }
    val sections = if (canBackUp) listOf("library" to "Library", "camera" to "Camera backup", "folders" to "Folders & cleanup", "private" to "Private folder")
                   else listOf("library" to "Library")
    val active = sections.indexOfFirst { it.first == section }.coerceAtLeast(0)
    Column(Modifier.fillMaxSize()) {
        ScrollableTabRow(selectedTabIndex = active, edgePadding = 12.dp) {
            sections.forEach { (id, title) ->
                Tab(selected = section == id, onClick = { section = id }, text = { Text(title) })
            }
        }
        if (section == "library" && allowed) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !folders, onClick = { folders = false }, label = { Text("Photos & albums") })
                FilterChip(selected = folders, onClick = { folders = true }, label = { Text("Backup folders") })
            }
        }
        Box(Modifier.weight(1f)) {
            when {
                section == "private" && canBackUp -> com.beeboentertainment.movie.vault.PrivateVaultScreen()
                section == "camera" && canBackUp -> PhotoBackupScreen(onOpenPhotos = { section = "library"; folders = false })
                section == "folders" && canBackUp -> SpaceSaverScreen(onUnauthorized = onUnauthorized)
                folders && allowed -> SpaceSaverGalleryScreen(onExit = { folders = false })
                else -> PhotosScreen(onOpenBackup = { section = "camera" }, onUnauthorized = onUnauthorized, showBackup = canBackUp)
            }
        }
    }
}
