package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** A link-only guide to services which publish their own viewing pages. Beebo never re-streams them. */
private data class OfficialChannel(val name: String, val description: String, val availability: String, val officialUrl: String)

private val officialChannels = listOf(
    OfficialChannel("Global News Live", "National and regional news from Global News.", "Official free stream. Availability and advertising are controlled by Global News.", "https://globalnews.ca/live/national/"),
    OfficialChannel("CTV News Channel", "Canadian and world news from CTV News.", "Official viewing page. Access may vary by programme, location or provider.", "https://www.ctvnews.ca/video/live/2025/04/28/ctv-news-channel-live/"),
    OfficialChannel("TVO", "Ontario public educational and current-affairs programming.", "Official on-demand service. Programme availability is set by TVO.", "https://www.tvo.org/")
)

@Composable
fun OfficialFreeTvScreen() {
    val uriHandler = LocalUriHandler.current
    var selected by remember { mutableStateOf<OfficialChannel?>(null) }
    var openError by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Official Free TV", style = MaterialTheme.typography.headlineSmall)
        Text("Watch from official broadcaster services. Beebo does not carry these channels, place ads in them, or collect viewing information from them.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        openError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("How this works", fontWeight = FontWeight.SemiBold)
            Text("Each option opens the broadcaster's own website or app. Their terms, age ratings, ads, sign-in rules and regional availability apply. A service can change or remove its offer at any time.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } }
        officialChannels.forEach { channel ->
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(channel.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(channel.description)
                Text(channel.availability, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Button(onClick = { selected = channel }) { Text("Open official service") }
            } }
        }
        Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("More channels are reviewed before they appear here", fontWeight = FontWeight.SemiBold)
            Text("Beebo adds a channel only after confirming that the official public link is suitable to share. CBC and other broadcasters are not embedded or re-streamed by Beebo.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } }
    }
    selected?.let { channel -> AlertDialog(
        onDismissRequest = { selected = null },
        title = { Text("Open ${channel.name}?") },
        text = { Text("This leaves Beebo and opens the broadcaster's official service. Their terms and privacy policy apply.") },
        confirmButton = { TextButton(onClick = {
            selected = null
            openError = runCatching { uriHandler.openUri(channel.officialUrl); null }
                .getOrElse { "Couldn't open the broadcaster's service on this device." }
        }) { Text("Open official service") } },
        dismissButton = { TextButton(onClick = { selected = null }) { Text("Cancel") } }
    ) }
}
