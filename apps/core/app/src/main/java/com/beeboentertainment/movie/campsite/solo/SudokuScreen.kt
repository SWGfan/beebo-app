package com.beeboentertainment.movie.campsite.solo

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.random.Random

private const val KEY_SAVE = "solo_sudoku_game_v1"
private const val KEY_STATS = "solo_sudoku_stats_v1"
private const val KEY_PREFS = "solo_sudoku_prefs_v1"

@kotlinx.serialization.Serializable
private data class SudokuPrefs(val highlightSame: Boolean = true, val showConflicts: Boolean = true)

@Composable
internal fun SudokuScreen() {
    val scope = rememberCoroutineScope()
    var save by remember { mutableStateOf(SoloStore.load(KEY_SAVE, SudokuSave.serializer())?.takeIf { it.values.size == 81 }) }
    var stats by remember { mutableStateOf(SoloStore.load(KEY_STATS, SudokuStats.serializer()) ?: SudokuStats()) }
    var prefs by remember { mutableStateOf(SoloStore.load(KEY_PREFS, SudokuPrefs.serializer()) ?: SudokuPrefs()) }
    var level by remember { mutableStateOf(save?.level ?: SudokuLevel.EASY) }
    var generating by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf(40) }
    var notesMode by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf("") }
    val undo = remember { mutableStateListOf<Pair<List<Int>, List<Int>>>() }

    fun persist(next: SudokuSave?) {
        save = next
        if (next == null) SoloStore.remove(KEY_SAVE) else SoloStore.save(KEY_SAVE, SudokuSave.serializer(), next)
    }

    fun newGame(l: SudokuLevel) {
        generating = true
        hint = ""
        scope.launch {
            val g = withContext(Dispatchers.Default) { Sudoku.generate(l, Random(System.nanoTime())) }
            undo.clear()
            stats = stats.started(l)
            SoloStore.save(KEY_STATS, SudokuStats.serializer(), stats)
            persist(SudokuSave(l, g.puzzle.toList(), g.solution.toList(), g.puzzle.toList(), List(81) { 0 }))
            generating = false
        }
    }

    SaveOnPause { save?.let { SoloStore.save(KEY_SAVE, SudokuSave.serializer(), it) } }

    val game = save
    SoloTicker(running = game != null && !game.done && !generating) { step ->
        save = save?.let { it.copy(elapsedMs = it.elapsedMs + step) }
    }

    fun edit(change: (MutableList<Int>, MutableList<Int>) -> Boolean) {
        val g = save ?: return
        if (g.done) return
        val values = g.values.toMutableList()
        val notes = g.notes.toMutableList()
        if (!change(values, notes)) return
        undo.add(g.values to g.notes)
        if (undo.size > 300) undo.removeAt(0)
        hint = ""
        var next = g.copy(values = values, notes = notes)
        if (values == g.solution) {
            next = next.copy(done = true)
            stats = stats.solved(g.level, next.elapsedMs)
            SoloStore.save(KEY_STATS, SudokuStats.serializer(), stats)
        }
        persist(next)
    }

    fun input(d: Int) = edit { values, notes ->
        val i = selected
        if (save!!.puzzle[i] != 0) return@edit false
        if (notesMode && values[i] == 0) {
            notes[i] = notes[i] xor (1 shl d); true
        } else {
            values[i] = if (values[i] == d) 0 else d
            notes[i] = 0
            // Placing a number clears that pencil mark from every square it now rules out.
            if (values[i] != 0) Sudoku.PEERS[i].forEach { p -> notes[p] = notes[p] and (1 shl d).inv() }
            true
        }
    }

    fun erase() = edit { values, notes ->
        val i = selected
        if (save!!.puzzle[i] != 0 || (values[i] == 0 && notes[i] == 0)) return@edit false
        values[i] = 0; notes[i] = 0; true
    }

    fun doUndo() {
        val g = save ?: return
        if (g.done || undo.isEmpty()) return
        val (v, n) = undo.removeAt(undo.size - 1)
        persist(g.copy(values = v, notes = n))
    }

    fun doHint() {
        val g = save ?: return
        if (g.done) return
        val wrong = g.values.indices.firstOrNull { g.values[it] != 0 && g.values[it] != g.solution[it] }
        if (wrong != null) {
            selected = wrong
            hint = "Row ${Sudoku.row(wrong) + 1}, column ${Sudoku.col(wrong) + 1} is not right. Erase it and think again."
            return
        }
        val grid = g.values.toIntArray()
        val single = Sudoku.findSingle(grid)
        val (cell, digit, why) = single ?: run {
            val empties = g.values.indices.filter { g.values[it] == 0 }
            val c = if (g.values[selected] == 0) selected else empties.first()
            Triple(c, g.solution[c], "this one needs harder reasoning, so here is the answer")
        }
        selected = cell
        edit { values, notes ->
            values[cell] = digit; notes[cell] = 0
            Sudoku.PEERS[cell].forEach { p -> notes[p] = notes[p] and (1 shl digit).inv() }
            true
        }
        save = save?.let { it.copy(hints = it.hints + 1) }
        hint = "$digit goes in row ${Sudoku.row(cell) + 1}, column ${Sudoku.col(cell) + 1}: $why."
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SoloHeaderButtons(
            SUDOKU_GAME,
            SudokuLevel.values().flatMap { l ->
                val s = stats.of(l)
                listOf("${l.label}: solved" to "${s.solved} of ${s.started}",
                    "${l.label}: best time" to if (s.bestMs > 0) soloClock(s.bestMs) else "—")
            },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            SudokuLevel.values().forEach { l ->
                FilterChip(selected = level == l, onClick = { level = l }, label = { Text(l.label) },
                    modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = { newGame(level) }, enabled = !generating, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(if (game == null) "Start ${level.label}" else "New ${level.label} game")
            }
            if (game != null) {
                Text("${game.level.label}  ·  ${soloClock(game.elapsedMs)}", style = MaterialTheme.typography.titleMedium)
            }
        }

        if (generating) {
            CircularProgressIndicator()
            Text("Making a puzzle with exactly one answer…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else if (game == null) {
            Text("Pick a level and start. Your game saves itself as you go.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            SudokuBoard(
                game = game,
                selected = selected,
                prefs = prefs,
                onSelect = { selected = it },
                onDigit = { input(it) },
                onErase = { erase() },
                onToggleNotes = { notesMode = !notesMode },
            )
            if (game.done) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Solved!", style = MaterialTheme.typography.titleLarge)
                        Text("${game.level.label} in ${soloClock(game.elapsedMs)}" +
                            if (game.hints > 0) " with ${game.hints} hint${if (game.hints == 1) "" else "s"}" else "",
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (hint.isNotBlank()) Text(hint, color = MaterialTheme.colorScheme.primary)
            // Number pad
            Row(Modifier.widthIn(max = 480.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (d in 1..9) {
                    val left = 9 - game.values.count { it == d }
                    Box(
                        Modifier.weight(1f).heightIn(min = 56.dp).clip(RoundedCornerShape(8.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                            .clickable(enabled = !game.done, onClickLabel = "Enter $d") { input(d) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("$d", fontSize = 22.sp, fontWeight = FontWeight.SemiBold,
                                color = if (left <= 0) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                            Text(if (left > 0) "$left" else "", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = notesMode, onClick = { notesMode = !notesMode }, label = { Text("Notes") },
                    modifier = Modifier.heightIn(min = 48.dp))
                OutlinedButton(onClick = { erase() }, enabled = !game.done, modifier = Modifier.heightIn(min = 48.dp)) { Text("Erase") }
                OutlinedButton(onClick = { doUndo() }, enabled = !game.done && undo.isNotEmpty(), modifier = Modifier.heightIn(min = 48.dp)) { Text("Undo") }
                OutlinedButton(onClick = { doHint() }, enabled = !game.done, modifier = Modifier.heightIn(min = 48.dp)) { Text("Hint") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = prefs.highlightSame, onClick = {
                    prefs = prefs.copy(highlightSame = !prefs.highlightSame); SoloStore.save(KEY_PREFS, SudokuPrefs.serializer(), prefs)
                }, label = { Text("Highlight same numbers") }, modifier = Modifier.heightIn(min = 48.dp))
                FilterChip(selected = prefs.showConflicts, onClick = {
                    prefs = prefs.copy(showConflicts = !prefs.showConflicts); SoloStore.save(KEY_PREFS, SudokuPrefs.serializer(), prefs)
                }, label = { Text("Show clashes") }, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
    }
}

@Composable
private fun SudokuBoard(
    game: SudokuSave,
    selected: Int,
    prefs: SudokuPrefs,
    onSelect: (Int) -> Unit,
    onDigit: (Int) -> Unit,
    onErase: () -> Unit,
    onToggleNotes: () -> Unit,
) {
    val conflicts = if (prefs.showConflicts) Sudoku.conflicts(game.values.toIntArray()) else emptySet()
    val selValue = game.values[selected]
    val lineColor = MaterialTheme.colorScheme.onSurface
    val thin = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f)
    Box(
        Modifier
            .widthIn(max = 480.dp)
            .fillMaxWidth()
            .aspectRatio(1f)
            .border(2.dp, lineColor)
            // D-pad / keyboard: arrows move, digits enter, Delete erases, N toggles notes.
            .focusable()
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                val r = selected / 9; val c = selected % 9
                when (e.key) {
                    Key.DirectionUp -> { if (r > 0) { onSelect(selected - 9); true } else false }
                    Key.DirectionDown -> { if (r < 8) { onSelect(selected + 9); true } else false }
                    Key.DirectionLeft -> { if (c > 0) { onSelect(selected - 1); true } else false }
                    Key.DirectionRight -> { if (c < 8) { onSelect(selected + 1); true } else false }
                    Key.Backspace, Key.Delete, Key.Zero, Key.NumPad0 -> { onErase(); true }
                    Key.N -> { onToggleNotes(); true }
                    else -> {
                        val ch = e.utf16CodePoint.toChar()
                        if (ch in '1'..'9') { onDigit(ch - '0'); true } else false
                    }
                }
            },
    ) {
        Column(Modifier.fillMaxSize()) {
            for (r in 0 until 9) {
                Row(Modifier.fillMaxWidth().weight(1f)) {
                    for (c in 0 until 9) {
                        val i = r * 9 + c
                        val v = game.values[i]
                        val given = game.puzzle[i] != 0
                        val peer = Sudoku.row(i) == Sudoku.row(selected) || Sudoku.col(i) == Sudoku.col(selected) || Sudoku.box(i) == Sudoku.box(selected)
                        val bg = when {
                            i == selected -> MaterialTheme.colorScheme.primary.copy(alpha = 0.38f)
                            i in conflicts -> MaterialTheme.colorScheme.error.copy(alpha = 0.28f)
                            prefs.highlightSame && selValue != 0 && v == selValue -> MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
                            peer -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)
                            else -> MaterialTheme.colorScheme.surface
                        }
                        Box(
                            Modifier.weight(1f).fillMaxSize().background(androidx.compose.ui.graphics.Brush.linearGradient(listOf(
                                    androidx.compose.ui.graphics.lerp(bg, MaterialTheme.colorScheme.surface, 0.12f), bg,
                                )))
                                .clickable(onClickLabel = "Select") { onSelect(i) }
                                .semantics {
                                    contentDescription = "Row ${r + 1} column ${c + 1}, " +
                                        if (v == 0) "empty" else "$v${if (given) " given" else ""}"
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (v != 0) {
                                Text(
                                    "$v", fontSize = 22.sp,
                                    fontWeight = if (given) FontWeight.Bold else FontWeight.Normal,
                                    color = when {
                                        i in conflicts && !given -> MaterialTheme.colorScheme.error
                                        given -> MaterialTheme.colorScheme.onSurface
                                        else -> MaterialTheme.colorScheme.primary
                                    },
                                )
                            } else if (game.notes[i] != 0) {
                                Column(Modifier.fillMaxSize().padding(1.dp)) {
                                    for (nr in 0 until 3) Row(Modifier.weight(1f).fillMaxWidth()) {
                                        for (nc in 0 until 3) {
                                            val d = nr * 3 + nc + 1
                                            Box(Modifier.weight(1f).fillMaxSize(), contentAlignment = Alignment.Center) {
                                                if (game.notes[i] and (1 shl d) != 0) {
                                                    Text("$d", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        Canvas(Modifier.fillMaxSize()) {
            val step = size.width / 9f
            for (k in 1 until 9) {
                val heavy = k % 3 == 0
                val color = if (heavy) lineColor else thin
                val w = if (heavy) 2.dp.toPx() else 1.dp.toPx()
                drawLine(color, Offset(k * step, 0f), Offset(k * step, size.height), w)
                drawLine(color, Offset(0f, k * step), Offset(size.width, k * step), w)
            }
        }
    }
}
