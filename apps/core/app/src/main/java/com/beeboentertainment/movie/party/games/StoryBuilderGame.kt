package com.beeboentertainment.movie.party.games

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.party.RoomMessenger
import com.beeboentertainment.movie.party.rememberRoomMessenger
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/*
 * "Story Builder" — a turn-based collaborative silly story for the whole car, built on the
 * shared hub room plumbing (RoomMessenger -> RoomClient -> the same /room socket a watch party
 * uses). Each phone adds one line in turn; when someone ends it, the app reads back the whole
 * assembled story with authors — a nice little trip memento.
 *
 * Wire protocol (all ride RoomClient.sendApp {type, ...}; the hub stamps `from` and never
 * echoes our own):
 *
 *   story_line  { by, text }                       a player adds their line to the story
 *   story_turn  { playerId }                        whose turn it is now (member id)
 *   story_end   { }                                 someone wraps it up — show the read-back
 *   story_full  { lines[], turn, ended }            snapshot for a late joiner (lines =
 *                                                      [{by, text}, ...])
 *
 * Turn order is the roster sorted by member id, so every phone agrees without a server. The
 * player who just added a line computes the next id and broadcasts story_turn. A fresh story
 * is just an empty line list; there is no explicit "start" — the first turn-holder types.
 */

private const val MSG_LINE = "story_line"
private const val MSG_TURN = "story_turn"
private const val MSG_END = "story_end"
private const val MSG_FULL = "story_full"

/** A single sentence in the shared story: who wrote it and what they wrote. */
private data class StoryLine(val by: String, val text: String)

/** A handful of silly opening prompts to get a story rolling. */
private val STORY_STARTERS = listOf(
    "Once upon a road trip, ",
    "Nobody expected the giant rubber duck to ",
    "Deep in the glove compartment lived ",
    "The map said turn left, but instead we ",
)

/** The next player's id in the shared turn order (roster sorted by id, wrapping around). */
private fun nextStoryTurnId(memberIds: List<String>, currentId: String?): String? {
    val order = memberIds.filter { it.isNotBlank() }.sorted()
    if (order.isEmpty()) return null
    val idx = order.indexOf(currentId)
    return if (idx < 0) order.first() else order[(idx + 1) % order.size]
}

/**
 * Route-level entry point: builds a [RoomMessenger] for the signed-in hub account and hands it
 * to the game. Falls back to a solo pad (you can add every line, nothing syncs) when the device
 * isn't on a Beebo Hub, so the screen is never a dead end. Mirrors [ThisOrThatScreen].
 */
@Composable
fun StoryBuilderScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val myName = remember {
        session.userName?.takeIf { it.isNotBlank() } ?: "Player"
    }
    val messenger = rememberRoomMessenger(session, myName)
    StoryBuilderGame(messenger = messenger, myName = myName, modifier = modifier)
}

