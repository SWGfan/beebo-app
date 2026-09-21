package com.beeboentertainment.movie.party.games

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.party.RoomMessenger
import com.beeboentertainment.movie.party.rememberRoomMessenger
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.random.Random

/*
 * "This or That" — the smallest end-to-end synced party game, built on the existing
 * hub room plumbing (RoomMessenger -> RoomClient -> the same /room socket a watch party
 * uses). It exists mainly to exercise the reusable [GameShell]; a second game would be a
 * new prompt list and the same three message types.
 *
 * Wire protocol (all ride RoomClient.sendApp as {type, ...}, relayed by the hub which
 * stamps `from` and never echoes our own):
 *
 *   game_prompt  { promptId, optionA, optionB }   host starts a round; all reset & show
 *   game_answer  { promptId, optionId }           a phone taps; peers tally it
 *   game_reveal  { promptId }                      host reveals; all show counts at once
 *
 * Each phone tallies from the answers it hears plus its own local pick (never echoed),
 * so counts are correct everywhere without a server tally.
 */

private const val MSG_PROMPT = "game_prompt"
private const val MSG_ANSWER = "game_answer"
private const val MSG_REVEAL = "game_reveal"

private const val OPT_A = "A"
private const val OPT_B = "B"

/** The built-in prompt pairs the host cycles through. */
private val PROMPTS: List<Pair<String, String>> = listOf(
    "Chocolate" to "Vanilla",
    "Beach day" to "Mountain trip",
    "Cats" to "Dogs",
    "Pizza" to "Tacos",
    "Sweet" to "Salty",
    "Summer" to "Winter",
    "Books" to "Movies",
    "Early bird" to "Night owl",
    "Coffee" to "Tea",
    "Window seat" to "Aisle seat",
    "Save it" to "Spend it",
    "Text back" to "Call back",
)

/**
 * Route-level entry point: builds a [RoomMessenger] for the signed-in hub account and
 * hands it to the game. Falls back to a local-only board (taps work, nothing syncs) when
 * the device isn't connected to a Beebo Hub, so the screen is never a dead end.
 */
@Composable
fun ThisOrThatScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val deviceName = remember {
        session.userName?.takeIf { it.isNotBlank() } ?: "Player"
    }
    val messenger = rememberRoomMessenger(session, deviceName)
    ThisOrThatGame(messenger = messenger, modifier = modifier)
}

@Composable
fun ThisOrThatGame(messenger: RoomMessenger?, modifier: Modifier = Modifier) {
    val you = messenger?.you?.collectAsState()?.value ?: ""
    val connected = messenger?.connected?.collectAsState()?.value ?: false
    val members = messenger?.members?.collectAsState()?.value ?: emptyList()

    // Round state, all reset on a fresh game_prompt.
    var promptId by remember { mutableStateOf<String?>(null) }
    var optionA by remember { mutableStateOf("") }
    var optionB by remember { mutableStateOf("") }
    var myAnswer by remember { mutableStateOf<String?>(null) }
    var revealed by remember { mutableStateOf(false) }
    // answererId -> optionId for the current prompt (our own pick included locally).
    val answers = remember { mutableStateMapOf<String, String>() }

    // Whether this phone drives the round. Mirrors the party Host/Join chips.
    var isHost by remember { mutableStateOf(false) }

    fun resetRound(id: String, a: String, b: String) {
        promptId = id
        optionA = a
        optionB = b
        myAnswer = null
        revealed = false
        answers.clear()
        // Persist a lightweight play tally so the Trip Recap can report rounds played.
        ThisOrThatStats.recordRound(BeeboApp.instance.session.plain)
    }

    // Listen for peers' envelopes and fold them into local round state.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_PROMPT -> {
                    val id = msg.data["promptId"]?.jsonPrimitive?.content ?: return@collect
                    val a = msg.data["optionA"]?.jsonPrimitive?.content ?: "This"
                    val b = msg.data["optionB"]?.jsonPrimitive?.content ?: "That"
                    resetRound(id, a, b)
                }
                MSG_ANSWER -> {
                    val id = msg.data["promptId"]?.jsonPrimitive?.content
                    val opt = msg.data["optionId"]?.jsonPrimitive?.content
                    if (id == promptId && opt != null && msg.from.isNotBlank()) {
                        answers[msg.from] = opt
                    }
                }
                MSG_REVEAL -> {
                    val id = msg.data["promptId"]?.jsonPrimitive?.content
                    if (id == promptId) revealed = true
                }
            }
        }
    }

    fun newPrompt() {
        val (a, b) = PROMPTS[Random.nextInt(PROMPTS.size)]
        val id = "p" + System.currentTimeMillis() + "-" + Random.nextInt(1000)
        resetRound(id, a, b)
        messenger?.send(
            MSG_PROMPT,
            buildJsonObject {
                put("promptId", id)
                put("optionA", a)
                put("optionB", b)
            },
        )
    }

    fun reveal() {
        val id = promptId ?: return
        revealed = true
        messenger?.send(MSG_REVEAL, buildJsonObject { put("promptId", id) })
    }

    fun pick(optionId: String) {
        val id = promptId ?: return
        if (revealed) return
        myAnswer = optionId
        // Count our own pick locally — the hub never echoes it back to us.
        val self = you.ifBlank { "me" }
        answers[self] = optionId
        messenger?.send(
            MSG_ANSWER,
            buildJsonObject {
                put("promptId", id)
                put("optionId", optionId)
            },
        )
    }

    val results = mapOf(
        OPT_A to answers.values.count { it == OPT_A },
        OPT_B to answers.values.count { it == OPT_B },
    )
    val totalPlayers = members.size.coerceAtLeast(if (myAnswer != null) 1 else 0)

    val status = when {
        messenger == null ->
            "Not connected to a Beebo Hub — connect one in Settings to play with the car. " +
                "You can still try the board here."
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
        // Host / Join toggle — a host drives the prompts; everyone else just taps.
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FilterChip(
                selected = isHost,
                onClick = { isHost = true },
                label = { Text("Be the host") },
            )
            FilterChip(
                selected = !isHost,
                onClick = { isHost = false },
                label = { Text("Just play") },
            )
        }

        GameShell(
            headline = "This or That",
            status = status,
            prompt = promptId?.let { "$optionA  or  $optionB?" },
            options = listOf(
                GameOption(OPT_A, optionA.ifBlank { "This" }),
                GameOption(OPT_B, optionB.ifBlank { "That" }),
            ),
            selectedId = myAnswer,
            locked = revealed || promptId == null,
            revealed = revealed,
            results = results,
            totalPlayers = totalPlayers,
            totalAnswered = answers.size,
            onSelect = { pick(it) },
        ) {
            if (isHost) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = { newPrompt() }) {
                        Text(if (promptId == null) "Start a round" else "New prompt")
                    }
                    OutlinedButton(
                        enabled = promptId != null && !revealed,
                        onClick = { reveal() },
                    ) { Text("Reveal") }
                }
            } else if (promptId == null) {
                Card {
                    Text(
                        "Waiting for the host to start a round. Tap \"Be the host\" to run it " +
                            "from this phone.",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
    }
}
