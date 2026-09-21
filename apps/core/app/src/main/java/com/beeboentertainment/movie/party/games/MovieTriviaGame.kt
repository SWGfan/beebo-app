package com.beeboentertainment.movie.party.games

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.data.CatalogCache
import com.beeboentertainment.movie.data.Movie
import com.beeboentertainment.movie.party.RoomMessenger
import com.beeboentertainment.movie.party.rememberRoomMessenger
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.random.Random

/*
 * Movie Trivia — the flagship synced game, built from the family's OWN library.
 *
 * The host phone loads its library once (the same api.movies() call the Movies tab uses, via
 * CatalogCache), generates a best-of-N pack with [MovieTriviaGenerator], then drives the round over
 * the existing hub room (RoomMessenger -> the same /room socket a watch party uses). Only the host
 * needs the library — every other phone just receives the current question on the wire.
 *
 * Wire protocol (all ride RoomClient.sendApp as {type, ...}, relayed by the hub which stamps `from`
 * and never echoes our own):
 *
 *   trivia_q      { qId, index, total, prompt, options:[{id,label}] }  host shows a question
 *   trivia_answer { qId, playerId, choice }                           a phone taps its choice
 *   trivia_reveal { qId, correct }                                    host reveals; all score at once
 *
 * Each phone tallies scores from the answers it hears plus its own pick (never echoed), so the
 * running leaderboard is correct everywhere without a server tally — the same approach as This or
 * That, extended to a cumulative per-player score across the round.
 */

private const val MSG_Q = "trivia_q"
private const val MSG_ANSWER = "trivia_answer"
private const val MSG_REVEAL = "trivia_reveal"
private const val MSG_SYNC = "trivia_sync"

/** Questions in a best-of-N round. */
private const val ROUND_SIZE = 5

/** How many titles the host samples for cast (each is one /api/credits call) to unlock cast questions. */
private const val CAST_SAMPLE = 10

