package com.beeboentertainment.movie.campsite.solo

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.random.Random

private const val KEY_SAVE = "solo_minesweeper_game_v1"
private const val KEY_STATS = "solo_minesweeper_stats_v1"

/** Base square size at zoom 1. 40dp keeps a square a comfortable touch target. */
private val CELL = 40.dp

@Composable
internal fun MinesweeperScreen() {
    val random = remember { Random(System.nanoTime()) }
    var save by remember {
        mutableStateOf(SoloStore.load(KEY_SAVE, MineSave.serializer())?.takeIf { it.board.mines.size == it.board.size }
            ?: MineSave(MineLevel.BEGINNER, MineBoard.of(MineLevel.BEGINNER)))
    }
    var stats by remember { mutableStateOf(SoloStore.load(KEY_STATS, MineStats.serializer()) ?: MineStats()) }
    var flagMode by remember { mutableStateOf(false) }
    var cursor by remember { mutableStateOf(-1) }
    val haptics = LocalHapticFeedback.current

    fun update(next: MineSave) {
        var s = next
        if (s.board.over && !s.counted) {
            stats = stats.record(s.level, s.board.won, s.board.elapsedMs)
            SoloStore.save(KEY_STATS, MineStats.serializer(), stats)
            s = s.copy(counted = true)
        }
        save = s
        SoloStore.save(KEY_SAVE, MineSave.serializer(), s)
    }

    fun newGame(level: MineLevel) {
        cursor = -1
        update(MineSave(level, MineBoard.of(level)))
    }

    fun primary(i: Int, forceFlag: Boolean = false) {
        val b = save.board
        if (b.over) return
        val next = when {
            b.revealed[i] -> b.chord(i, random)
            forceFlag || flagMode -> b.toggleFlag(i)
            else -> b.dig(i, random)
        }
        if (next != b) update(save.copy(board = next))
    }

    SaveOnPause { SoloStore.save(KEY_SAVE, MineSave.serializer(), save) }
    SoloTicker(running = save.board.placed && !save.board.over) { step ->
        save = save.copy(board = save.board.copy(elapsedMs = save.board.elapsedMs + step))
    }

    val board = save.board
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SoloHeaderButtons(
            MINESWEEPER_GAME,
            MineLevel.values().flatMap { l ->
                val s = stats.of(l)
                listOf("${l.label}: won" to "${s.won} of ${s.played}",
                    "${l.label}: best time" to if (s.bestMs > 0) soloClock(s.bestMs) else "—")
            },
        )
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            MineLevel.values().forEach { l ->
                FilterChip(selected = save.level == l, onClick = { newGame(l) }, label = { Text(l.label) },
                    modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilterChip(selected = !flagMode, onClick = { flagMode = false }, label = { Text("⛏ Dig") },
                modifier = Modifier.heightIn(min = 48.dp))
            FilterChip(selected = flagMode, onClick = { flagMode = true }, label = { Text("🚩 Flag") },
                modifier = Modifier.heightIn(min = 48.dp))
            Text("💣 ${board.flagsLeft}   ⏱ ${soloClock(board.elapsedMs)}", style = MaterialTheme.typography.titleMedium)
        }
        val status = when {
            board.won -> "Cleared! ${save.level.label} in ${soloClock(board.elapsedMs)}"
            board.lost -> "Boom! That was a mine."
            !board.placed -> "Tap any square to start. The first one is always safe."
            else -> ""
        }
        if (status.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(status, color = if (board.lost) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    modifier = Modifier.weight(1f, fill = false))
                if (board.over) OutlinedButton(onClick = { newGame(save.level) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Play again") }
            }
        }
        MineField(
            board = board,
            cursor = cursor,
            onCursor = { cursor = it },
            onTap = { primary(it) },
            onLongPress = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); primary(it, forceFlag = true) },
            onFlag = { primary(it, forceFlag = true) },
            modifier = Modifier.fillMaxWidth().weight(1f),
        )
    }
}

