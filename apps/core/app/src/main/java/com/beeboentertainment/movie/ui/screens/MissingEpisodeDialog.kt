package com.beeboentertainment.movie.ui.screens

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.EpisodeGaps
import com.beeboentertainment.movie.core.ProfileLimits
import com.beeboentertainment.movie.core.SearchSiteLogic
import com.beeboentertainment.movie.data.MissingEpisode
import com.beeboentertainment.movie.data.SearchSite
import com.beeboentertainment.movie.data.ShowInfo
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.ui.openExternalUrl
import kotlinx.coroutines.launch

@Composable
internal fun MissingEpisodeDialog(show: ShowInfo?, item: MissingEpisode, onUnauthorized: () -> Unit, onDismiss: () -> Unit) {
    val app = BeeboApp.instance
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var site by remember { mutableStateOf<SearchSite?>(null) }
    var busy by remember(item) { mutableStateOf(false) }
    var sent by remember(item) { mutableStateOf(false) }
    var message by remember(item) { mutableStateOf<String?>(null) }
    val limits = ProfileLimits.of(app.session.isAdmin, app.session.isRestricted, app.session.isGuest)
    LaunchedEffect(Unit) { site = runCatching { app.api.searchSites().tv }.getOrNull() }
    fun search(chosen: SearchSite?) {
        if (!openExternalUrl(context, SearchSiteLogic.url(chosen, EpisodeGaps.query(show, item), null))) {
            Toast.makeText(context, "No web browser found on this device.", Toast.LENGTH_SHORT).show()
        }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(item.title.ifBlank { EpisodeGaps.query(show, item) }) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This episode is not in your computer’s library. Search for it online or ask the owner to add it. Some listed episodes may not have aired yet.")
                if (limits.showSearchOnline) {
                    OutlinedButton(onClick = { search(site) }, modifier = Modifier.fillMaxWidth()) { Text(SearchSiteLogic.buttonLabel(site)) }
                    if (SearchSiteLogic.showGoogleToo(site)) {
                        OutlinedButton(onClick = { search(SearchSiteLogic.GOOGLE) }, modifier = Modifier.fillMaxWidth()) { Text("Search Google") }
                    }
                }
                if (limits.showRequests && app.session.isLoggedIn) {
                    OutlinedButton(enabled = !busy && !sent, modifier = Modifier.fillMaxWidth(), onClick = {
                        busy = true
                        message = null
                        scope.launch {
                            try {
                                val result = app.api.missingRequest(EpisodeGaps.request(show, item))
                                if (result.ok) { sent = true; message = "The owner can now see your request." }
                                else message = "Your request wasn’t saved. Please try again."
                            } catch (_: UnauthorizedException) { onUnauthorized() }
                            catch (_: Exception) { message = "Couldn’t reach your computer. Please try again." }
                            finally { busy = false }
                        }
                    }) { Text(if (sent) "Requested" else if (busy) "Sending…" else "Request this episode") }
                }
                message?.let { Text(it) }
            }
        },
        confirmButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("Close") } }
    )
}
