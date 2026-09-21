package com.beeboentertainment.movie.checklist

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.party.RoomMessenger
import com.beeboentertainment.movie.party.rememberRoomMessenger
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.UUID

/*
 * The shared packing checklist screen.
 *
 * Local-first: [ChecklistStore] loads from SharedPreferences so the list is there with no
 * signal, and every edit is persisted at once. On top of that it syncs over the SAME hub
 * room socket the watch party and games use, via [RoomMessenger].
 *
 * Wire protocol (RoomClient.sendApp {type, ...}, hub relays + stamps `from`):
 *
 *   checklist_item  { id, text, checked, createdAt, updatedAt, deleted }
 *                       one row changed — add / tick / rename / delete (tombstone)
 *   checklist_full  { items: <json array string> }
 *                       a full snapshot, sent to a phone that just joined so it catches up
 *
 * Every phone applies peer edits by last-write-wins on updatedAt, so two people ticking the
 * same thing, or editing while briefly offline, converge the moment they reconnect.
 */

private const val MSG_ITEM = "checklist_item"
private const val MSG_FULL = "checklist_full"

@Composable
fun PackingChecklistScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val store = remember { ChecklistStore(session.plain) }
    val deviceName = remember {
        session.userName?.takeIf { it.isNotBlank() } ?: "Family"
    }
    val messenger = rememberRoomMessenger(session, deviceName)
    PackingChecklist(store = store, messenger = messenger, modifier = modifier)
}

@Composable
fun PackingChecklist(
    store: ChecklistStore,
    messenger: RoomMessenger?,
    modifier: Modifier = Modifier,
) {
    // Observe the store so any merge (local or remote) repaints the list.
    val items by store.items.collectAsState()
    val visible = items.filterNot { it.deleted }.sortedBy { it.createdAt }
    val connected = messenger?.connected?.collectAsState()?.value ?: false

    var draft by remember { mutableStateOf("") }

    fun payloadFor(item: ChecklistItem) = buildJsonObject {
        put("id", item.id)
        put("text", item.text)
        put("checked", item.checked)
        put("createdAt", item.createdAt)
        put("updatedAt", item.updatedAt)
        put("deleted", item.deleted)
    }

    fun broadcast(item: ChecklistItem) {
        messenger?.send(MSG_ITEM, payloadFor(item))
    }

    fun addItem() {
        val text = draft.trim()
        if (text.isEmpty()) return
        val now = System.currentTimeMillis()
        val item = ChecklistItem(
            id = UUID.randomUUID().toString(),
            text = text,
            checked = false,
            createdAt = now,
            updatedAt = now,
        )
        store.applyLocal(item)
        broadcast(item)
        draft = ""
    }

    fun toggle(item: ChecklistItem) {
        val updated = item.copy(checked = !item.checked, updatedAt = System.currentTimeMillis())
        store.applyLocal(updated)
        broadcast(updated)
    }

    fun remove(item: ChecklistItem) {
        val updated = item.copy(deleted = true, updatedAt = System.currentTimeMillis())
        store.applyLocal(updated)
        broadcast(updated)
    }

    // Fold in peer edits.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_ITEM -> parseItem(msg)?.let { store.merge(it) }
                MSG_FULL -> {
                    val text = msg.data["items"]?.jsonPrimitive?.content ?: return@collect
                    store.mergeAll(store.decodeList(text))
                }
            }
        }
    }

    // When someone new joins, push them the whole list so they start in sync.
    LaunchedEffect(messenger) {
        messenger?.memberJoined?.collect {
            messenger.send(
                MSG_FULL,
                buildJsonObject { put("items", store.encodeList(store.snapshot())) },
            )
        }
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Packing checklist", style = MaterialTheme.typography.titleLarge)
        Text(
            if (messenger == null)
                "Saved on this phone. Connect a Beebo Hub in Settings to share it with the family — " +
                    "everyone adds and ticks, and it stays in sync."
            else if (connected)
                "Shared and in sync. Anyone can add or tick an item; it shows up on every phone."
            else
                "Saved on this phone. Reconnecting to sync with the family…",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Add row.
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                label = { Text("Add an item") },
                singleLine = true,
                modifier = Modifier.weight(1f),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { addItem() }),
            )
            Button(enabled = draft.isNotBlank(), onClick = { addItem() }) { Text("Add") }
        }

        HorizontalDivider()

        if (visible.isEmpty()) {
            Text(
                "Nothing on the list yet. Add the first thing above.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            val checkedCount = visible.count { it.checked }
            Text(
                "$checkedCount of ${visible.size} packed",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            visible.forEach { item ->
                Card(Modifier.fillMaxWidth()) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = item.checked, onCheckedChange = { toggle(item) })
                        Text(
                            item.text,
                            modifier = Modifier.weight(1f).padding(horizontal = 4.dp),
                            style = MaterialTheme.typography.bodyLarge,
                            textDecoration = if (item.checked) TextDecoration.LineThrough else null,
                            color = if (item.checked)
                                MaterialTheme.colorScheme.onSurfaceVariant
                            else MaterialTheme.colorScheme.onSurface,
                        )
                        IconButton(onClick = { remove(item) }) {
                            Icon(Icons.Filled.Delete, contentDescription = "Remove ${item.text}")
                        }
                    }
                }
            }
        }
    }
}

/** Decode a [ChecklistItem] from a checklist_item envelope, or null if it's malformed. */
private fun parseItem(msg: com.beeboentertainment.movie.party.RoomEvent.App): ChecklistItem? {
    val d = msg.data
    val id = d["id"]?.jsonPrimitive?.content ?: return null
    val text = d["text"]?.jsonPrimitive?.content ?: return null
    return ChecklistItem(
        id = id,
        text = text,
        checked = d["checked"]?.jsonPrimitive?.booleanOrNull ?: false,
        createdAt = d["createdAt"]?.jsonPrimitive?.longOrNull ?: 0L,
        updatedAt = d["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
        deleted = d["deleted"]?.jsonPrimitive?.booleanOrNull ?: false,
    )
}