@Composable
fun StoryBuilderGame(
    messenger: RoomMessenger?,
    myName: String,
    modifier: Modifier = Modifier,
) {
    val you = messenger?.you?.collectAsState()?.value ?: ""
    val connected = messenger?.connected?.collectAsState()?.value ?: false
    val members = messenger?.members?.collectAsState()?.value ?: emptyList()

    val lines = remember { mutableStateListOf<StoryLine>() }
    var turnId by remember { mutableStateOf<String?>(null) }
    var ended by remember { mutableStateOf(false) }
    var input by remember { mutableStateOf("") }
    var started by remember { mutableStateOf(false) }

    val solo = messenger == null || !connected
    val nameById: Map<String, String> = members.associate { it.id to it.name }
    val myTurn = solo || (turnId != null && turnId == you && you.isNotBlank())

    fun beginStory() {
        lines.clear()
        ended = false
        input = ""
        started = true
        // The starter takes the first turn.
        turnId = you
        if (!solo) messenger?.send(MSG_TURN, buildJsonObject { put("playerId", you) })
    }

    fun addLine() {
        val text = input.trim()
        if (text.isEmpty() || ended || !myTurn) return
        lines.add(StoryLine(myName, text))
        input = ""
        messenger?.send(
            MSG_LINE,
            buildJsonObject {
                put("by", myName)
                put("text", text)
            },
        )
        if (!solo) {
            val next = nextStoryTurnId(members.map { it.id }, you)
            turnId = next
            if (next != null) messenger?.send(MSG_TURN, buildJsonObject { put("playerId", next) })
        }
    }

    fun endStory() {
        ended = true
        messenger?.send(MSG_END, buildJsonObject { })
    }

    // Fold in peers' envelopes.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_LINE -> {
                    val text = msg.data["text"]?.jsonPrimitive?.content ?: return@collect
                    val by = msg.data["by"]?.jsonPrimitive?.content
                        ?: nameById[msg.from] ?: "Someone"
                    lines.add(StoryLine(by, text))
                    started = true
                }
                MSG_TURN -> {
                    turnId = msg.data["playerId"]?.jsonPrimitive?.content
                    started = true
                }
                MSG_END -> ended = true
                MSG_FULL -> {
                    if (!started && lines.isEmpty()) {
                        started = true
                        turnId = msg.data["turn"]?.jsonPrimitive?.content
                        ended = (msg.data["ended"]?.jsonPrimitive?.content == "true")
                        val arr = msg.data["lines"]?.jsonArray ?: return@collect
                        arr.forEach { el ->
                            val o = runCatching { el.jsonObject }.getOrNull() ?: return@forEach
                            val by = o["by"]?.jsonPrimitive?.content ?: "Someone"
                            val t = o["text"]?.jsonPrimitive?.content ?: return@forEach
                            lines.add(StoryLine(by, t))
                        }
                    }
                }
            }
        }
    }

    // Push the whole story to anyone who just joined so they land in sync.
    LaunchedEffect(messenger) {
        messenger?.memberJoined?.collect {
            if (!started) return@collect
            messenger.send(
                MSG_FULL,
                buildJsonObject {
                    put("turn", turnId ?: "")
                    put("ended", if (ended) "true" else "false")
                    put("lines", buildJsonArray {
                        lines.forEach { line ->
                            add(buildJsonObject {
                                put("by", line.by)
                                put("text", line.text)
                            })
                        }
                    })
                },
            )
        }
    }

    val status = when {
        messenger == null ->
            "Not connected to a Beebo Hub — connect one in Settings to write with the car. " +
                "You can still write a story here."
        !connected -> "Connecting to the room…"
        else -> "In the room — ${members.size} " + if (members.size == 1) "player" else "players"
    }
    val turnLabel = when {
        solo -> "Your turn"
        myTurn -> "Your turn!"
        turnId == null -> "Waiting to start…"
        else -> "${nameById[turnId] ?: "Someone"} is writing"
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Story Builder", style = MaterialTheme.typography.titleLarge)
        Text(
            status,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (!started) {
            Text(
                "Build a silly story together — everyone adds one line in turn, then read it " +
                    "back as a trip memento.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Need a spark?", style = MaterialTheme.typography.titleMedium)
                    STORY_STARTERS.forEach { s ->
                        Text(
                            "“$s…”",
                            style = MaterialTheme.typography.bodyMedium,
                            fontStyle = FontStyle.Italic,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Button(onClick = { beginStory() }) { Text("Start the story") }
        } else if (ended) {
            // ---- Read-it-back memento screen ----
            Text("The End 🎉", style = MaterialTheme.typography.titleMedium)
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (lines.isEmpty()) {
                        Text(
                            "The story was empty — start a new one!",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    } else {
                        // The assembled story, read as one flowing paragraph.
                        Text(
                            lines.joinToString(" ") { it.text },
                            fontSize = 18.sp,
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        Text(
                            "Line by line",
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        lines.forEach { line ->
                            Text(
                                "“${line.text}”  — ${line.by}",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
            }
            OutlinedButton(onClick = { beginStory() }) { Text("Write another") }
        } else {
            // ---- Writing screen ----
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        turnLabel,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Bold,
                        color = if (myTurn) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        "${lines.size} " + (if (lines.size == 1) "line" else "lines") + " so far",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                enabled = myTurn,
                label = { Text(if (myTurn) "Add the next line" else "Wait for your turn") },
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(
                    enabled = myTurn && input.trim().isNotEmpty(),
                    onClick = { addLine() },
                ) { Text("Add line") }
                OutlinedButton(
                    enabled = lines.isNotEmpty(),
                    onClick = { endStory() },
                ) { Text("Read it back") }
            }

            // The story so far.
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("The story so far", style = MaterialTheme.typography.titleMedium)
                    if (lines.isEmpty()) {
                        Text(
                            "No lines yet — the first writer sets the scene.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        lines.forEach { line ->
                            val mine = line.by == myName
                            Text(
                                "${line.text}  — ${if (mine) "you" else line.by}",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = if (mine) FontWeight.Bold else FontWeight.Normal,
                                color = if (mine) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.onSurface,
                            )
                        }
                    }
                }
            }
        }
    }
}
