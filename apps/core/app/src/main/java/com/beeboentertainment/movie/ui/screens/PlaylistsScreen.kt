package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.PlayQueue
import com.beeboentertainment.movie.core.PlayQueueHolder
import com.beeboentertainment.movie.core.PlaylistLogic
import com.beeboentertainment.movie.core.PlaylistLogic.toQueueItem
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.PlaylistCreateRequest
import com.beeboentertainment.movie.data.PlaylistDetailResponse
import com.beeboentertainment.movie.data.PlaylistFieldsResponse
import com.beeboentertainment.movie.data.PlaylistUpdateRequest
import com.beeboentertainment.movie.data.PlaylistsResponse
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.ui.ConfirmDialog
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.QueuePlayer
import com.beeboentertainment.movie.ui.dpadFocusRing
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Library > 🎵 Playlists: your playlists and smart playlists, the ones the owner shares with the
 * household, one-tap templates, and the play queue.
 *
 * Built for a remote as much as a finger: everything is a button in a column or a row, so the
 * D-pad walks it in reading order, and every button shows a focus ring on a TV.
 */
@Composable
fun PlaylistsScreen(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var list by remember { mutableStateOf<PlaylistsResponse?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    var openId by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    val queue by PlayQueueHolder.queue.collectAsState()

    fun guarded(block: suspend () -> Unit) {
        scope.launch {
            try {
                message = null
                block()
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                message = PlaylistLogic.errorText(e.message)
            }
        }
    }

    fun play(id: String, name: String?, shuffle: Boolean, resume: Boolean) = guarded {
        val r = app.api.playPlaylist(id, shuffle = shuffle, resume = resume)
        val q = PlaylistLogic.queueFrom(r, id, name)
        if (q.isEmpty || !QueuePlayer.start(context, q)) message = "Nothing playable in this playlist yet."
    }

    LaunchedEffect(reload) {
        error = null
        try {
            list = app.api.playlists()
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            error = e.message ?: "Couldn't load your playlists."
        }
    }

    val open = openId
    if (open != null) {
        PlaylistDetail(
            playlistId = open,
            canShare = list?.canShare == true,
            onBack = { openId = null; reload++ },
            onPlay = { shuffle, resume, name -> play(open, name, shuffle, resume) },
            onUnauthorized = onUnauthorized
        )
        return
    }

    val current = list
    Column(Modifier.fillMaxSize()) {
        when {
            error != null && current == null -> ErrorBox(error!!, onRetry = { reload++ })
            current == null -> LoadingBox()
            else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
                item {
                    message?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp, modifier = Modifier.padding(vertical = 4.dp)) }
                    if (queue.remaining > 0) {
                        Card(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text("Your queue", fontWeight = FontWeight.Bold)
                                    Text(
                                        (queue.playlistName?.let { "$it · " } ?: "") + "${queue.remaining} to play" +
                                            (queue.next?.let { " · next: ${it.title}" } ?: ""),
                                        fontSize = 12.sp,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                }
                                Button(onClick = { QueuePlayer.playNextInQueue(context) }, modifier = Modifier.dpadFocusRing()) { Text("▶ Play") }
                                Spacer(Modifier.width(6.dp))
                                TextButton(onClick = { PlayQueueHolder.clear() }, modifier = Modifier.dpadFocusRing()) { Text("Clear") }
                            }
                        }
                    }
                    Row(Modifier.padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { creating = true }, modifier = Modifier.dpadFocusRing()) { Text("＋ New playlist") }
                    }
                    Text("Ready-made smart playlists", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 6.dp)) {
                        items(current.templates, key = { it.id }) { t ->
                            OutlinedButton(
                                modifier = Modifier.dpadFocusRing(),
                                onClick = {
                                    guarded {
                                        val r = app.api.createPlaylist(PlaylistCreateRequest(template = t.id))
                                        openId = r.playlist.id
                                    }
                                }
                            ) { Text(t.name, fontSize = 13.sp) }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                    if (current.playlists.isEmpty()) {
                        Text(
                            "No playlists yet. Open any title's details and tap ＋ Playlist, or start from a ready-made one above.",
                            fontSize = 14.sp,
                            modifier = Modifier.padding(vertical = 16.dp)
                        )
                    }
                }
                items(current.playlists, key = { it.id }) { p ->
                    Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Row(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            TextButton(
                                onClick = { openId = p.id },
                                modifier = Modifier.weight(1f).dpadFocusRing()
                            ) {
                                Column(Modifier.fillMaxWidth()) {
                                    Text((if (p.smart) "✨ " else "") + p.name, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(
                                        listOfNotNull(
                                            PlaylistLogic.countLabel(p.itemCount).ifBlank { null },
                                            if (p.shared) "shared with the household" else null,
                                            if (!p.mine) p.ownerName?.let { "from $it" } else null
                                        ).joinToString(" · "),
                                        fontSize = 12.sp,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                            Button(onClick = { play(p.id, p.name, shuffle = false, resume = false) }, modifier = Modifier.dpadFocusRing()) { Text("▶") }
                            Spacer(Modifier.width(6.dp))
                            OutlinedButton(onClick = { play(p.id, p.name, shuffle = true, resume = false) }, modifier = Modifier.dpadFocusRing()) { Text("🔀") }
                        }
                    }
                }
            }
        }
    }

    if (creating) {
        NewPlaylistDialog(
            onCreate = { name, smart ->
                creating = false
                guarded {
                    val r = app.api.createPlaylist(
                        if (smart) PlaylistCreateRequest(name = name, smart = true) else PlaylistCreateRequest(name = name)
                    )
                    openId = r.playlist.id
                }
            },
            onDismiss = { creating = false }
        )
    }
}

