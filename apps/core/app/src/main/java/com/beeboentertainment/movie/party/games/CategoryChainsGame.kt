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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
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
 * "Category Chains" — a turn-based word chain for the whole car, built on the shared hub
 * room plumbing (RoomMessenger -> RoomClient -> the same /room socket a watch party uses).
 * The host (whoever starts) picks a category; players take turns naming something in it
 * where each answer must start with the LAST letter of the previous answer. The app enforces
 * whose turn it is (turn passes on submit) and shows the running chain to everyone.
 *
 * Wire protocol (all ride RoomClient.sendApp {type, ...}; the hub stamps `from` and never
 * echoes our own):
 *
 *   chain_start  { category }                         someone starts a fresh chain
 *   chain_add    { by, word }                         a player adds their word to the chain
 *   chain_turn   { playerId }                         whose turn it is now (member id)
 *   chain_full   { category, words[], turn }          snapshot for a late joiner (words =
 *                                                        [{by, word}, ...])
 *
 * Turn order is the roster sorted by member id, so every phone agrees without a server. The
 * player who just submitted computes the next id and broadcasts chain_turn; validation is
 * intentionally friendly (any non-empty answer starting with the required letter is accepted
 * — we never try to verify it's a "real" thing).
 */

private const val MSG_START = "chain_start"
private const val MSG_ADD = "chain_add"
private const val MSG_TURN = "chain_turn"
private const val MSG_FULL = "chain_full"

/** A built-in list of easy, kid-friendly categories to chain within. */
private val CATEGORIES = listOf(
    "Animals", "Movies", "Cities", "Foods", "Countries", "Names", "Sports", "Colors",
)

/** One link in the chain: who added it and the word they said. */
private data class ChainLink(val by: String, val word: String)

/** The required first letter for the next word, or null when the chain is empty. */
private fun requiredLetter(chain: List<ChainLink>): Char? =
    chain.lastOrNull()?.word?.trim()?.lastOrNull { it.isLetter() }?.uppercaseChar()

/** The next player's id in the shared turn order (roster sorted by id, wrapping around). */
private fun nextTurnId(memberIds: List<String>, currentId: String?): String? {
    val order = memberIds.filter { it.isNotBlank() }.sorted()
    if (order.isEmpty()) return null
    val idx = order.indexOf(currentId)
    return if (idx < 0) order.first() else order[(idx + 1) % order.size]
}

/**
 * Route-level entry point: builds a [RoomMessenger] for the signed-in hub account and hands
 * it to the game. Falls back to a solo board (you can add words freely, nothing syncs) when
 * the device isn't on a Beebo Hub, so the screen is never a dead end. Mirrors [ThisOrThatScreen].
 */
@Composable
fun CategoryChainsScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val myName = remember {
        session.userName?.takeIf { it.isNotBlank() } ?: "Player"
    }
    val messenger = rememberRoomMessenger(session, myName)
    CategoryChainsGame(messenger = messenger, myName = myName, modifier = modifier)
}

