package com.beeboentertainment.movie.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.PlayQueue
import com.beeboentertainment.movie.core.PlayQueueHolder
import com.beeboentertainment.movie.core.PlaylistLogic
import com.beeboentertainment.movie.core.PlaylistLogic.toQueueItem
import com.beeboentertainment.movie.core.QueueItem
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.PlaylistCreateRequest
import com.beeboentertainment.movie.data.PlaylistItemRef
import com.beeboentertainment.movie.data.PlaylistSummary
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.player.PlayerActivity
import kotlinx.coroutines.launch

/**
 * "Add to playlist" from any details panel: pick one of your playlists or name a new one, or put
 * the title on the play queue (Play next / Add to queue). A whole show is expanded into its
 * episodes by the server, in watching order.
 *
 * Every control is a plain button, so a TV remote moves through them with the D-pad.
 */
@Composable
fun AddToPlaylistDialog(
    ref: PlaylistItemRef,
    title: String,
    /** For Play next / Add to queue on a single film or episode. */
    queueItem: QueueItem?,
    onUnauthorized: () -> Unit = {},
    onDismiss: () -> Unit
) {
    val app = BeeboApp.instance
    val scope = rememberCoroutineScope()
    var lists by remember { mutableStateOf<List<PlaylistSummary>?>(null) }
    var newName by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(ref) {
        try {
            lists = app.api.playlists().playlists.filter { it.canEdit && !it.smart }
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            lists = emptyList()
            message = "Couldn't reach your server: ${e.message}"
        }
    }

    fun act(block: suspend () -> String?) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                message = block()
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                message = PlaylistLogic.errorText(e.message)
            } finally {
                busy = false
            }
        }
    }

    suspend fun itemsForQueue(): List<QueueItem> =
        queueItem?.let { listOf(it) }
            ?: app.api.expandForQueue(listOf(ref)).items.map { it.toQueueItem() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text("Add to playlist", fontSize = 18.sp)
                Text(title, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        text = {
            Column {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        enabled = !busy,
                        modifier = Modifier.dpadFocusRing(),
                        onClick = {
                            act {
                                val items = itemsForQueue()
                                PlayQueueHolder.update { it.playNext(items) }
                                "Plays next."
                            }
                        }
                    ) { Text("⏭ Play next") }
                    OutlinedButton(
                        enabled = !busy,
                        modifier = Modifier.dpadFocusRing(),
                        onClick = {
                            act {
                                val items = itemsForQueue()
                                PlayQueueHolder.update { it.addToQueue(items) }
                                "Added to your queue."
                            }
                        }
                    ) { Text("☰ Add to queue") }
                }
                Spacer(Modifier.height(12.dp))
                val current = lists
                when {
                    current == null -> Text("Loading your playlists…", fontSize = 13.sp)
                    current.isEmpty() -> Text("No playlists yet — name one below.", fontSize = 13.sp)
                    else -> LazyColumn(Modifier.heightIn(max = 220.dp)) {
                        items(current, key = { it.id }) { p ->
                            TextButton(
                                enabled = !busy,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .dpadFocusRing(),
                                onClick = {
                                    act {
                                        val r = app.api.addToPlaylist(p.id, listOf(ref))
                                        if ((r.added ?: 0) > 0) "Added to ${p.name}." else "Already in ${p.name}."
                                    }
                                }
                            ) { Text("${p.name} (${p.itemCount ?: 0})", modifier = Modifier.fillMaxWidth()) }
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = newName,
                    onValueChange = { newName = it.take(100) },
                    singleLine = true,
                    label = { Text("New playlist name") },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        val n = newName.trim()
                        if (n.isNotEmpty()) act {
                            app.api.createPlaylist(PlaylistCreateRequest(name = n, add = listOf(ref)))
                            newName = ""
                            "Created $n."
                        }
                    }),
                    modifier = Modifier.fillMaxWidth()
                )
                TextButton(
                    enabled = !busy && newName.isNotBlank(),
                    modifier = Modifier.dpadFocusRing(),
                    onClick = {
                        val n = newName.trim()
                        act {
                            app.api.createPlaylist(PlaylistCreateRequest(name = n, add = listOf(ref)))
                            newName = ""
                            "Created $n."
                        }
                    }
                ) { Text("＋ Create playlist") }
                message?.let {
                    Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 6.dp))
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } }
    )
}

/** Starts the queue's next item in the player (a playlist's first, or the first after Resume). */
object QueuePlayer {
    fun playNextInQueue(context: Context): Boolean {
        val app = BeeboApp.instance
        val item = PlayQueueHolder.current.next ?: return false
        context.startActivity(
            PlayerActivity.intentFor(
                context,
                itemId = item.id,
                kind = item.kind,
                title = item.title,
                streamUrl = UrlUtils.join(app.session.baseUrl, item.stream),
                localPath = app.downloads.localPath(item.id),
                posterUrl = UrlUtils.join(app.session.baseUrl, item.poster),
                resumePositionMs = if (item.resumeSeconds > 30) (item.resumeSeconds * 1000).toLong() else -1L,
                showKey = item.showKey
            )
        )
        return true
    }

    /** Replace the queue with [queue] and start it. */
    fun start(context: Context, queue: PlayQueue): Boolean {
        PlayQueueHolder.set(queue)
        return playNextInQueue(context)
    }
}