@Composable
private fun NewPlaylistDialog(onCreate: (String, Boolean) -> Unit, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var smart by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New playlist") },
        text = {
            Column {
                OutlinedTextField(value = name, onValueChange = { name = it.take(100) }, singleLine = true, label = { Text("Name") })
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = !smart, onClick = { smart = false }, label = { Text("Pick titles myself") })
                    FilterChip(selected = smart, onClick = { smart = true }, label = { Text("✨ Smart (rules)") })
                }
            }
        },
        confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { onCreate(name.trim(), smart) }) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun PlaylistDetail(
    playlistId: String,
    canShare: Boolean,
    onBack: () -> Unit,
    onPlay: (shuffle: Boolean, resume: Boolean, name: String?) -> Unit,
    onUnauthorized: () -> Unit
) {
    val app = BeeboApp.instance
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var detail by remember { mutableStateOf<PlaylistDetailResponse?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var editingRules by remember { mutableStateOf(false) }
    var fields by remember { mutableStateOf<PlaylistFieldsResponse?>(null) }

    fun guarded(block: suspend () -> Unit) {
        scope.launch {
            try {
                message = null
                block()
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                message = PlaylistLogic.errorText(e.message)
            }
        }
    }

    LaunchedEffect(playlistId) {
        try {
            detail = app.api.playlist(playlistId)
            fields = runCatching { app.api.playlistFields() }.getOrNull()
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            error = PlaylistLogic.errorText(e.message)
        }
    }

    val d = detail
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        TextButton(onClick = onBack, modifier = Modifier.dpadFocusRing()) { Text("← All playlists") }
        when {
            error != null -> ErrorBox(error!!, onRetry = onBack)
            d == null -> LoadingBox()
            else -> {
                val p = d.playlist
                LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        Text((if (p.smart) "✨ " else "") + p.name, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Text(
                            listOfNotNull(
                                PlaylistLogic.countLabel(d.count),
                                if (p.shared) "shared with the household" else null,
                                if (d.skipped > 0) "${d.skipped} not playable here yet" else null
                            ).joinToString(" · "),
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        message?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
                            item { Button(onClick = { onPlay(false, false, p.name) }, modifier = Modifier.dpadFocusRing()) { Text("▶ Play") } }
                            item { OutlinedButton(onClick = { onPlay(true, false, p.name) }, modifier = Modifier.dpadFocusRing()) { Text("🔀 Shuffle") } }
                            if (d.progress != null) item {
                                OutlinedButton(onClick = { onPlay(d.progress.shuffle, true, p.name) }, modifier = Modifier.dpadFocusRing()) { Text("⏯ Resume") }
                            }
                            if (p.canEdit) {
                                if (p.smart) item {
                                    OutlinedButton(onClick = { editingRules = true }, enabled = fields != null, modifier = Modifier.dpadFocusRing()) { Text("✎ Rules") }
                                }
                                item { OutlinedButton(onClick = { renaming = true }, modifier = Modifier.dpadFocusRing()) { Text("Rename") } }
                                if (canShare) item {
                                    OutlinedButton(
                                        onClick = { guarded { detail = app.api.updatePlaylist(p.id, PlaylistUpdateRequest(shared = !p.shared)) } },
                                        modifier = Modifier.dpadFocusRing()
                                    ) { Text(if (p.shared) "Stop sharing" else "👪 Share") }
                                }
                                item { OutlinedButton(onClick = { confirmDelete = true }, modifier = Modifier.dpadFocusRing()) { Text("🗑 Delete") } }
                            }
                        }
                        if (p.smart) {
                            val summary = PlaylistLogic.ruleSummary(p.rules, fields?.fields.orEmpty())
                            Text(
                                if (summary.isBlank()) "No rules yet: everything in the library matches." else summary,
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(bottom = 6.dp)
                            )
                        }
                        if (d.items.isEmpty()) {
                            EmptyBox(if (p.smart) "Nothing matches these rules right now." else "Empty. Open a title's details and tap ＋ Playlist.")
                        }
                    }
                    itemsIndexed(d.items, key = { _, it -> it.entryId }) { index, entry ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier.size(width = 42.dp, height = 63.dp).clip(RoundedCornerShape(4.dp))
                                    .background(MaterialTheme.colorScheme.surfaceVariant)
                            ) {
                                UrlUtils.join(app.session.baseUrl, entry.poster)?.let {
                                    AsyncImage(model = it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                                }
                            }
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(entry.title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(PlaylistLogic.subtitle(entry), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (entry.available) {
                                TextButton(
                                    modifier = Modifier.dpadFocusRing(),
                                    onClick = {
                                        val playable = d.items.filter { it.available }
                                        val start = playable.indexOf(entry).coerceAtLeast(0)
                                        QueuePlayer.start(
                                            context,
                                            PlayQueue.fromPlaylist(playable.map { it.toQueueItem() }, start, p.id, p.name)
                                        )
                                    }
                                ) { Text("▶") }
                            }
                            if (p.canEdit && !p.smart) {
                                TextButton(
                                    enabled = index > 0,
                                    modifier = Modifier.dpadFocusRing(),
                                    onClick = { guarded { detail = app.api.movePlaylistItem(p.id, entry.entryId, index - 1) } }
                                ) { Text("▲") }
                                TextButton(
                                    enabled = index < d.items.size - 1,
                                    modifier = Modifier.dpadFocusRing(),
                                    onClick = { guarded { detail = app.api.movePlaylistItem(p.id, entry.entryId, index + 1) } }
                                ) { Text("▼") }
                                TextButton(
                                    modifier = Modifier.dpadFocusRing(),
                                    onClick = { guarded { detail = app.api.removeFromPlaylist(p.id, listOf(entry.entryId)) } }
                                ) { Text("✕") }
                            }
                        }
                    }
                }
                if (renaming) {
                    var name by remember { mutableStateOf(p.name) }
                    AlertDialog(
                        onDismissRequest = { renaming = false },
                        title = { Text("Rename") },
                        text = { OutlinedTextField(value = name, onValueChange = { name = it.take(100) }, singleLine = true) },
                        confirmButton = {
                            TextButton(enabled = name.isNotBlank(), onClick = {
                                renaming = false
                                guarded { detail = app.api.updatePlaylist(p.id, PlaylistUpdateRequest(name = name.trim())) }
                            }) { Text("Save") }
                        },
                        dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel") } }
                    )
                }
                if (confirmDelete) {
                    ConfirmDialog(
                        title = "Delete \"${p.name}\"?",
                        message = "The titles stay in your library; only the playlist goes.",
                        confirmLabel = "Delete",
                        onConfirm = {
                            confirmDelete = false
                            guarded {
                                app.api.deletePlaylist(p.id)
                                onBack()
                            }
                        },
                        onDismiss = { confirmDelete = false }
                    )
                }
                val f = fields
                if (editingRules && f != null) {
                    RulesEditorDialog(
                        initial = PlaylistLogic.fromJson(p.rules),
                        hasNestedGroups = PlaylistLogic.hasNestedGroups(p.rules),
                        fields = f,
                        onSave = { draft ->
                            editingRules = false
                            guarded { detail = app.api.updatePlaylist(p.id, PlaylistUpdateRequest(rules = PlaylistLogic.toJson(draft, f.fields))) }
                        },
                        onDismiss = { editingRules = false },
                        onUnauthorized = onUnauthorized
                    )
                }
            }
        }
    }
}

