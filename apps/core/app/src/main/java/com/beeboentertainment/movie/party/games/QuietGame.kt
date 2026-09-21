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
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.party.RoomMessenger
import com.beeboentertainment.movie.party.rememberRoomMessenger
import kotlinx.coroutines.delay
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/*
 * "The Quiet Game" — a gamified shared countdown for the whole car, built on the shared hub
 * room plumbing (RoomMessenger -> RoomClient -> the same /room socket a watch party uses).
 * Everyone starts the timer together and stays silent; the moment you talk or laugh you "tap
 * out". Every phone shows who's still in vs out live, and the last one still in wins.
 *
 * Wire protocol (all ride RoomClient.sendApp {type, ...}; the hub stamps `from` and never
 * echoes our own):
 *
 *   quiet_start  { seconds }                          start the shared countdown NOW
 *   quiet_out    { by, at }                           a player tapped out (talked / laughed)
 *   quiet_full   { seconds, remaining, outs[] }       snapshot for a late joiner (outs =
 *                                                        [{id, by, at}, ...])
 *
 * There's no server clock: each phone starts its own countdown from the same `seconds` when it
 * hears quiet_start, which is plenty for a lighthearted filler. Outs are keyed by member id so
 * two players sharing a name never collide, and carry a display name for the live board.
 */

private const val MSG_START = "quiet_start"
private const val MSG_OUT = "quiet_out"
private const val MSG_FULL = "quiet_full"

/** Selectable round lengths, in seconds. */
private val DURATIONS = listOf(30, 60, 120, 300)

/** Who tapped out and when, for the live board and the eventual winner. */
private data class OutInfo(val name: String, val at: Long)

private fun fmt(totalSeconds: Long): String {
    val s = totalSeconds.coerceAtLeast(0)
    return "%d:%02d".format(s / 60, s % 60)
}

/**
 * Route-level entry point: builds a [RoomMessenger] for the signed-in hub account and hands it
 * to the game. Falls back to a solo timer (you can run the clock, nothing syncs) when the device
 * isn't on a Beebo Hub, so the screen is never a dead end. Mirrors [ThisOrThatScreen].
 */
@Composable
fun QuietGameScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val myName = remember {
        session.userName?.takeIf { it.isNotBlank() } ?: "Player"
    }
    val messenger = rememberRoomMessenger(session, myName)
    QuietGame(messenger = messenger, myName = myName, modifier = modifier)
}

