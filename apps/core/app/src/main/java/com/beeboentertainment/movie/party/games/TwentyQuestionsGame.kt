package com.beeboentertainment.movie.party.games

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.random.Random

/*
 * "20 Questions" — one phone privately holds a secret; everyone else asks yes/no questions
 * out loud and the holder taps the answer. The app counts the questions (max 20) and drips
 * out the secret's built-in hints as the count climbs. Built on the same hub room plumbing
 * (RoomMessenger -> RoomClient -> the /room socket a watch party uses).
 *
 * Wire protocol (RoomClient.sendApp {type, ...}; the hub stamps `from`, never echoes ours):
 *
 *   tq_start   { round, pack }                 holder starts; everyone resets to a blank round
 *   tq_answer  { round, n, answer }            holder taps yes/no/maybe; count advances to n
 *   tq_hint    { round, index, text }          holder's board auto-reveals the next hint
 *   tq_reveal  { round, secret }               holder reveals the answer to the whole car
 *   tq_full    { round, pack, n, answer,       snapshot to a phone that just joined; the
 *                hints, revealed, secret }        secret is included only once revealed
 *
 * The secret and the authoritative count live on the holder's phone; askers only ever mirror
 * what the holder broadcasts, so the answer stays hidden until the reveal.
 */

private const val MSG_START = "tq_start"
private const val MSG_ANSWER = "tq_answer"
private const val MSG_HINT = "tq_hint"
private const val MSG_REVEAL = "tq_reveal"
private const val MSG_FULL = "tq_full"

private const val MAX_QUESTIONS = 20

/** A hidden answer plus progressive hints revealed as the question count climbs. */
data class Secret(val name: String, val hints: List<String>)

/** A themed set of secrets the holder draws from. */
data class QuestionPack(val id: String, val title: String, val noun: String, val secrets: List<Secret>)

private val json = Json { ignoreUnknownKeys = true }

/**
 * Storybook characters, drawn only from books old enough to be public domain.
 *
 * This pack used to be film characters - Elsa, Batman, Buzz Lightyear, Harry Potter and
 * so on. Those are other people's property, and shipping them as game content inside a
 * paid app is not something to argue about after the fact, so they're gone.
 *
 * Every character below comes from a public-domain book, and every hint is written from
 * that book rather than from any film adaptation of it. Keep it that way if you add more:
 * the test is "would this hint still make sense to someone who has only read the book?"
 *
 * The pack id stays "movies" on purpose. It travels over the wire in tq_start / tq_full,
 * and an older phone in the room resolves an unknown id by falling back to this pack -
 * renaming it would only break mixed-version rooms for no gain.
 */
private val MOVIE_PACK = QuestionPack(
    id = "movies",
    title = "Classic book characters",
    noun = "a classic book character",
    secrets = listOf(
        Secret("Sherlock Holmes", listOf("They solve mysteries.", "They live on Baker Street.", "Their closest friend is a doctor named Watson.")),
        Secret("Robin Hood", listOf("They live in a forest.", "They're famous with a bow and arrow.", "They take from the rich and give to the poor.")),
        Secret("The Scarecrow", listOf("They're stuffed with straw.", "They travel a road made of yellow brick.", "What they want most is a brain.")),
        Secret("Pinocchio", listOf("They're carved out of wood.", "Their nose grows when they tell a lie.", "They want to become a real boy.")),
        Secret("Alice", listOf("She follows a rabbit in a waistcoat.", "She falls down a very deep hole.", "She has tea with a Hatter and a hare.")),
        Secret("Peter Pan", listOf("They can fly.", "They never grow up.", "Their shadow once ran away from them.")),
        Secret("Captain Nemo", listOf("They command a submarine.", "The submarine is called the Nautilus.", "They refuse to set foot on land again.")),
        Secret("Tom Sawyer", listOf("They live beside the Mississippi River.", "They trick their friends into whitewashing a fence.", "Their best friend is called Huckleberry Finn.")),
        Secret("Long John Silver", listOf("They're a pirate.", "They have one leg and lean on a crutch.", "A parrot rides on their shoulder.")),
        Secret("Gulliver", listOf("They wash up on a strange shore.", "They wake up tied down by tiny people.", "The tiny country is called Lilliput.")),
    ),
)

private val ANIMAL_PACK = QuestionPack(
    id = "animals",
    title = "Animals",
    noun = "an animal",
    secrets = listOf(
        Secret("Elephant", listOf("It's very big.", "It has a long trunk.", "It has big floppy ears.")),
        Secret("Penguin", listOf("It's a bird that can't fly.", "It lives where it's cold.", "It waddles and swims.")),
        Secret("Kangaroo", listOf("It hops.", "It carries babies in a pouch.", "It lives in Australia.")),
        Secret("Octopus", listOf("It lives in the ocean.", "It has eight arms.", "It can squirt ink.")),
        Secret("Giraffe", listOf("It's very tall.", "It has a very long neck.", "It has spots.")),
        Secret("Owl", listOf("It's a bird.", "It's awake at night.", "It says 'hoo'.")),
        Secret("Frog", listOf("It starts life as a tadpole.", "It hops.", "It says 'ribbit'.")),
        Secret("Tiger", listOf("It's a big cat.", "It has orange fur.", "It has black stripes.")),
        Secret("Dolphin", listOf("It lives in the sea.", "It's very smart.", "It leaps out of the water.")),
        Secret("Bat", listOf("It can fly.", "It sleeps upside down.", "It comes out at night.")),
    ),
)