/** A button that opens a menu of [options]; the D-pad friendly stand-in for a <select>. */
@Composable
private fun PickerButton(label: String, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.dpadFocusRing()) { Text(label, fontSize = 13.sp, maxLines = 1) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (value, text) ->
                DropdownMenuItem(text = { Text(text) }, onClick = { open = false; onPick(value) })
            }
        }
    }
}

@Composable
private fun RulesEditorDialog(
    initial: PlaylistLogic.RulesDraft,
    hasNestedGroups: Boolean,
    fields: PlaylistFieldsResponse,
    onSave: (PlaylistLogic.RulesDraft) -> Unit,
    onDismiss: () -> Unit,
    onUnauthorized: () -> Unit
) {
    val app = BeeboApp.instance
    var draft by remember { mutableStateOf(initial) }
    var preview by remember { mutableStateOf("…") }
    val defs = fields.fields

    // Live count, a moment after the last change.
    LaunchedEffect(draft) {
        delay(350)
        preview = try {
            val r = app.api.previewPlaylistRules(PlaylistLogic.toJson(draft, defs))
            val names = r.items.take(3).joinToString(", ") { it.title }
            "${PlaylistLogic.countLabel(r.count)} match right now" + if (names.isNotBlank()) ": $names" + (if (r.count > 3) "…" else "") else ""
        } catch (e: UnauthorizedException) {
            onUnauthorized()
            ""
        } catch (e: Exception) {
            PlaylistLogic.errorText(e.message)
        }
    }

    fun setRule(i: Int, r: PlaylistLogic.RuleDraft) {
        draft = draft.copy(rules = draft.rules.mapIndexed { j, x -> if (j == i) r else x })
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Smart playlist rules") },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
                if (hasNestedGroups) {
                    Text("This playlist has grouped rules made on the website; saving here keeps only the rules shown.", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Match ")
                    PickerButton(if (draft.match == "any") "any" else "all", listOf("all" to "all", "any" to "any")) { draft = draft.copy(match = it) }
                    Text(" of these rules")
                }
                draft.rules.forEachIndexed { i, rule ->
                    val def = defs[rule.field]
                    Column(Modifier.padding(vertical = 6.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            PickerButton(def?.label ?: rule.field, defs.map { (k, v) -> k to v.label }) { setRule(i, PlaylistLogic.newRule(it, defs[it])) }
                            PickerButton(PlaylistLogic.opLabel(rule.op), def?.ops.orEmpty().map { it to PlaylistLogic.opLabel(it) }) { setRule(i, rule.copy(op = it)) }
                            TextButton(onClick = { draft = draft.copy(rules = draft.rules.filterIndexed { j, _ -> j != i }) }, modifier = Modifier.dpadFocusRing()) { Text("✕") }
                        }
                        val choices = PlaylistLogic.choicesFor(def)
                        if (choices != null) {
                            PickerButton(rule.value.ifBlank { "choose…" }, choices.map { it to it }) { setRule(i, rule.copy(value = it)) }
                        } else {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                OutlinedTextField(
                                    value = rule.value,
                                    onValueChange = { setRule(i, rule.copy(value = it.take(200))) },
                                    singleLine = true,
                                    label = { Text(def?.label ?: "Value", fontSize = 11.sp) },
                                    modifier = Modifier.weight(1f)
                                )
                                if (rule.op == "between") {
                                    OutlinedTextField(
                                        value = rule.value2,
                                        onValueChange = { setRule(i, rule.copy(value2 = it.take(200))) },
                                        singleLine = true,
                                        label = { Text("and", fontSize = 11.sp) },
                                        modifier = Modifier.weight(1f)
                                    )
                                }
                            }
                        }
                    }
                }
                PickerButton("＋ Add rule", defs.map { (k, v) -> k to v.label }) {
                    draft = draft.copy(rules = draft.rules + PlaylistLogic.newRule(it, defs[it]))
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Sort")
                    PickerButton(PlaylistLogic.sortLabel(draft.sortBy), fields.sorts.map { it to PlaylistLogic.sortLabel(it) }) { draft = draft.copy(sortBy = it) }
                    PickerButton(
                        if (draft.sortDir == "asc") "A–Z / oldest" else "newest / highest",
                        listOf("desc" to "newest / highest", "asc" to "A–Z / oldest")
                    ) { draft = draft.copy(sortDir = it) }
                }
                OutlinedTextField(
                    value = draft.limit,
                    onValueChange = { draft = draft.copy(limit = it.filter(Char::isDigit).take(4)) },
                    singleLine = true,
                    label = { Text("Limit (blank for no limit)") }
                )
                Text(preview, fontSize = 13.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = { TextButton(onClick = { onSave(draft) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}