@Composable
fun CategoryChainsGame(
    messenger: RoomMessenger?,
    myName: String,
    modifier: Modifier = Modifier,
) {
    val you = messenger?.you?.collectAsState()?.value ?: ""
    val connected = messenger?.connected?.collectAsState()?.value ?: false
    val members = messenger?.members?.collectAsState()?.value ?: emptyList()

    var category by remember { mutableStateOf<String?>(null) }
    val chain = remember { mutableStateListOf<ChainLink>() }
    var turnId by remember { mutableStateOf<String?>(null) }
    var input by remember { mutableStateOf("") }
    var selectedCategory by remember { mutableStateOf(CATEGORIES.first()) }

    // Solo mode: no hub (or not yet connected) — you drive the whole chain on this phone.
    val solo = messenger == null || !connected
    val nameById: Map<String, String> = members.associate { it.id to it.name }
    val myTurn = solo || (turnId != null && turnId == you && you.isNotBlank())

    fun startChain(cat: String, broadcast: Boolean, firstTurn: String?) {
        category = cat
        chain.clear()
        input = ""
        turnId = firstTurn
        if (broadcast) {
            messenger?.send(MSG_START, buildJsonObject { put("category", cat) })
            if (firstTurn != null) {
                messenger?.send(MSG_TURN, buildJsonObject { put("playerId", firstTurn) })
            }
        }
    }

    fun submitWord() {
        val word = input.trim()
        if (word.isEmpty()) return
        val need = requiredLetter(chain)
        // Friendly validation: only enforce the starting letter, never whether it's "real".
        if (need != null && word.first().uppercaseChar() != need) return
        if (!myTurn) return
        chain.add(ChainLink(myName, word))
        input = ""
        messenger?.send(
            MSG_ADD,
            buildJsonObject {
                put("by", myName)
                put("word", word)
            },
        )
        // Pass the turn along the shared order (solo just keeps it on you).
        if (!solo) {
            val next = nextTurnId(members.map { it.id }, you)
            turnId = next
            if (next != null) {
                messenger?.send(MSG_TURN, buildJsonObject { put("playerId", next) })
            }
        }
    }

    // Fold in peers' envelopes.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_START -> {
                    val cat = msg.data["category"]?.jsonPrimitive?.content ?: return@collect
                    category = cat
                    chain.clear()
                    input = ""
                    // The starter follows up with a chain_turn; leave turn as-is until then.
                }
                MSG_ADD -> {
                    val word = msg.data["word"]?.jsonPrimitive?.content ?: return@collect
                    val by = msg.data["by"]?.jsonPrimitive?.content
                        ?: nameById[msg.from] ?: "Someone"
                    chain.add(ChainLink(by, word))
                }
                MSG_TURN -> {
                    turnId = msg.data["playerId"]?.jsonPrimitive?.content
                }
                MSG_FULL -> {
                    // Only adopt a snapshot before we've started our own chain locally.
                    if (category == null && chain.isEmpty()) {
                        category = msg.data["category"]?.jsonPrimitive?.content
                        turnId = msg.data["turn"]?.jsonPrimitive?.content
                        val arr = msg.data["words"]?.jsonArray ?: return@collect
                        arr.forEach { el ->
                            val o = runCatching { el.jsonObject }.getOrNull() ?: return@forEach
                            val by = o["by"]?.jsonPrimitive?.content ?: "Someone"
                            val w = o["word"]?.jsonPrimitive?.content ?: return@forEach
                            chain.add(ChainLink(by, w))
                        }
                    }
                }
            }
        }
    }

    // Push the whole chain to anyone who just joined so they land in sync.
    LaunchedEffect(messenger) {
        messenger?.memberJoined?.collect {
            if (category == null) return@collect
            messenger.send(
                MSG_FULL,
                buildJsonObject {
                    put("category", category ?: "")
                    put("turn", turnId ?: "")
                    put("words", buildJsonArray {
                        chain.forEach { link ->
                            add(buildJsonObject {
                                put("by", link.by)
                                put("word", link.word)
                            })
                        }
                    })
                },
            )
        }
    }

    val need = requiredLetter(chain)
    val status = when {
        messenger == null ->
            "Not connected to a Beebo Hub — connect one in Settings to play with the car. " +
                "You can still build a chain here."
        !connected -> "Connecting to the room…"
        else -> "In the room — ${members.size} " + if (members.size == 1) "player" else "players"
    }
    val turnLabel = when {
        solo -> "Your turn"
        myTurn -> "Your turn!"
        turnId == null -> "Waiting to start…"
        else -> "${nameById[turnId] ?: "Someone"}'s turn"
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Category Chains", style = MaterialTheme.typography.titleLarge)
        Text(
            status,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (category == null) {
            Text(
                "Pick a category, then take turns naming something in it. Each word must start " +
                    "with the last letter of the word before it.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // Category chips (wrap manually into rows of three).
            CATEGORIES.chunked(3).forEach { rowCats ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    rowCats.forEach { cat ->
                        FilterChip(
                            selected = cat == selectedCategory,
                            onClick = { selectedCategory = cat },
                            label = { Text(cat) },
                        )
                    }
                }
            }
            Button(onClick = {
                // The starter takes the first turn.
                startChain(selectedCategory, broadcast = true, firstTurn = you)
            }) {
                Text("Start the chain")
            }
        } else {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "Category: ${category}",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        turnLabel,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Bold,
                        color = if (myTurn) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        if (need == null) "Any word starts the chain."
                        else "Next word must start with \"$need\".",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // Input — only enabled on your turn.
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                singleLine = true,
                enabled = myTurn,
                label = {
                    Text(
                        if (myTurn) "Your answer" + (need?.let { " (starts with $it)" } ?: "")
                        else "Wait for your turn"
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(
                    enabled = myTurn && input.trim().isNotEmpty() &&
                        (need == null || input.trim().firstOrNull()?.uppercaseChar() == need),
                    onClick = { submitWord() },
                ) { Text("Add to chain") }
                OutlinedButton(onClick = {
                    startChain(selectedCategory, broadcast = true, firstTurn = you)
                }) { Text("New chain") }
            }

            // The running chain, newest last.
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("The chain (${chain.size})", style = MaterialTheme.typography.titleMedium)
                    if (chain.isEmpty()) {
                        Text(
                            "No words yet — the first player kicks it off.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        chain.forEachIndexed { i, link ->
                            val mine = link.by == myName
                            Text(
                                "${i + 1}. ${link.word}  —  ${if (mine) "you" else link.by}",
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
