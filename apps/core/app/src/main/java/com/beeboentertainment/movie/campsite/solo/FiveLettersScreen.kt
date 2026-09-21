package com.beeboentertainment.movie.campsite.solo

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Calendar

/** Tile colours chosen to read on both the dark and the light app theme, with white letters. */
private val GREEN = Color(0xFF3C8A3F)
private val YELLOW = Color(0xFFB8901C)
private val GREY = Color(0xFF5F6673)

private const val KEY_DAILY = "solo_fiveletters_daily_v1"
private const val KEY_PRACTICE = "solo_fiveletters_practice_v1"
private const val KEY_STATS = "solo_fiveletters_stats_v1"

private class WordBank(val answers: List<String>, val allowed: Set<String>)

private fun loadWords(context: Context): WordBank {
    fun read(name: String) = runCatching {
        context.assets.open("fiveletters/$name").bufferedReader().use { it.readText() }
    }.getOrDefault("")
    val answers = FiveLetters.parseList(read("answers.txt"))
    val allowed = (answers + FiveLetters.parseList(read("guesses.txt"))).toHashSet()
    return WordBank(answers, allowed)
}

private fun todayPuzzle(): Int {
    val c = Calendar.getInstance()
    return FiveLetters.puzzleNumber(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
}

@Composable
internal fun FiveLettersScreen() {
    val context = LocalContext.current
    val bank = remember { loadWords(context) }
    if (bank.answers.isEmpty()) {
        Text("The word list could not be loaded.", Modifier.padding(16.dp))
        return
    }
    val today = remember { todayPuzzle() }
    var stats by remember { mutableStateOf(SoloStore.load(KEY_STATS, FiveLettersStats.serializer()) ?: FiveLettersStats()) }

    fun freshDaily() = FiveLettersState(daily = true, puzzle = today, answer = FiveLetters.dailyAnswer(bank.answers, today))
    fun freshPractice() = FiveLettersState(daily = false, puzzle = 0, answer = bank.answers.random())

    var daily by remember {
        mutableStateOf(SoloStore.load(KEY_DAILY, FiveLettersState.serializer())?.takeIf { it.puzzle == today } ?: freshDaily())
    }
    var practice by remember {
        mutableStateOf(SoloStore.load(KEY_PRACTICE, FiveLettersState.serializer())?.takeIf { it.answer in bank.allowed } ?: freshPractice())
    }
    var dailyMode by remember { mutableStateOf(true) }
    var typed by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }

    val game = if (dailyMode) daily else practice

    fun store(next: FiveLettersState) {
        var g = next
        if (g.over && !g.counted) {
            stats = stats.record(g)
            SoloStore.save(KEY_STATS, FiveLettersStats.serializer(), stats)
            g = g.copy(counted = true)
        }
        if (g.daily) {
            daily = g; SoloStore.save(KEY_DAILY, FiveLettersState.serializer(), g)
        } else {
            practice = g; SoloStore.save(KEY_PRACTICE, FiveLettersState.serializer(), g)
        }
    }

    fun type(c: Char) {
        if (game.over) return
        message = ""
        if (typed.length < FiveLetters.LENGTH) typed += c.lowercaseChar()
    }
    fun backspace() { if (!game.over) typed = typed.dropLast(1); message = "" }
    fun enter() {
        if (game.over) return
        when {
            typed.length < FiveLetters.LENGTH -> message = "Not enough letters"
            typed !in bank.allowed -> message = "Not in the word list"
            else -> {
                store(game.copy(guesses = game.guesses + typed))
                typed = ""
            }
        }
    }

    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Column(
        Modifier
            .fillMaxSize()
            .focusRequester(focus)
            .focusable()
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                when (e.key) {
                    Key.Enter, Key.NumPadEnter -> { enter(); true }
                    Key.Backspace, Key.Delete -> { backspace(); true }
                    else -> {
                        val ch = e.utf16CodePoint.toChar()
                        if (ch.lowercaseChar() in 'a'..'z') { type(ch); true } else false
                    }
                }
            }
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val dist = stats.distribution
        SoloHeaderButtons(
            FIVE_LETTERS_GAME,
            listOf(
                "Daily played" to stats.played.toString(),
                "Daily won" to if (stats.played == 0) "0%" else "${stats.wins * 100 / stats.played}%",
                "Current streak" to stats.currentStreak(today).toString(),
                "Best streak" to stats.bestStreak.toString(),
            ) + dist.mapIndexed { i, n -> "Solved in ${i + 1}" to n.toString() } +
                listOf("Practice won" to "${stats.practiceWins} of ${stats.practicePlayed}"),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = dailyMode, onClick = { dailyMode = true; typed = ""; message = "" },
                label = { Text("Daily #$today") }, modifier = Modifier.heightIn(min = 48.dp))
            FilterChip(selected = !dailyMode, onClick = { dailyMode = false; typed = ""; message = "" },
                label = { Text("Practice") }, modifier = Modifier.heightIn(min = 48.dp))
        }

        // The board
        Column(Modifier.widthIn(max = 340.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (row in 0 until FiveLetters.TRIES) {
                val guess = game.guesses.getOrNull(row)
                val marks = guess?.let { FiveLetters.score(it, game.answer) }
                val letters = guess ?: if (row == game.guesses.size && !game.over) typed else ""
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (col in 0 until FiveLetters.LENGTH) {
                        val ch = letters.getOrNull(col)
                        val mark = marks?.get(col)
                        val bg = when (mark) {
                            LetterMark.CORRECT -> GREEN
                            LetterMark.PRESENT -> YELLOW
                            LetterMark.ABSENT -> GREY
                            null -> Color.Transparent
                        }
                        val label = when (mark) {
                            LetterMark.CORRECT -> "right place"
                            LetterMark.PRESENT -> "wrong place"
                            LetterMark.ABSENT -> "not in word"
                            null -> ""
                        }
                        Box(
                            Modifier
                                .weight(1f)
                                .aspectRatio(1f)
                                .shadow(2.dp, RoundedCornerShape(8.dp))
                                .clip(RoundedCornerShape(8.dp))
                                .background(Brush.linearGradient(listOf(
                                    if (mark == null) MaterialTheme.colorScheme.surface else androidx.compose.ui.graphics.lerp(bg, Color.White, 0.12f),
                                    if (mark == null) MaterialTheme.colorScheme.surfaceVariant else bg,
                                )))
                                .then(
                                    if (mark == null) Modifier.border(2.dp,
                                        if (ch != null) MaterialTheme.colorScheme.onSurfaceVariant
                                        else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp))
                                    else Modifier
                                )
                                .semantics { contentDescription = if (ch == null) "empty" else "${ch.uppercaseChar()} $label" },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                ch?.uppercaseChar()?.toString().orEmpty(),
                                fontSize = 26.sp,
                                fontWeight = FontWeight.Bold,
                                color = if (mark != null) Color.White else MaterialTheme.colorScheme.onSurface,
                            )
                        }
                    }
                }
            }
        }

        Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.heightIn(min = 20.dp))

        if (game.over) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        if (game.won) "Got it in ${game.guesses.size}!" else "The word was ${game.answer.uppercase()}",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    if (game.daily) {
                        Text("Streak: ${stats.currentStreak(today)}  ·  a new daily word tomorrow",
                            color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = {
                            val rows = game.guesses.map { FiveLetters.score(it, game.answer) }
                            val title = if (game.daily) "Beebo Five Letters #${game.puzzle}" else "Beebo Five Letters practice"
                            val text = FiveLetters.shareText(title, rows, game.won)
                            runCatching {
                                context.startActivity(
                                    Intent.createChooser(
                                        Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text),
                                        "Share result",
                                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                )
                            }
                        }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Share") }
                        Button(onClick = {
                            dailyMode = false
                            typed = ""
                            store(freshPractice())
                        }, modifier = Modifier.heightIn(min = 48.dp)) { Text("New practice word") }
                    }
                }
            }
        }

        Keyboard(
            states = FiveLetters.keyStates(game.guesses, game.answer),
            onLetter = ::type,
            onEnter = ::enter,
            onBack = ::backspace,
        )
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun Keyboard(states: Map<Char, LetterMark>, onLetter: (Char) -> Unit, onEnter: () -> Unit, onBack: () -> Unit) {
    val rows = listOf("qwertyuiop", "asdfghjkl", "zxcvbnm")
    Column(Modifier.widthIn(max = 520.dp).fillMaxWidth(),verticalArrangement = Arrangement.spacedBy(6.dp)) {
        rows.forEachIndexed { index, letters ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (index == 1) Spacer(Modifier.weight(0.5f))
                if (index == 2) KeyCap("Enter", 1.5f, null, "Enter", onEnter)
                letters.forEach { c ->
                    KeyCap(c.uppercase(), 1f, states[c], c.uppercase()) { onLetter(c) }
                }
                if (index == 2) KeyCap("⌫", 1.5f, null, "Delete letter", onBack)
                if (index == 1) Spacer(Modifier.weight(0.5f))
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.KeyCap(
    label: String, weight: Float, state: LetterMark?, description: String, onClick: () -> Unit,
) {
    val bg = when (state) {
        LetterMark.CORRECT -> GREEN
        LetterMark.PRESENT -> YELLOW
        LetterMark.ABSENT -> GREY.copy(alpha = 0.55f)
        null -> MaterialTheme.colorScheme.surfaceVariant
    }
    val fg = if (state == null) MaterialTheme.colorScheme.onSurface else Color.White
    Box(
        Modifier
            .weight(weight)
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(bg)
            .clickable(onClickLabel = description) { onClick() }
            .semantics { contentDescription = description + when (state) {
                LetterMark.CORRECT -> ", right place"
                LetterMark.PRESENT -> ", in the word"
                LetterMark.ABSENT -> ", not in the word"
                null -> ""
            } },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = fg, fontWeight = FontWeight.SemiBold, fontSize = if (label.length > 1) 13.sp else 17.sp)
    }
}
