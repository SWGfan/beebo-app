package com.beeboentertainment.movie.campsite.solo

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.delay
import kotlin.math.roundToInt
import kotlin.random.Random

private const val KEY_SAVE = "solo_solitaire_game_v1"
private const val KEY_STATS = "solo_solitaire_stats_v1"

private val CARD_FACE = Color(0xFFFBFAF6)
private val CARD_RED = Color(0xFFC62828)
private val CARD_BLACK = Color(0xFF1C1C1C)

/** A drag in progress: which cards, from where, and how far they have moved. */
private data class Drag(val from: Spot, val count: Int, val start: Offset, val delta: Offset)

@Composable
internal fun SolitaireScreen() {
    val context = LocalContext.current
    val reduced = remember { reducedMotion(context) }
    var stats by remember { mutableStateOf(SoloStore.load(KEY_STATS, SolitaireStats.serializer()) ?: SolitaireStats()) }
    var save by remember {
        mutableStateOf(SoloStore.load(KEY_SAVE, SolitaireSave.serializer())?.takeIf { it.game.allCards().sorted() == (0 until 52).toList() }
            ?: SolitaireSave(Klondike.deal(Random(System.nanoTime()))).also {
                stats = stats.started(); SoloStore.save(KEY_STATS, SolitaireStats.serializer(), stats)
            })
    }
    val history = remember { mutableStateListOf<Klondike>() }
    var showNew by remember { mutableStateOf(false) }
    var finishing by remember { mutableStateOf(false) }
    val game = save.game

    fun persist(next: SolitaireSave) {
        var s = next
        if (s.game.won && !s.counted) {
            stats = stats.finished(s.game, s.elapsedMs)
            SoloStore.save(KEY_STATS, SolitaireStats.serializer(), stats)
            s = s.copy(counted = true)
        }
        save = s
        SoloStore.save(KEY_SAVE, SolitaireSave.serializer(), s)
    }

    fun apply(next: Klondike?) {
        if (next == null) return
        history.add(save.game)
        if (history.size > 500) history.removeAt(0)
        persist(save.copy(game = next))
    }

    fun undo() {
        if (history.isEmpty() || save.game.won) return
        persist(save.copy(game = history.removeAt(history.size - 1), undoCount = save.undoCount + 1))
    }

    fun newGame(draw: Int, scoring: Scoring) {
        history.clear()
        finishing = false
        stats = stats.started()
        SoloStore.save(KEY_STATS, SolitaireStats.serializer(), stats)
        persist(SolitaireSave(Klondike.deal(Random(System.nanoTime()), draw, scoring)))
    }

    SaveOnPause { SoloStore.save(KEY_SAVE, SolitaireSave.serializer(), save) }
    SoloTicker(running = game.moves > 0 && !game.won) { step -> save = save.copy(elapsedMs = save.elapsedMs + step) }

    LaunchedEffect(finishing) {
        while (finishing) {
            val step = save.game.autoFinishStep()
            if (step == null) { finishing = false; break }
            apply(step)
            if (!reduced) delay(70)
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SoloHeaderButtons(
            SOLITAIRE_GAME,
            listOf(
                "Games won" to "${stats.won} of ${stats.played}",
                "Best time" to if (stats.bestMs > 0) soloClock(stats.bestMs) else "—",
                "Fewest moves" to if (stats.fewestMoves > 0) "${stats.fewestMoves}" else "—",
                "Best score (Standard)" to "${stats.bestStandard}",
                "Best score (Vegas style)" to if (stats.bestVegas == Int.MIN_VALUE) "—" else "${stats.bestVegas}",
            ),
        ) {
            OutlinedButton(onClick = { showNew = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("New") }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                "⏱ ${soloClock(save.elapsedMs)}   Moves ${game.moves}   Score ${game.score}",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(onClick = { undo() }, enabled = history.isNotEmpty() && !game.won && !finishing,
                modifier = Modifier.heightIn(min = 48.dp)) { Text("Undo") }
            if (game.canAutoFinish && !finishing) {
                Button(onClick = { finishing = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Finish") }
            }
        }
        Text(
            "Draw ${game.drawCount}  ·  ${if (game.scoring == Scoring.VEGAS) "Vegas style scoring" else "Standard scoring"}" +
                if (game.scoring == Scoring.VEGAS) "  ·  passes left ${(game.redealsAllowed - game.redeals).coerceAtLeast(0) + if (game.stock.isNotEmpty() || game.waste.isNotEmpty()) 1 else 0}" else "",
            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (game.won) {
            WinBanner(reduced, save.elapsedMs, game.moves) { showNew = true }
        }

        Table(game = game, enabled = !finishing, onDraw = { apply(game.draw()) },
            onAuto = { from, count -> apply(game.autoMove(from, count)) },
            onMove = { from, count, to -> apply(game.move(from, count, to)) })
    }

    if (showNew) {
        var draw by remember { mutableStateOf(game.drawCount) }
        var scoring by remember { mutableStateOf(game.scoring) }
        AlertDialog(
            onDismissRequest = { showNew = false },
            title = { Text("New game") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Turn over")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = draw == 1, onClick = { draw = 1 }, label = { Text("1 card") })
                        FilterChip(selected = draw == 3, onClick = { draw = 3 }, label = { Text("3 cards") })
                    }
                    Text("Scoring")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = scoring == Scoring.STANDARD, onClick = { scoring = Scoring.STANDARD }, label = { Text("Standard") })
                        FilterChip(selected = scoring == Scoring.VEGAS, onClick = { scoring = Scoring.VEGAS }, label = { Text("Vegas style") })
                    }
                    Text(
                        if (scoring == Scoring.STANDARD) "Unlimited passes through the deck."
                        else "Limited passes through the deck; points only, nothing is paid.",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = { TextButton(onClick = { showNew = false; newGame(draw, scoring) }) { Text("Deal") } },
            dismissButton = { TextButton(onClick = { showNew = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun WinBanner(reduced: Boolean, ms: Long, moves: Int, onNew: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (reduced) {
                Text("🃏", fontSize = 36.sp)
            } else {
                // A gentle bounce of the four suits. Skipped entirely when animations are off.
                val t = rememberInfiniteTransition(label = "win")
                val lift by t.animateFloat(0f, 1f, infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse), label = "lift")
                val spin by t.animateFloat(-12f, 12f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "spin")
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    listOf("♣", "♦", "♥", "♠").forEachIndexed { i, s ->
                        val phase = if (i % 2 == 0) lift else 1f - lift
                        Text(s, fontSize = 34.sp, color = if (i == 1 || i == 2) CARD_RED else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.offset(y = (-14 * phase).dp).rotate(if (i % 2 == 0) spin else -spin))
                    }
                }
            }
            Text("You won!", style = MaterialTheme.typography.titleLarge)
            Text("${soloClock(ms)}  ·  $moves moves", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = onNew, modifier = Modifier.padding(top = 8.dp).heightIn(min = 48.dp)) { Text("Deal again") }
        }
    }
}

@Composable
private fun Table(
    game: Klondike,
    enabled: Boolean,
    onDraw: () -> Unit,
    onAuto: (Spot, Int) -> Unit,
    onMove: (Spot, Int, Spot) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val density = LocalDensity.current
        val gap = 4.dp
        val colW: Dp = maxWidth / 7
        val cardW = colW - gap
        val cardH = cardW * 1.4f
        val downStep = cardH * 0.14f
        val upStep = cardH * 0.3f
        val tableTop = cardH + 14.dp
        val tallest = (0 until 7).maxOf { c ->
            val pile = game.tableau[c]
            val down = game.faceDown[c]
            downStep * down + upStep * (pile.size - down).coerceAtLeast(0)
        }
        var drag by remember { mutableStateOf<Drag?>(null) }
        val colWpx = with(density) { colW.toPx() }
        val tableTopPx = with(density) { tableTop.toPx() }

        fun x(col: Int): Dp = colW * col + gap / 2

        fun dropTarget(point: Offset): Spot? {
            val col = (point.x / colWpx).toInt().coerceIn(0, 6)
            return if (point.y < tableTopPx) (if (col >= 3) Spot.Foundation(col - 3) else null) else Spot.Tableau(col)
        }

        Box(Modifier.fillMaxWidth().height(tableTop + tallest + cardH + 24.dp)) {
            // Stock
            Slot(x(0), 0.dp, cardW, cardH, "Deck") {}
            if (game.stock.isNotEmpty()) {
                CardView(null, x(0), 0.dp, cardW, cardH, faceUp = false, z = 1f,
                    modifier = Modifier.clickable(enabled = enabled, onClickLabel = "Turn over cards") { onDraw() })
            } else {
                Box(Modifier.offset(x(0), 0.dp).size(cardW, cardH).zIndex(1f)
                    .clickable(enabled = enabled && game.canRedeal, onClickLabel = "Turn the pile back over") { onDraw() }
                    .semantics { contentDescription = if (game.canRedeal) "Turn the pile back over" else "Deck empty" },
                    contentAlignment = Alignment.Center) {
                    Text(if (game.canRedeal) "↻" else "", fontSize = 26.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            // Waste: up to three fanned
            val shown = game.waste.takeLast(if (game.drawCount == 3) 3 else 1)
            shown.forEachIndexed { k, card ->
                val top = k == shown.size - 1
                val dx = cardW * 0.22f * k
                val dragging = top && drag?.from == Spot.Waste
                CardView(card, x(1) + dx, 0.dp, cardW, cardH, faceUp = true, z = if (dragging) 50f else 2f + k,
                    offset = if (dragging) drag!!.delta else Offset.Zero,
                    modifier = if (!top || !enabled) Modifier else Modifier
                        .draggable(Spot.Waste, 1, Offset(with(density) { (x(1) + dx).toPx() }, 0f), { drag = it }, { d ->
                            drag = null
                            dropTarget(d.start + d.delta + Offset(with(density) { cardW.toPx() } / 2, with(density) { cardH.toPx() } / 3))
                                ?.let { onMove(d.from, d.count, it) }
                        }, { drag = drag?.copy(delta = drag!!.delta + it) })
                        .clickable(onClickLabel = "Move ${Card.spoken(card)}") { onAuto(Spot.Waste, 1) })
            }
            // Foundations
            for (p in 0 until 4) {
                Slot(x(3 + p), 0.dp, cardW, cardH, "A") {}
                game.foundations[p].lastOrNull()?.let { card ->
                    CardView(card, x(3 + p), 0.dp, cardW, cardH, faceUp = true, z = 1f)
                }
            }
            // Tableau
            for (c in 0 until 7) {
                val pile = game.tableau[c]
                val down = game.faceDown[c]
                Slot(x(c), tableTop, cardW, cardH, "K") {}
                var y = tableTop
                pile.forEachIndexed { idx, card ->
                    val faceUp = idx >= down
                    val count = pile.size - idx
                    val inDrag = drag?.let { it.from == Spot.Tableau(c) && idx >= pile.size - it.count } == true
                    val cardY = y
                    CardView(
                        card, x(c), cardY, cardW, cardH, faceUp = faceUp,
                        z = if (inDrag) 50f + idx else 1f + idx,
                        offset = if (inDrag) drag!!.delta else Offset.Zero,
                        modifier = if (!faceUp || !enabled || !game.isMovableRun(c, count)) Modifier else Modifier
                            .draggable(Spot.Tableau(c), count, Offset(with(density) { x(c).toPx() }, with(density) { cardY.toPx() }), { drag = it }, { d ->
                                drag = null
                                dropTarget(d.start + d.delta + Offset(with(density) { cardW.toPx() } / 2, with(density) { cardH.toPx() } / 4))
                                    ?.let { onMove(d.from, d.count, it) }
                            }, { drag = drag?.copy(delta = drag!!.delta + it) })
                            .clickable(onClickLabel = "Move ${Card.spoken(card)}") { onAuto(Spot.Tableau(c), count) },
                    )
                    y += if (faceUp) upStep else downStep
                }
            }
        }
    }
}

private fun Modifier.draggable(
    from: Spot,
    count: Int,
    start: Offset,
    onStart: (Drag) -> Unit,
    onEnd: (Drag) -> Unit,
    onDelta: (Offset) -> Unit,
): Modifier = this.pointerInput(from, count, start) {
    var current = Drag(from, count, start, Offset.Zero)
    detectDragGestures(
        onDragStart = { current = Drag(from, count, start, Offset.Zero); onStart(current) },
        onDragEnd = { onEnd(current) },
        onDragCancel = { onEnd(current.copy(delta = Offset(-1e6f, -1e6f))) },
        onDrag = { change, amount ->
            change.consume()
            current = current.copy(delta = current.delta + amount)
            onDelta(amount)
        },
    )
}

@Composable
private fun Slot(x: Dp, y: Dp, w: Dp, h: Dp, hint: String, content: @Composable () -> Unit) {
    Box(
        Modifier.offset(x, y).size(w, h)
            .border(1.dp, MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f), RoundedCornerShape(6.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Text(hint, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f), fontSize = 14.sp)
        content()
    }
}

@Composable
private fun CardView(
    card: Int?,
    x: Dp,
    y: Dp,
    w: Dp,
    h: Dp,
    faceUp: Boolean,
    z: Float,
    offset: Offset = Offset.Zero,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(6.dp)
    Box(
        Modifier
            .zIndex(z)
            .offset(x, y)
            .offset { IntOffset(offset.x.roundToInt(), offset.y.roundToInt()) }
            .size(w, h)
            .clip(shape)
            .background(if (faceUp) CARD_FACE else MaterialTheme.colorScheme.primary)
            .border(1.dp, Color(0x55000000), shape)
            .semantics { contentDescription = if (faceUp && card != null) Card.spoken(card) else "Face-down card" }
            .then(modifier),
    ) {
        if (faceUp && card != null) {
            val color = if (Card.red(card)) CARD_RED else CARD_BLACK
            Column(Modifier.padding(horizontal = 3.dp, vertical = 1.dp)) {
                Text(Card.rankLabel(card) + Card.suitLabel(card), color = color, fontSize = 13.sp,
                    fontWeight = FontWeight.Bold, maxLines = 1)
            }
            Text(Card.suitLabel(card), color = color, fontSize = 24.sp, modifier = Modifier.align(Alignment.Center).padding(top = 10.dp))
        } else {
            Box(Modifier.fillMaxSize().padding(4.dp).border(1.dp, Color.White.copy(alpha = 0.5f), RoundedCornerShape(4.dp)))
        }
        // Existing text remains underneath as an immediate, accessible loading fallback.
        val artwork = if (faceUp && card != null)
            "cards/${listOf("C", "D", "H", "S")[Card.suit(card)]}-${Card.rankLabel(card)}.png"
        else "cards/back.png"
        com.beeboentertainment.movie.campsite.GameArtImage(artwork, Modifier.matchParentSize())
    }
}