@Composable
private fun MineField(
    board: MineBoard,
    cursor: Int,
    onCursor: (Int) -> Unit,
    onTap: (Int) -> Unit,
    onLongPress: (Int) -> Unit,
    onFlag: (Int) -> Unit,
    modifier: Modifier,
) {
    val density = LocalDensity.current
    val cellPx = with(density) { CELL.toPx() }
    val measurer = rememberTextMeasurer()
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    val hidden = MaterialTheme.colorScheme.surfaceVariant
    val open = MaterialTheme.colorScheme.surface
    val lineColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f)
    val cursorColor = MaterialTheme.colorScheme.primary
    val numberColors = if (dark) listOf(
        Color(0xFF7FB2FF), Color(0xFF7ED492), Color(0xFFFF8A80), Color(0xFFC9A0FF),
        Color(0xFFFFB86B), Color(0xFF6FE3E3), Color(0xFFE9ECF3), Color(0xFFB9C1D4),
    ) else listOf(
        Color(0xFF1B4FD1), Color(0xFF1E7B34), Color(0xFFC62828), Color(0xFF4A148C),
        Color(0xFF8D4A00), Color(0xFF00707A), Color(0xFF222222), Color(0xFF555555),
    )
    val boardW = board.cols * cellPx
    val boardH = board.rows * cellPx
    val latestBoard by rememberUpdatedState(board)
    val tap by rememberUpdatedState(onTap)
    val longPress by rememberUpdatedState(onLongPress)

    BoxWithConstraints(modifier.clipToBounds().background(MaterialTheme.colorScheme.background)) {
        val viewW = constraints.maxWidth.toFloat()
        val viewH = constraints.maxHeight.toFloat().coerceAtLeast(1f)
        val fit = minOf(viewW / boardW, viewH / boardH)
        val minScale = minOf(fit, 1f)
        val maxScale = 3f
        var scale by remember(board.rows, board.cols) { mutableFloatStateOf(if (fit >= 0.9f) minOf(fit, 1.6f) else 1f) }
        var ox by remember(board.rows, board.cols) { mutableFloatStateOf(0f) }
        var oy by remember(board.rows, board.cols) { mutableFloatStateOf(0f) }

        fun clamp() {
            val w = boardW * scale; val h = boardH * scale
            ox = if (w <= viewW) (viewW - w) / 2 else ox.coerceIn(viewW - w, 0f)
            oy = if (h <= viewH) (viewH - h) / 2 else oy.coerceIn(viewH - h, 0f)
        }
        fun zoomBy(factor: Float, cx: Float = viewW / 2, cy: Float = viewH / 2) {
            val next = (scale * factor).coerceIn(minScale, maxScale)
            val k = next / scale
            ox = (ox - cx) * k + cx
            oy = (oy - cy) * k + cy
            scale = next
            clamp()
        }
        LaunchedEffect(board.rows, board.cols, viewW, viewH) { clamp() }

        fun cellAt(p: Offset): Int? {
            val x = (p.x - ox) / scale / cellPx
            val y = (p.y - oy) / scale / cellPx
            val c = x.toInt(); val r = y.toInt()
            return if (x >= 0 && y >= 0 && r < board.rows && c < board.cols) r * board.cols + c else null
        }
        fun ensureVisible(i: Int) {
            val r = i / board.cols; val c = i % board.cols
            val left = ox + c * cellPx * scale; val top = oy + r * cellPx * scale
            val s = cellPx * scale
            if (left < 0) ox -= left
            if (left + s > viewW) ox -= left + s - viewW
            if (top < 0) oy -= top
            if (top + s > viewH) oy -= top + s - viewH
            clamp()
        }

        Canvas(
            Modifier
                .fillMaxSize()
                .semantics {
                    contentDescription = "Minefield, ${board.rows} by ${board.cols}. Use arrow keys to move, " +
                        "Enter to dig, F to flag."
                }
                .focusable()
                .onKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                    val cur = if (cursor < 0) (board.rows / 2) * board.cols + board.cols / 2 else cursor
                    val r = cur / board.cols; val c = cur % board.cols
                    val next = when (e.key) {
                        Key.DirectionUp -> if (r > 0) cur - board.cols else null
                        Key.DirectionDown -> if (r < board.rows - 1) cur + board.cols else null
                        Key.DirectionLeft -> if (c > 0) cur - 1 else null
                        Key.DirectionRight -> if (c < board.cols - 1) cur + 1 else null
                        Key.DirectionCenter, Key.Enter, Key.NumPadEnter, Key.Spacebar -> { tap(cur); return@onKeyEvent true }
                        Key.F, Key.Menu, Key.ButtonY -> { onFlag(cur); return@onKeyEvent true }
                        else -> return@onKeyEvent false
                    }
                    if (next == null) return@onKeyEvent false
                    onCursor(next); ensureVisible(next); true
                }
                .pointerInput(board.rows, board.cols) {
                    detectTransformGestures { centroid, pan, zoom, _ ->
                        if (zoom != 1f) zoomBy(zoom, centroid.x, centroid.y)
                        ox += pan.x; oy += pan.y
                        clamp()
                    }
                }
                .pointerInput(board.rows, board.cols) {
                    detectTapGestures(
                        onTap = { p -> cellAt(p)?.let { tap(it) } },
                        onLongPress = { p -> cellAt(p)?.let { longPress(it) } },
                    )
                },
        ) {
            val b = latestBoard
            val numberStyle = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Bold)
            translate(ox, oy) {
                scale(scale, scale, pivot = Offset.Zero) {
                    for (i in 0 until b.size) {
                        val r = i / b.cols; val c = i % b.cols
                        val tl = Offset(c * cellPx, r * cellPx)
                        val inset = cellPx * 0.04f
                        val isOpen = b.revealed[i]
                        val showMine = b.mines[i] && (b.lost || isOpen)
                        drawRoundRect(
                            color = when {
                                i == b.exploded -> Color(0xFFD32F2F)
                                isOpen || (b.lost && showMine) -> open
                                else -> hidden
                            },
                            topLeft = tl + Offset(inset, inset),
                            size = Size(cellPx - 2 * inset, cellPx - 2 * inset),
                            cornerRadius = CornerRadius(cellPx * 0.12f),
                        )
                        if (!isOpen && !showMine) {
                            drawLine(Color.White.copy(alpha = 0.32f), tl + Offset(cellPx * 0.12f, cellPx * 0.12f),
                                tl + Offset(cellPx * 0.86f, cellPx * 0.12f), cellPx * 0.04f)
                            drawLine(Color.Black.copy(alpha = 0.22f), tl + Offset(cellPx * 0.12f, cellPx * 0.88f),
                                tl + Offset(cellPx * 0.86f, cellPx * 0.88f), cellPx * 0.045f)
                        }
                        val center = tl + Offset(cellPx * 0.5f, cellPx * 0.5f)
                        if (showMine) {
                            for (ray in 0 until 8) {
                                val angle = ray * kotlin.math.PI / 4
                                val edge = Offset(kotlin.math.cos(angle).toFloat(), kotlin.math.sin(angle).toFloat())
                                drawLine(Color(0xFF22374D), center + edge * (cellPx * 0.15f), center + edge * (cellPx * 0.31f), cellPx * 0.055f)
                            }
                            drawCircle(Color(0xFF22374D), cellPx * 0.22f, center)
                            drawCircle(Color(0xFFB4D7E0), cellPx * 0.065f, center - Offset(cellPx * 0.065f, cellPx * 0.065f))
                        } else if (b.flagged[i]) {
                            drawLine(Color(0xFF273B52), tl + Offset(cellPx * 0.37f, cellPx * 0.22f), tl + Offset(cellPx * 0.37f, cellPx * 0.78f), cellPx * 0.055f)
                            val flag = androidx.compose.ui.graphics.Path().apply {
                                moveTo(tl.x + cellPx * 0.39f, tl.y + cellPx * 0.22f)
                                lineTo(tl.x + cellPx * 0.76f, tl.y + cellPx * 0.36f)
                                lineTo(tl.x + cellPx * 0.39f, tl.y + cellPx * 0.51f)
                                close()
                            }
                            drawPath(flag, Color(0xFFC98239))
                            drawLine(Color(0xFF273B52), tl + Offset(cellPx * 0.22f, cellPx * 0.79f), tl + Offset(cellPx * 0.62f, cellPx * 0.79f), cellPx * 0.055f)
                            if (b.lost && !b.mines[i]) {
                                drawLine(Color(0xFFBB263E), tl + Offset(cellPx * 0.2f, cellPx * 0.2f), tl + Offset(cellPx * 0.8f, cellPx * 0.8f), cellPx * 0.065f)
                                drawLine(Color(0xFFBB263E), tl + Offset(cellPx * 0.8f, cellPx * 0.2f), tl + Offset(cellPx * 0.2f, cellPx * 0.8f), cellPx * 0.065f)
                            }
                        }
                        val label: Pair<String, Color>? = when {
                            showMine || b.flagged[i] -> null
                            isOpen -> b.adjacentMines(i).takeIf { it > 0 }?.let { "$it" to numberColors[it - 1] }
                            else -> null
                        }
                        if (label != null) {
                            val style = if (label.second == Color.Unspecified) numberStyle.copy(fontSize = 18.sp) else numberStyle.copy(color = label.second)
                            val layout = measurer.measure(label.first, style)
                            drawText(layout, topLeft = tl + Offset((cellPx - layout.size.width) / 2, (cellPx - layout.size.height) / 2))
                        }
                    }
                    drawRect(lineColor, Offset.Zero, Size(boardW, boardH), style = Stroke(1f))
                    if (cursor in 0 until b.size) {
                        val r = cursor / b.cols; val c = cursor % b.cols
                        drawRect(cursorColor, Offset(c * cellPx, r * cellPx), Size(cellPx, cellPx), style = Stroke(cellPx * 0.1f))
                    }
                }
            }
        }

        Column(Modifier.align(Alignment.BottomEnd).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick = { zoomBy(1.25f) }, modifier = Modifier.heightIn(min = 48.dp)
                .background(MaterialTheme.colorScheme.surface, MaterialTheme.shapes.extraLarge)) { Text("+") }
            OutlinedButton(onClick = { zoomBy(0.8f) }, modifier = Modifier.heightIn(min = 48.dp)
                .background(MaterialTheme.colorScheme.surface, MaterialTheme.shapes.extraLarge)) { Text("–") }
            OutlinedButton(onClick = { scale = minScale; clamp() }, modifier = Modifier.heightIn(min = 48.dp)
                .background(MaterialTheme.colorScheme.surface, MaterialTheme.shapes.extraLarge)) { Text("Fit") }
        }
    }
}
