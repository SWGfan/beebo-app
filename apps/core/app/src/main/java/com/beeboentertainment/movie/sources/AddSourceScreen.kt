package com.beeboentertainment.movie.sources

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.data.SessionStore
import kotlinx.coroutines.launch

/**
 * "Bring your own online files by link."
 *
 * A self-contained Compose section: paste a website/video link, tap Add, and it
 * is classified ([SourceProbe]) and saved locally ([SourceStore]). Saved links
 * are listed with a Remove control and, when a caller supplies [onOpen], an Open
 * control the host can wire to playback or a preview.
 *
 * It owns its own [SourcesRepository] and state, so it drops into an existing
 * settings screen with a single call and no plumbing. Styling matches the core
 * app: Material3, OutlinedTextField, Cards. It adds no navigation and touches no
 * player, so it is safe to insert without rewiring anything.
 */
@Composable
fun AddSourceScreen(
    modifier: Modifier = Modifier,
    session: SessionStore = BeeboApp.instance.session,
    onOpen: ((UserSource) -> Unit)? = null,
) {
    val repo = remember(session) { SourcesRepository(session) }
    val scope = rememberCoroutineScope()

    var link by remember { mutableStateOf("") }
    var sources by remember { mutableStateOf(repo.list()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Your own links", style = MaterialTheme.typography.titleMedium)
        Text(
            "Paste a link to a video, audio file, playlist, or a JSON listing you " +
                "host yourself, and it becomes a source you can play.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedTextField(
            value = link,
            onValueChange = { link = it; error = null },
            label = { Text("Website or video link") },
            placeholder = { Text("https://example.com/clip.mp4") },
            singleLine = true,
            isError = error != null,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                capitalization = KeyboardCapitalization.None,
                imeAction = ImeAction.Done,
            ),
        )

        Button(
            enabled = !busy && link.isNotBlank(),
            onClick = {
                busy = true
                error = null
                info = null
                scope.launch {
                    try {
                        val added = repo.addByUrl(link)
                        sources = repo.list()
                        link = ""
                        info = addedMessage(added)
                    } catch (e: Exception) {
                        error = e.message ?: "Couldn't add that link."
                    }
                    busy = false
                }
            },
        ) { Text("Add link") }

        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())

        error?.let {
            Card(Modifier.fillMaxWidth()) {
                Text(
                    it,
                    Modifier.padding(16.dp),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
        info?.let {
            Card(Modifier.fillMaxWidth()) { Text(it, Modifier.padding(16.dp)) }
        }

        if (sources.isNotEmpty()) {
            HorizontalDivider()
            sources.forEach { s ->
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(s.label, style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "${kindLabel(s.kind)} · ${s.url}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (onOpen != null) {
                        TextButton(onClick = { onOpen(s) }) { Text("Open") }
                    }
                    TextButton(
                        enabled = !busy,
                        onClick = {
                            repo.remove(s.id)
                            sources = repo.list()
                            info = null
                        },
                    ) { Text("Remove") }
                }
            }
        }
    }
}

private fun kindLabel(kind: SourceKind): String = when (kind) {
    SourceKind.DIRECT_MEDIA -> "Playable file"
    SourceKind.INDEX -> "Listing"
    SourceKind.UNKNOWN -> "Link"
}

private fun addedMessage(source: UserSource): String = when (source.kind) {
    SourceKind.DIRECT_MEDIA -> "Added \"${source.label}\" — a playable file."
    SourceKind.INDEX -> "Added \"${source.label}\" — a listing you can browse."
    SourceKind.UNKNOWN ->
        "Saved \"${source.label}\". We couldn't confirm what it is; it'll be " +
            "tried as a direct file when you play it."
}