@Composable
fun MovieTriviaScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val deviceName = remember { session.userName?.takeIf { it.isNotBlank() } ?: "Player" }
    val messenger = rememberRoomMessenger(session, deviceName)
    MovieTriviaGame(messenger = messenger, modifier = modifier)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MovieTriviaGame(messenger: RoomMessenger?, modifier: Modifier = Modifier) {
    val app = remember { BeeboApp.instance }
    val scope = rememberCoroutineScope()

    val you = messenger?.you?.collectAsState()?.value ?: ""
    val connected = messenger?.connected?.collectAsState()?.value ?: false
    val members = messenger?.members?.collectAsState()?.value ?: emptyList()

    var isHost by remember { mutableStateOf(false) }

    // ---- current-question state (reset on every trivia_q) ----------------------
    var qId by remember { mutableStateOf<String?>(null) }
    var index by remember { mutableStateOf(0) }
    var total by remember { mutableStateOf(0) }
    var prompt by remember { mutableStateOf("") }
    val options = remember { mutableStateListOf<GameOption>() }
    var myChoice by remember { mutableStateOf<String?>(null) }
    var answerState by remember { mutableStateOf(TriviaAnswers()) }
    var questionHost by remember { mutableStateOf("") }
    val currentYou by rememberUpdatedState(you)
    val revealed = answerState.revealed
    val correctId = answerState.correctId
    val answers = answerState.choices

    // ---- cumulative round state ------------------------------------------------
    val scores = remember { mutableStateMapOf<String, Int>() } // playerId -> correct count
    val scoredQ = remember { mutableStateListOf<String>() }    // qIds already folded into scores

    // ---- host-only pack + load state ------------------------------------------
    val pack = remember { mutableStateListOf<TriviaQuestion>() }
    var hostIndex by remember { mutableStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var loadNote by remember { mutableStateOf<String?>(null) }

    fun foldScores() {
        val id = qId ?: return
        val correct = answerState.correctId ?: return
        if (scoredQ.contains(id)) return
        scoredQ.add(id)
        answerState.choices.forEach { (pid, choice) -> scores[pid] = (scores[pid] ?: 0) + if (choice == correct) 1 else 0 }
    }

    fun showQuestion(
        newId: String,
        newIndex: Int,
        newTotal: Int,
        newPrompt: String,
        newOptions: List<GameOption>,
    ) {
        if (newId == qId) return // Catch-up broadcasts must not erase answers or a revealed result.
        if (newIndex == 0) {
            // A fresh round: wipe the running tally and count this play locally (per-device, like
            // ThisOrThatStats) so the Trip Recap / badges can see trivia was played.
            scores.clear()
            scoredQ.clear()
            MovieTriviaStats.recordRound(app.session.plain)
        }
        qId = newId
        index = newIndex
        total = newTotal
        prompt = newPrompt
        options.clear(); options.addAll(newOptions)
        myChoice = null
        answerState = answerState.start(newId, newOptions.map { it.id }.toSet())
    }

    fun sendSnapshot(target: String) {
        val id = qId ?: return
        messenger?.send(MSG_Q, buildJsonObject {
            questionEnvelope(id, index, total, prompt, options).forEach { (key, value) -> put(key, value) }
            put("target", target)
            put("answers", JsonObject(answerState.choices.mapValues { JsonPrimitive(it.value) }))
            put("scores", JsonObject(scores.mapValues { JsonPrimitive(it.value) }))
            answerState.correctId?.let { put("correct", it) }
        })
    }

    // Listen for peers' envelopes.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_SYNC -> if (isHost && msg.from.isNotBlank()) sendSnapshot(msg.from)
                MSG_Q -> {
                    val target = msg.data["target"]?.jsonPrimitive?.content
                    if (target != null && target != currentYou) return@collect
                    if (isHost) return@collect
                    val id = msg.data["qId"]?.jsonPrimitive?.content ?: return@collect
                    val opts = (msg.data["options"] as? JsonArray).orEmptyOptions()
                    if (opts.isEmpty()) return@collect
                    if (id == qId && questionHost.isNotBlank() && questionHost != msg.from) return@collect
                    questionHost = msg.from
                    showQuestion(
                        newId = id,
                        newIndex = msg.data["index"]?.jsonPrimitive?.intOrNull ?: 0,
                        newTotal = msg.data["total"]?.jsonPrimitive?.intOrNull ?: opts.size,
                        newPrompt = msg.data["prompt"]?.jsonPrimitive?.content ?: "",
                        newOptions = opts,
                    )
                    answerState = answerState.syncChoices(msg.data.stringMap("answers").orEmpty())
                    val correct = msg.data["correct"]?.jsonPrimitive?.content
                    if (correct != null) answerState = answerState.reveal(id, correct)
                    msg.data.scoreMap()?.let { snapshot -> scores.clear(); scores.putAll(snapshot) }
                    if (answerState.revealed && id !in scoredQ) scoredQ.add(id)
                    myChoice = answerState.choices[currentYou]
                }
                MSG_ANSWER -> {
                    val id = msg.data["qId"]?.jsonPrimitive?.content
                    val choice = msg.data["choice"]?.jsonPrimitive?.content
                    if (choice != null) answerState = answerState.answer(id, msg.from, choice)
                }
                MSG_REVEAL -> {
                    val id = msg.data["qId"]?.jsonPrimitive?.content
                    if (id == qId && msg.from == questionHost && !answerState.revealed) {
                        answerState = answerState.reveal(id, msg.data["correct"]?.jsonPrimitive?.content,
                            msg.data.stringMap("answers"))
                        if (answerState.revealed) {
                            val snapshot = msg.data.scoreMap()
                            if (snapshot == null) foldScores() else {
                                scores.clear(); scores.putAll(snapshot)
                                if (id != null && id !in scoredQ) scoredQ.add(id)
                            }
                        }
                    }
                }
            }
        }
    }

    // When someone new joins mid-round, the host re-pushes the current question so they catch up.
    LaunchedEffect(messenger) {
        messenger?.memberJoined?.collect { member ->
            if (isHost) sendSnapshot(member.id)
        }
    }

    LaunchedEffect(messenger, connected, you) {
        if (connected && you.isNotBlank() && !isHost) messenger?.send(MSG_SYNC, buildJsonObject {})
    }

    fun pick(choice: String) {
        if (qId == null || answerState.revealed || (messenger != null && (!connected || you.isBlank()))) return
        myChoice = choice
        val me = you.ifBlank { "me" }
        answerState = answerState.answer(qId, me, choice) // the hub never echoes our own message
        messenger?.send(
            MSG_ANSWER,
            buildJsonObject {
                put("qId", qId!!)
                put("playerId", me)
                put("choice", choice)
            },
        )
    }

    // ---- host controls ---------------------------------------------------------
    fun broadcastHostQuestion() {
        val q = pack.getOrNull(hostIndex) ?: return
        val id = "q" + System.currentTimeMillis() + "-" + hostIndex
        showQuestion(id, hostIndex, pack.size, q.prompt, q.options)
        questionHost = you.ifBlank { "me" } // The correct option stays private in the host pack.
        messenger?.send(MSG_Q, questionEnvelope(id, hostIndex, pack.size, q.prompt, q.options))
    }

    fun startRound() {
        if (loading) return
        loading = true
        loadNote = null
        scope.launch {
            try {
                val movies = loadLibrary(app)
                val genreName = loadGenreNames(app)
                val cast = loadSampleCast(app, movies)
                val questions = MovieTriviaGenerator.generate(
                    movies = movies,
                    genreName = { genreName[it] },
                    castByMovieId = cast,
                    count = ROUND_SIZE,
                    random = Random.Default,
                )
                pack.clear()
                if (questions.isEmpty()) {
                    loadNote = if (movies.isEmpty()) {
                        "No movies found in your library yet — add some to play trivia."
                    } else {
                        "Your library needs a little more info (years, genres or cast) to build " +
                            "questions. Add a few more movies and try again."
                    }
                } else {
                    pack.addAll(questions)
                    hostIndex = 0
                    broadcastHostQuestion()
                }
            } catch (e: Exception) {
                loadNote = e.message ?: "Couldn't load your library. Check your connection and retry."
            } finally {
                loading = false
            }
        }
    }

    fun revealHost() {
        val id = qId ?: return
        if (!isHost || answerState.revealed) return
        val correct = pack.getOrNull(hostIndex)?.correctId ?: return
        answerState = answerState.reveal(id, correct)
        foldScores()
        messenger?.send(MSG_REVEAL, buildJsonObject {
            put("qId", id); put("correct", correct)
            put("answers", JsonObject(answerState.choices.mapValues { JsonPrimitive(it.value) }))
            put("scores", JsonObject(scores.mapValues { JsonPrimitive(it.value) }))
        })
    }

    fun nextQuestion() {
        if (hostIndex + 1 >= pack.size) return
        hostIndex += 1
        broadcastHostQuestion()
    }

    val expectedPlayers = if (messenger == null) listOf("me") else members.map { it.id }
    val allAnswered = answerState.allAnswered(expectedPlayers)
    LaunchedEffect(qId, isHost, allAnswered, connected) {
        if (isHost && allAnswered && (messenger == null || connected)) revealHost()
    }

    // ---- derived ---------------------------------------------------------------
    val results = options.associate { opt -> opt.id to answers.values.count { it == opt.id } }
    val totalPlayers = maxOf(expectedPlayers.size, answers.size)
    val roundComplete = qId != null && revealed && total > 0 && index == total - 1
    val hasMoreQuestions = isHost && hostIndex + 1 < pack.size

    val status = when {
        messenger == null ->
            "Not connected to a Beebo Hub — connect one in Settings to play with the car. " +
                "You can still try it here."
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
            headline = "Movie Trivia",
            status = status,
            prompt = qId?.let {
                (if (total > 0) "Q${index + 1} of $total\n" else "") + prompt
            },
            options = options,
            selectedId = myChoice,
            locked = revealed || qId == null || (messenger != null && !connected),
            revealed = revealed,
            results = results,
            totalPlayers = totalPlayers,
            totalAnswered = answers.size,
            onSelect = { pick(it) },
            correctOptionId = correctId,
            compactOptions = true,
            beforeOptions = {
                if (revealed) {
                    val correctLabel = options.firstOrNull { it.id == correctId }?.label.orEmpty()
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("Correct answer: $correctLabel", style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.Bold)
                            Text(when {
                                myChoice == null -> "You didn't answer this question."
                                myChoice == correctId -> "You got it right!"
                                else -> "Your answer: " + options.firstOrNull { it.id == myChoice }?.label.orEmpty()
                            })
                        }
                    }
                } else if (qId != null) Text("The answer appears when everyone has answered. The host can also reveal it early.")
            },
        ) {

            if (roundComplete) Leaderboard(scores, members, you)

            if (isHost) {
                if (loading) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(Modifier.padding(4.dp))
                        Text("Building questions from your library…")
                    }
                }
                loadNote?.let { note ->
                    Card {
                        Text(
                            note,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(16.dp),
                        )
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(enabled = !loading, onClick = { startRound() }) {
                        Text(if (qId == null) "Start round" else "New round")
                    }
                    OutlinedButton(
                        enabled = qId != null && !revealed,
                        onClick = { revealHost() },
                    ) { Text("Reveal") }
                    if (hasMoreQuestions) {
                        OutlinedButton(enabled = revealed, onClick = { nextQuestion() }) {
                            Text("Next")
                        }
                    }
                }
            } else if (qId == null) {
                Card {
                    Text(
                        "Waiting for the host to start a round. Tap \"Be the host\" to run trivia " +
                            "built from this phone's movie library.",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun Leaderboard(
    scores: Map<String, Int>,
    members: List<com.beeboentertainment.movie.party.RoomMember>,
    you: String,
) {
    val nameOf: (String) -> String = { id ->
        when {
            id == you || id == "me" -> "You"
            else -> members.firstOrNull { it.id == id }?.name?.takeIf { it.isNotBlank() } ?: "Player"
        }
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Final scores", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            val ranked = scores.entries.sortedByDescending { it.value }
            if (ranked.isEmpty()) {
                Text("No answers this round.", style = MaterialTheme.typography.bodyMedium)
            } else {
                ranked.forEachIndexed { i, (id, score) ->
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text("${i + 1}. ${nameOf(id)}", fontWeight = if (i == 0) FontWeight.Bold else FontWeight.Normal)
                        Text(if (score == 1) "1 pt" else "$score pts")
                    }
                }
            }
        }
    }
}

// ---- wire helpers ------------------------------------------------------------

private fun questionEnvelope(
    id: String,
    index: Int,
    total: Int,
    prompt: String,
    options: List<GameOption>,
) = buildJsonObject {
    put("qId", id)
    put("index", index)
    put("total", total)
    put("prompt", prompt)
    put(
        "options",
        JsonArray(options.map { opt -> buildJsonObject { put("id", opt.id); put("label", opt.label) } }),
    )
}

private fun JsonArray?.orEmptyOptions(): List<GameOption> {
    if (this == null) return emptyList()
    return mapNotNull { el ->
        val obj = (el as? kotlinx.serialization.json.JsonObject) ?: return@mapNotNull null
        val id = obj["id"]?.jsonPrimitive?.content ?: return@mapNotNull null
        val label = obj["label"]?.jsonPrimitive?.content ?: return@mapNotNull null
        GameOption(id, label)
    }
}

// ---- host library loading (mirrors how the Movies tab reads the catalog) ------

private suspend fun loadLibrary(app: BeeboApp): List<Movie> {
    CatalogCache.movies(null)?.let { if (it.items.isNotEmpty()) return it.items }
    val resp = app.api.movies()
    if (resp.ok) CatalogCache.putMovies(null, resp)
    return resp.items
}

private fun loadGenreNames(app: BeeboApp): Map<Int, String> =
    CatalogCache.movies(null)?.genres?.associate { it.id to it.name } ?: emptyMap()

/** Best-effort per-title cast for a small random sample — failures just drop cast questions. */
private suspend fun loadSampleCast(app: BeeboApp, movies: List<Movie>): Map<String, List<String>> {
    if (movies.isEmpty()) return emptyMap()
    val out = HashMap<String, List<String>>()
    for (m in movies.shuffled().take(CAST_SAMPLE)) {
        try {
            val credits = app.api.credits("movie", m.id)
            if (credits.ok && credits.cast.isNotEmpty()) {
                out[m.id] = credits.cast.mapNotNull { it.name.takeIf { n -> n.isNotBlank() } }.take(8)
            }
        } catch (_: Exception) {
            // Offline / 401 / unlucky title — skip it; cast questions degrade gracefully.
        }
    }
    return out
}

private fun JsonObject.stringMap(key: String): Map<String, String>? =
    (this[key] as? JsonObject)?.mapNotNull { (id, value) ->
        (value as? JsonPrimitive)?.content?.let { id to it }
    }?.toMap()

private fun JsonObject.scoreMap(): Map<String, Int>? =
    (this["scores"] as? JsonObject)?.mapNotNull { (id, value) ->
        (value as? JsonPrimitive)?.intOrNull?.takeIf { it in 0..10000 }?.let { id to it }
    }?.toMap()
