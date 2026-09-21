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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
 * "Would You Rather" — a quick bonus that reuses the whole game stack (GameShell + the same three
 * wire messages This or That uses). It is deliberately the cheapest possible second game: a
 * hardcoded fun prompt list, everyone taps, host reveals the split.
 *
 *   wyr_prompt  { promptId, optionA, optionB }   host starts; all reset & show
 *   wyr_answer  { promptId, optionId }           a phone taps; peers tally it
 *   wyr_reveal  { promptId }                      host reveals; all show the split at once
 */

private const val MSG_PROMPT = "wyr_prompt"
private const val MSG_ANSWER = "wyr_answer"
private const val MSG_REVEAL = "wyr_reveal"

private const val OPT_A = "A"
private const val OPT_B = "B"

/** The built-in "Would you rather…" pairs the host cycles through. */
private val PROMPTS: List<Pair<String, String>> = listOf(
    "Be able to fly" to "Be invisible",
    "Only watch cartoons forever" to "Only watch movies forever",
    "Have a pet wolf" to "Have a pet eagle",
    "Live at the beach" to "Live in the mountains",
    "Never eat candy again" to "Never eat pizza again",
    "Be super strong" to "Be super fast",
    "Time travel to the past" to "Time travel to the future",
    "Have a robot best friend" to "Have a talking pet",
    "Always be too hot" to "Always be too cold",
    "Explore outer space" to "Explore the deep ocean",
    "Read minds" to "See the future",
    "Have unlimited snacks" to "Have unlimited toys",
    "Skip work for a week" to "Get an extra week of vacation",
    "Be a famous movie star" to "Be a famous inventor",
)

@Composable
fun WouldYouRatherScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val deviceName = remember { session.userName?.takeIf { it.isNotBlank() } ?: "Player" }
    val messenger = rememberRoomMessenger(session, deviceName)
    WouldYouRatherGame(messenger = messenger, modifier = modifier)
}

@Composable
fun WouldYouRatherGame(messenger: RoomMessenger?, modifier: Modifier = Modifier) {
    val you = messenger?.you?.collectAsState()?.value ?: ""
    val connected = messenger?.connected?.collectAsState()?.value ?: false
    val members = messenger?.members?.collectAsState()?.value ?: emptyList()

    var promptId by remember { mutableStateOf<String?>(null) }
    var optionA by remember { mutableStateOf("") }
    var optionB by remember { mutableStateOf("") }
    var myAnswer by remember { mutableStateOf<String?>(null) }
    var revealed by remember { mutableStateOf(false) }
    val answers = remember { mutableStateMapOf<String, String>() }

    var isHost by remember { mutableStateOf(false) }

    fun resetRound(id: String, a: String, b: String) {
        promptId = id
        optionA = a
        optionB = b
        myAnswer = null
        revealed = false
        answers.clear()
    }

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
                    if (id == promptId && opt != null && msg.from.isNotBlank()) answers[msg.from] = opt
                }
                MSG_REVEAL -> {
                    val id = msg.data["promptId"]?.jsonPrimitive?.content
                    if (id == promptId) revealed = true
                }
            }
        }
    }

    // Late joiners catch the current prompt from the host.
    LaunchedEffect(messenger) {
        messenger?.memberJoined?.collect {
            if (!isHost) return@collect
            val id = promptId ?: return@collect
            messenger.send(
                MSG_PROMPT,
                buildJsonObject { put("promptId", id); put("optionA", optionA); put("optionB", optionB) },
            )
        }
    }

    fun newPrompt() {
        val (a, b) = PROMPTS[Random.nextInt(PROMPTS.size)]
        val id = "wyr" + System.currentTimeMillis() + "-" + Random.nextInt(1000)
        resetRound(id, a, b)
        messenger?.send(
            MSG_PROMPT,
            buildJsonObject { put("promptId", id); put("optionA", a); put("optionB", b) },
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
        val self = you.ifBlank { "me" }
        answers[self] = optionId
        messenger?.send(
            MSG_ANSWER,
            buildJsonObject { put("promptId", id); put("optionId", optionId) },
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
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FilterChip(selected = isHost, onClick = { isHost = true }, label = { Text("Be the host") })
            FilterChip(selected = !isHost, onClick = { isHost = false }, label = { Text("Just play") })
        }

        GameShell(
            headline = "Would You Rather",
            status = status,
            prompt = promptId?.let { "Would you rather…" },
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
                        Text(if (promptId == null) "Start" else "Next one")
                    }
                    OutlinedButton(
                        enabled = promptId != null && !revealed,
                        onClick = { reveal() },
                    ) { Text("Reveal") }
                }
            } else if (promptId == null) {
                Card {
                    Text(
                        "Waiting for the host to start. Tap \"Be the host\" to run it from this phone.",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
    }
}