@Composable
fun QuietGame(
    messenger: RoomMessenger?,
    myName: String,
    modifier: Modifier = Modifier,
) {
    val you = messenger?.you?.collectAsState()?.value ?: ""
    val connected = messenger?.connected?.collectAsState()?.value ?: false
    val members = messenger?.members?.collectAsState()?.value ?: emptyList()

    val solo = messenger == null || !connected
    val meKey = you.ifBlank { "me" }

    var pickedSeconds by remember { mutableStateOf(60) }
    var started by remember { mutableStateOf(false) }
    var totalSeconds by remember { mutableStateOf(60) }
    var endAt by remember { mutableStateOf(0L) }
    // memberId -> when/who tapped out. mutableStateMap repaints the board on every change.
    val outs = remember { mutableStateMapOf<String, OutInfo>() }

    // A ticking clock so the countdown and the "time's up" transition repaint.
    var nowTick by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(started, endAt) {
        while (started && System.currentTimeMillis() < endAt) {
            nowTick = System.currentTimeMillis()
            delay(250)
        }
        nowTick = System.currentTimeMillis()
    }

    fun startRound(seconds: Int, broadcast: Boolean) {
        totalSeconds = seconds
        endAt = System.currentTimeMillis() + seconds * 1000L
        outs.clear()
        started = true
        nowTick = System.currentTimeMillis()
        if (broadcast) messenger?.send(MSG_START, buildJsonObject { put("seconds", seconds) })
    }

    fun tapOut() {
        if (!started || outs.containsKey(meKey)) return
        val at = System.currentTimeMillis()
        outs[meKey] = OutInfo(myName, at)
        messenger?.send(
            MSG_OUT,
            buildJsonObject {
                put("by", myName)
                put("at", at)
            },
        )
    }

    // Fold in peers' envelopes.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_START -> {
                    val secs = msg.data["seconds"]?.jsonPrimitive?.intOrNull ?: 60
                    startRound(secs, broadcast = false)
                }
                MSG_OUT -> {
                    val id = msg.from.ifBlank { return@collect }
                    val by = msg.data["by"]?.jsonPrimitive?.content ?: "Someone"
                    val at = msg.data["at"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis()
                    if (!outs.containsKey(id)) outs[id] = OutInfo(by, at)
                }
                MSG_FULL -> {
                    // Only adopt a running round we're not already in.
                    if (!started) {
                        val secs = msg.data["seconds"]?.jsonPrimitive?.intOrNull ?: 60
                        val remaining = msg.data["remaining"]?.jsonPrimitive?.longOrNull ?: 0L
                        if (remaining > 0) {
                            totalSeconds = secs
                            endAt = System.currentTimeMillis() + remaining * 1000L
                            started = true
                            nowTick = System.currentTimeMillis()
                        }
                    }
                    msg.data["outs"]?.jsonArray?.forEach { el ->
                        val o = runCatching { el.jsonObject }.getOrNull() ?: return@forEach
                        val id = o["id"]?.jsonPrimitive?.content ?: return@forEach
                        val by = o["by"]?.jsonPrimitive?.content ?: "Someone"
                        val at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L
                        if (!outs.containsKey(id)) outs[id] = OutInfo(by, at)
                    }
                }
            }
        }
    }

    // Catch a late joiner up on the running round and who's already out.
    LaunchedEffect(messenger) {
        messenger?.memberJoined?.collect {
            if (!started) return@collect
            val remaining = ((endAt - System.currentTimeMillis()) / 1000L).coerceAtLeast(0)
            messenger.send(
                MSG_FULL,
                buildJsonObject {
                    put("seconds", totalSeconds)
                    put("remaining", remaining)
                    put("outs", buildJsonArray {
                        outs.forEach { (id, info) ->
                            add(buildJsonObject {
                                put("id", id)
                                put("by", info.name)
                                put("at", info.at)
                            })
                        }
                    })
                },
            )
        }
    }

    val remainingMs = (endAt - nowTick).coerceAtLeast(0)
    val timeUp = started && remainingMs <= 0L

    // Roster of participants. Solo mode is just you; otherwise everyone in the room. Ensure
    // anyone who tapped out shows up even if the roster is briefly incomplete.
    val participants: List<Pair<String, String>> =
        if (solo) listOf(meKey to myName)
        else (members.map { it.id to it.name.ifBlank { "Player" } } +
            outs.map { it.key to it.value.name }).distinctBy { it.first }

    val inPlayers = participants.filter { !outs.containsKey(it.first) }
    val outPlayers = participants.filter { outs.containsKey(it.first) }
        .sortedBy { outs[it.first]?.at ?: 0L }

    // The game is decided when time runs out, or when only one player is left in a multi-player
    // room (last one standing). Survivors are everyone still in at that point.
    val decided = started && (timeUp || (participants.size > 1 && inPlayers.size <= 1))
    val iAmOut = outs.containsKey(meKey)

    val status = when {
        messenger == null ->
            "Not connected to a Beebo Hub — connect one in Settings to play the whole car. " +
                "You can still run the timer here."
        !connected -> "Connecting to the room…"
        else -> "In the room — ${members.size} " + if (members.size == 1) "player" else "players"
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("The Quiet Game", style = MaterialTheme.typography.titleLarge)
        Text(
            status,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (!started) {
            Text(
                "Everyone goes silent when the timer starts. The moment you talk or laugh, tap " +
                    "out. Last one still quiet wins!",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text("How long?", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DURATIONS.forEach { d ->
                    FilterChip(
                        selected = d == pickedSeconds,
                        onClick = { pickedSeconds = d },
                        label = { Text(fmt(d.toLong())) },
                    )
                }
            }
            Button(onClick = { startRound(pickedSeconds, broadcast = true) }) {
                Text("Start the quiet")
            }
        } else {
            // ---- Big countdown ----
            Card(Modifier.fillMaxWidth()) {
                Column(
                    Modifier.fillMaxWidth().padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        fmt(remainingMs / 1000L),
                        fontSize = 56.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (timeUp) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        when {
                            decided -> "Time's up — see who made it!"
                            iAmOut -> "You're out — cheer the others on 🤫"
                            else -> "Shhh… stay quiet"
                        },
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (!decided) {
                Button(
                    enabled = !iAmOut,
                    onClick = { tapOut() },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (iAmOut) "You tapped out" else "I talked / laughed — tap out!")
                }
            }

            // ---- Winner banner ----
            if (decided) {
                val survivors = inPlayers.map { it.second }
                Card(Modifier.fillMaxWidth()) {
                    Column(
                        Modifier.fillMaxWidth().padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            when {
                                survivors.isEmpty() -> "Everyone cracked! No winner 😄"
                                survivors.size == 1 -> "🏆 Winner: ${survivors.first()}"
                                else -> "🏆 Winners: ${survivors.joinToString(", ")}"
                            },
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        if (survivors.any { it == myName } && !iAmOut) {
                            Text(
                                "You stayed quiet the longest!",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            // ---- Live board: still in vs out ----
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Card(Modifier.weight(1f)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            "Still in (${inPlayers.size})",
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        if (inPlayers.isEmpty()) {
                            Text("—", style = MaterialTheme.typography.bodyMedium)
                        } else {
                            inPlayers.forEach { (id, name) ->
                                Text(
                                    if (id == meKey) "$name (you)" else name,
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = if (id == meKey) FontWeight.Bold else FontWeight.Normal,
                                )
                            }
                        }
                    }
                }
                Card(Modifier.weight(1f)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            "Tapped out (${outPlayers.size})",
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (outPlayers.isEmpty()) {
                            Text("—", style = MaterialTheme.typography.bodyMedium)
                        } else {
                            outPlayers.forEach { (id, name) ->
                                Text(
                                    if (id == meKey) "$name (you)" else name,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }

            OutlinedButton(onClick = {
                started = false
                outs.clear()
            }) { Text("New round") }
        }
    }
}