private val PACKS = listOf(MOVIE_PACK, ANIMAL_PACK)
private fun packById(id: String): QuestionPack = PACKS.firstOrNull { it.id == id } ?: MOVIE_PACK

/**
 * Route-level entry point: builds a [RoomMessenger] for the signed-in hub account and hands it
 * to the game. Falls back to local-only play (you can hold a secret and count on one phone,
 * nothing syncs) when off the hub, so the screen is never a dead end. Mirrors [ThisOrThatScreen].
 */
@Composable
fun TwentyQuestionsScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val deviceName = remember {
        session.userName?.takeIf { it.isNotBlank() } ?: "Player"
    }
    val messenger = rememberRoomMessenger(session, deviceName)
    TwentyQuestionsGame(messenger = messenger, modifier = modifier)
}

@Composable
fun TwentyQuestionsGame(messenger: RoomMessenger?, modifier: Modifier = Modifier) {
    val connected = messenger?.connected?.collectAsState()?.value ?: false
    val members = messenger?.members?.collectAsState()?.value ?: emptyList()

    // Shared round state, mirrored on every phone.
    var round by remember { mutableStateOf<String?>(null) }
    var packId by remember { mutableStateOf(MOVIE_PACK.id) }
    var count by remember { mutableStateOf(0) }
    var lastAnswer by remember { mutableStateOf<String?>(null) }
    val hints = remember { mutableStateListOf<String>() }
    var revealed by remember { mutableStateOf<String?>(null) }

    // Holder-only local state — the secret never leaves this phone until the reveal.
    var isHolder by remember { mutableStateOf(false) }
    var secret by remember { mutableStateOf<Secret?>(null) }

    var chosenPack by remember { mutableStateOf(MOVIE_PACK.id) }

    fun resetRoundLocal() {
        count = 0
        lastAnswer = null
        hints.clear()
        revealed = null
    }

    fun startAsHolder() {
        val pack = packById(chosenPack)
        val s = pack.secrets[Random.nextInt(pack.secrets.size)]
        val id = "q" + System.currentTimeMillis() + "-" + Random.nextInt(1000)
        isHolder = true
        secret = s
        round = id
        packId = pack.id
        resetRoundLocal()
        messenger?.send(MSG_START, buildJsonObject {
            put("round", id)
            put("pack", pack.id)
        })
    }

    fun answer(ans: String) {
        val id = round ?: return
        val s = secret ?: return
        if (revealed != null) return
        val n = (count + 1).coerceAtMost(MAX_QUESTIONS)
        count = n
        lastAnswer = ans
        messenger?.send(MSG_ANSWER, buildJsonObject {
            put("round", id)
            put("n", n)
            put("answer", ans)
        })
        // Drip out the next hint every 5 questions (at 5, 10, 15) while any remain.
        if (n >= (hints.size + 1) * 5 && hints.size < s.hints.size) {
            val idx = hints.size
            val text = s.hints[idx]
            hints.add(text)
            messenger?.send(MSG_HINT, buildJsonObject {
                put("round", id)
                put("index", idx)
                put("text", text)
            })
        }
    }

    fun reveal() {
        val id = round ?: return
        val s = secret ?: return
        revealed = s.name
        messenger?.send(MSG_REVEAL, buildJsonObject {
            put("round", id)
            put("secret", s.name)
        })
    }

    // Fold in the holder's broadcasts (askers) and never overwrite our own holder state.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_START -> {
                    val id = msg.data["round"]?.jsonPrimitive?.content ?: return@collect
                    round = id
                    packId = msg.data["pack"]?.jsonPrimitive?.content ?: MOVIE_PACK.id
                    isHolder = false
                    secret = null
                    resetRoundLocal()
                }
                MSG_ANSWER -> {
                    if (isHolder) return@collect
                    if (msg.data["round"]?.jsonPrimitive?.content != round) return@collect
                    count = msg.data["n"]?.jsonPrimitive?.intOrNull ?: count
                    lastAnswer = msg.data["answer"]?.jsonPrimitive?.content
                }
                MSG_HINT -> {
                    if (isHolder) return@collect
                    if (msg.data["round"]?.jsonPrimitive?.content != round) return@collect
                    val idx = msg.data["index"]?.jsonPrimitive?.intOrNull ?: hints.size
                    val text = msg.data["text"]?.jsonPrimitive?.content ?: return@collect
                    if (idx == hints.size) hints.add(text) // in-order, deduped by index
                }
                MSG_REVEAL -> {
                    if (msg.data["round"]?.jsonPrimitive?.content != round) return@collect
                    revealed = msg.data["secret"]?.jsonPrimitive?.content
                }
                MSG_FULL -> {
                    if (isHolder) return@collect
                    val id = msg.data["round"]?.jsonPrimitive?.content ?: return@collect
                    round = id
                    packId = msg.data["pack"]?.jsonPrimitive?.content ?: MOVIE_PACK.id
                    count = msg.data["n"]?.jsonPrimitive?.intOrNull ?: 0
                    lastAnswer = msg.data["answer"]?.jsonPrimitive?.content
                    hints.clear()
                    (msg.data["hints"] as? JsonArray)?.forEach { el ->
                        hints.add(el.jsonPrimitive.content)
                    }
                    revealed = if (msg.data["revealed"]?.jsonPrimitive?.booleanOrNull == true)
                        msg.data["secret"]?.jsonPrimitive?.content else null
                }
            }
        }
    }

    // When someone new joins, the holder pushes the whole round so they catch up mid-game.
    LaunchedEffect(messenger) {
        messenger?.memberJoined?.collect {
            if (!isHolder) return@collect
            val id = round ?: return@collect
            messenger.send(MSG_FULL, buildJsonObject {
                put("round", id)
                put("pack", packId)
                put("n", count)
                lastAnswer?.let { put("answer", it) }
                put("hints", JsonArray(hints.map { JsonPrimitive(it) }))
                put("revealed", revealed != null)
                revealed?.let { put("secret", it) }
            })
        }
    }

    val pack = packById(packId)
    val status = when {
        messenger == null ->
            "Not connected to a Beebo Hub — connect one in Settings to play with the car. " +
                "You can still run a round here."
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
        Text("20 Questions", style = MaterialTheme.typography.titleLarge)
        Text(
            status,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (round == null) {
            // Lobby — pick a pack and become the holder, or wait for someone else to.
            Text(
                "One person secretly thinks of something; everyone else asks yes/no questions " +
                    "out loud. Tap below to be the one who holds the secret.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PACKS.forEach { p ->
                    FilterChip(
                        selected = p.id == chosenPack,
                        onClick = { chosenPack = p.id },
                        label = { Text(p.title) },
                    )
                }
            }
            Button(onClick = { startAsHolder() }) {
                Text("I'll hold a secret")
            }
            Card(Modifier.fillMaxWidth()) {
                Text(
                    "Waiting for someone to think of a secret…",
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(16.dp),
                )
            }
        } else {
            // Prompt box — the secret for the holder, the challenge for everyone else.
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (isHolder && secret != null) {
                        Text("You're thinking of:", style = MaterialTheme.typography.labelMedium)
                        Text(
                            secret!!.name,
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            "Keep it secret! Tap the answer to each question the others ask.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        Text(
                            "Someone is thinking of ${pack.noun}.",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            "Ask yes/no questions out loud — the holder taps each answer here.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            // Question counter.
            val remaining = MAX_QUESTIONS - count
            Text(
                "Question $count of $MAX_QUESTIONS" +
                    if (remaining in 1..3) "  ·  $remaining left!" else "",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            LinearProgressIndicator(
                progress = { count.toFloat() / MAX_QUESTIONS },
                modifier = Modifier.fillMaxWidth(),
            )

            // Latest answer.
            lastAnswer?.let { ans ->
                Text(
                    "Last answer: " + ans.uppercase(),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                )
            }

            // Hints revealed so far.
            if (hints.isNotEmpty()) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Hints", style = MaterialTheme.typography.titleMedium)
                        hints.forEachIndexed { i, h ->
                            Text("${i + 1}. $h", style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }

            // Reveal card.
            revealed?.let { answerName ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("The answer was:", style = MaterialTheme.typography.labelMedium)
                        Text(
                            answerName,
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }

            // Controls.
            if (isHolder && revealed == null) {
                Text("Tap the holder's answer:", style = MaterialTheme.typography.labelLarge)
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Button(onClick = { answer("yes") }, modifier = Modifier.weight(1f)) { Text("Yes") }
                    Button(onClick = { answer("no") }, modifier = Modifier.weight(1f)) { Text("No") }
                    OutlinedButton(onClick = { answer("maybe") }, modifier = Modifier.weight(1f)) { Text("Maybe") }
                }
                if (count >= MAX_QUESTIONS) {
                    Text(
                        "That's 20 questions! Time for a final guess.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                OutlinedButton(onClick = { reveal() }) { Text("Reveal the answer") }
            }

            // Anyone can start the next round by holding a new secret.
            if (revealed != null || !isHolder) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    PACKS.forEach { p ->
                        FilterChip(
                            selected = p.id == chosenPack,
                            onClick = { chosenPack = p.id },
                            label = { Text(p.title) },
                        )
                    }
                }
                Button(onClick = { startAsHolder() }) {
                    Text(if (revealed != null) "New round — I'll hold" else "Take over — I'll hold a secret")
                }
            }
        }
    }
}
