package com.beeboentertainment.movie.watchtogether

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.server.SafeText
import com.beeboentertainment.movie.server.ServerException
import com.beeboentertainment.movie.ui.tv.DpadTextField
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The title being watched, so a room can be started for it. */
data class WtStart(val kind: String, val id: String, val title: String)

/** A short hex colour from the server (an avatar colour), or grey. Never anything else. */
internal fun avatarColor(hex: String): Color {
    val m = Regex("^#([0-9a-fA-F]{6})$").matchEntire(hex.trim()) ?: return Color(0xFF888888)
    return Color(0xFF000000 or m.groupValues[1].toLong(16))
}

/**
 * The small in-player panel: who is here (with ready / buffering), the room's speed, reactions and
 * chat, the invite, and leaving. Everything from other people is drawn as plain text.
 */
@Composable
fun WatchTogetherPanel(session: WtSession, start: WtStart?, onClose: () -> Unit) {
    val ui by session.ui.collectAsState()
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var invite by remember { mutableStateOf("") }
    var everyoneControls by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }

    Box(Modifier.fillMaxSize().background(Color(0xCC000000))) {
        Column(
            Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(380.dp)
                .background(MaterialTheme.colorScheme.surface).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Watch together", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = onClose) { Text("Close") }
            }
            (note ?: ui.message)?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }

            val room = ui.room
            if (room == null || ui.phase != WtUi.Phase.IN_ROOM) {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (ui.phase == WtUi.Phase.ENDED) Text("You are not in a room any more.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (start != null) {
                        Text("Start a room for this title", fontWeight = FontWeight.Bold)
                        Text(SafeText.clean(start.title, 120), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Switch(checked = everyoneControls, onCheckedChange = { everyoneControls = it })
                            Spacer(Modifier.width(8.dp)); Text("Everyone can control playback", fontSize = 13.sp)
                        }
                        Button(enabled = !busy, onClick = {
                            busy = true; note = null
                            scope.launch {
                                try { session.create(start.kind, start.id, start.title, everyoneControls) }
                                catch (e: UnauthorizedException) { note = "Your sign-in ended." }
                                catch (e: ServerException) { note = WtProtocol.message(e.code, e.message) }
                                catch (e: Exception) { note = e.message ?: "That didn't work." }
                                finally { busy = false }
                            }
                        }) { Text("Start a room") }
                        HorizontalDivider()
                    }
                    Text("Have a code or link?", fontWeight = FontWeight.Bold)
                    DpadTextField(Modifier.fillMaxWidth()) { tv ->
                        OutlinedTextField(
                            value = invite, onValueChange = { invite = it.take(300) },
                            label = { Text("Invite link or code") }, singleLine = true, modifier = tv.fillMaxWidth()
                        )
                    }
                    OutlinedButton(enabled = !busy && invite.isNotBlank(), onClick = {
                        val c = WtProtocol.codeFromInvite(invite)
                        if (c == null) { note = "That doesn't look like an invite link or code."; return@OutlinedButton }
                        busy = true; note = null
                        scope.launch {
                            try { session.join(c); invite = "" }
                            catch (e: UnauthorizedException) { note = "Your sign-in ended." }
                            catch (e: ServerException) { note = WtProtocol.message(e.code, e.message) }
                            catch (e: Exception) { note = e.message ?: "That didn't work." }
                            finally { busy = false }
                        }
                    }) { Text("Join") }
                    Text("Only people signed in to this Beebo can join. Video streams from the computer to each person as usual; only tiny control messages are shared.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                return@Column
            }

            Text(SafeText.clean(room.media.title, 120), fontWeight = FontWeight.SemiBold, maxLines = 2)
            ui.holdLine?.let { Text(it, color = MaterialTheme.colorScheme.primary, fontSize = 13.sp) }
            if (!ui.connected) Text("Reconnecting to the room…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

            // People
            room.participants.forEach { p ->
                var menu by remember(p.pid) { mutableStateOf(false) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(26.dp).clip(CircleShape).background(avatarColor(p.color)), contentAlignment = Alignment.Center) {
                        Text(SafeText.clean(p.initial, 2), color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(WtProtocol.participantLine(p, p.pid == ui.you), modifier = Modifier.weight(1f), fontSize = 13.sp)
                    if (ui.isHost && p.pid != ui.you) Box {
                        TextButton(onClick = { menu = true }) { Text("⋮") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("Make host") }, onClick = { menu = false; session.makeHost(p.pid) })
                            DropdownMenuItem(text = { Text("Remove from the room") }, onClick = { menu = false; session.remove(p.pid) })
                        }
                    }
                }
            }

            // Invite (host)
            val code = session.roomCodeForInvite
            if (code != null) {
                val link = WtProtocol.inviteUrl(BeeboApp.instance.session.baseUrl, code)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (link != null) OutlinedButton(onClick = { clipboard.setText(AnnotatedString(link)); note = "Invite link copied." }) { Text("Copy invite link") }
                    OutlinedButton(onClick = { clipboard.setText(AnnotatedString(code)); note = "Code copied." }) { Text("Copy code") }
                }
            }

            // Speed
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.verticalScroll(rememberScrollState())) {
                WtProtocol.RATES.forEach { r ->
                    FilterChip(
                        selected = kotlin.math.abs(room.timeline.rate - r) < 0.001, enabled = ui.canControl,
                        onClick = { session.setRate(r) }, label = { Text(com.beeboentertainment.movie.audiobooks.AudiobookLogic.speedLabel(r)) }
                    )
                }
            }
            if (!ui.canControl) Text("Only the host controls playback in this room.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

            // Host settings
            if (ui.isHost) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = room.settings.control == "everyone", onCheckedChange = { session.setSettings(control = if (it) "everyone" else "host") })
                    Spacer(Modifier.width(8.dp)); Text("Everyone can control", fontSize = 13.sp)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = room.settings.waitForBuffering, onCheckedChange = { session.setSettings(wait = it) })
                    Spacer(Modifier.width(8.dp)); Text("Pause when someone buffers", fontSize = 13.sp)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = room.settings.chat, onCheckedChange = { session.setSettings(chat = it) })
                    Spacer(Modifier.width(8.dp)); Text("Chat", fontSize = 13.sp)
                }
            }

            // Reactions
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.verticalScroll(rememberScrollState())) {
                WtProtocol.REACTIONS.forEach { e -> TextButton(onClick = { session.react(e) }) { Text(e, fontSize = 20.sp) } }
            }

            // Chat
            val listState = rememberLazyListState()
            LaunchedEffect(ui.chat.size) { if (ui.chat.isNotEmpty()) listState.animateScrollToItem(ui.chat.lastIndex) }
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState) {
                items(ui.chat, key = { "${it.eventId}-${it.id}-${it.pid}" }) { m ->
                    Text(
                        androidx.compose.ui.text.buildAnnotatedString {
                            pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold, color = avatarColor(m.color)))
                            append(SafeText.clean(m.name, WtProtocol.NAME_MAX)); append(": ")
                            pop()
                            append(SafeText.clean(m.text, WtProtocol.CHAT_MAX))
                        },
                        fontSize = 13.sp, modifier = Modifier.padding(vertical = 2.dp)
                    )
                }
            }
            if (room.settings.chat || ui.isHost) Row(verticalAlignment = Alignment.CenterVertically) {
                DpadTextField(Modifier.weight(1f)) { tv ->
                    OutlinedTextField(
                        value = draft, onValueChange = { draft = it.take(WtProtocol.CHAT_MAX) },
                        placeholder = { Text("Message") }, singleLine = true, modifier = tv.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { session.sendChat(draft); draft = "" })
                    )
                }
                TextButton(enabled = draft.isNotBlank(), onClick = { session.sendChat(draft); draft = "" }) { Text("Send") }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { session.leave(); onClose() }) { Text("Leave room") }
                if (ui.isHost) OutlinedButton(onClick = { session.endForEveryone(); onClose() }) { Text("End for everyone") }
            }
            Spacer(Modifier.height(4.dp))
        }
    }
    LaunchedEffect(note) { if (note != null) { delay(3000); note = null } }
}

/** A small strip over the picture while in a room: who is holding things up, and the latest reaction. */
@Composable
fun WatchTogetherBanner(session: WtSession) {
    val ui by session.ui.collectAsState()
    val reaction = ui.lastReaction
    var shown by remember { mutableStateOf<WtReaction?>(null) }
    LaunchedEffect(reaction) { if (reaction != null) { shown = reaction; delay(3000); shown = null } }
    if (ui.phase != WtUi.Phase.IN_ROOM) return
    val line = ui.holdLine
    if (line == null && shown == null && ui.connected) return
    Column(Modifier.background(Color(0xAA000000), androidx.compose.foundation.shape.RoundedCornerShape(8.dp)).padding(horizontal = 12.dp, vertical = 6.dp)) {
        line?.let { Text(it, color = Color.White, fontSize = 13.sp) }
        if (!ui.connected) Text("Reconnecting to the room…", color = Color.White, fontSize = 12.sp)
        shown?.let { Text(SafeText.clean(it.name, WtProtocol.NAME_MAX) + " " + it.emoji.takeIf { e -> e in WtProtocol.REACTIONS }.orEmpty(), color = Color.White, fontSize = 18.sp) }
    }
}
