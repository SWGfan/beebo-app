package com.beeboentertainment.movie.party.games

import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.party.RoomMessenger
import com.beeboentertainment.movie.party.rememberRoomMessenger
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/*
 * "Pick the Next One" — the group chooses what to watch next, and the tie-break is a wheel
 * everybody watches spin at the same time.
 *
 * Wire protocol, over the shared room socket (RoomClient.sendApp; the hub relays and stamps
 * `from`). All types are in the game_ family, which is what the hub forwards:
 *
 *   game_pick  { who, title }        someone put a title forward (or changed theirs)
 *   game_spin  { winner, entries, turns }
 *                                    the spin everyone animates. `entries` is the packed
 *                                    entry list so every phone draws the SAME wheel, and
 *                                    `winner` is the index into it.
 *   game_clear {}                    start again
 *
 * The important design point: the phone that presses Spin decides the winner and tells
 * everyone, rather than each phone rolling its own dice. Two phones rolling separately would
 * disagree, and "the wheel said different things on different phones" would ruin the moment.
 * Sending the entry list with the spin means a phone that joined late, or missed a pick,
 * still draws and lands on exactly what everyone else sees.
 */

private const val MSG_PICK = "game_pick"
private const val MSG_SPIN = "game_spin"
private const val MSG_CLEAR = "game_clear"

/**
 * Separators for the packed entry list: the ASCII unit and record separators. They are
 * control characters, so no film title or name can contain one and split an entry in two.
 * Written as escapes rather than literal control bytes so an editor cannot silently eat them.
 */
private const val FIELD_SEP = "\u001F"
private const val ENTRY_SEP = "\u001E"

/** One person's suggestion. */
internal data class Pick(val who: String, val title: String)

internal fun packEntries(entries: List<Pick>): String =
    entries.joinToString(ENTRY_SEP) { it.who + FIELD_SEP + it.title }

internal fun unpackEntries(text: String): List<Pick> =
    text.split(ENTRY_SEP)
        .filter { it.isNotBlank() }
        .mapNotNull {
            val parts = it.split(FIELD_SEP)
            if (parts.size >= 2) Pick(parts[0], parts.drop(1).joinToString(FIELD_SEP)) else null
        }

/** The wheel's slice colours, cycled. Chosen to stay legible with white text on top. */
private val SLICE_COLORS = listOf(
    Color(0xFF6A1B9A), Color(0xFF283593), Color(0xFF00695C), Color(0xFFC62828),
    Color(0xFFEF6C00), Color(0xFF4527A0), Color(0xFF00838F), Color(0xFF558B2F),
)

/**
 * Where the wheel must stop so slice [winner] sits under the pointer at the top.
 *
 * drawArc measures from 3 o'clock going clockwise, and the pointer is at 12 o'clock (-90°),
 * so the rotation that centres slice i is -90 - (i*sweep + sweep/2), normalised into [0,360)
 * and then given [turns] whole rotations so it actually looks like a spin.
 */
internal fun targetRotation(winner: Int, count: Int, turns: Int): Float {
    if (count <= 0) return 0f
    val sweep = 360f / count
    val centre = winner * sweep + sweep / 2f
    var r = -90f - centre
    while (r < 0f) r += 360f
    return r + 360f * turns
}

@Composable
fun PickNextScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val deviceName = remember { session.userName?.takeIf { it.isNotBlank() } ?: "Someone" }
    val messenger = rememberRoomMessenger(session, deviceName)
    PickNextGame(me = deviceName, messenger = messenger, modifier = modifier)
}

@Composable
fun PickNextGame(
    me: String,
    messenger: RoomMessenger?,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val connected = messenger?.connected?.collectAsState()?.value ?: false

    var draft by remember { mutableStateOf("") }
    // Everyone's picks, keyed by name so a second suggestion replaces the first.
    val picks = remember { mutableStateOf<List<Pick>>(emptyList()) }
    var wheel by remember { mutableStateOf<List<Pick>>(emptyList()) }
    var winner by remember { mutableStateOf<Int?>(null) }
    var spinning by remember { mutableStateOf(false) }

    val rotation = remember { Animatable(0f) }

    fun upsert(list: List<Pick>, p: Pick): List<Pick> {
        val i = list.indexOfFirst { it.who.equals(p.who, ignoreCase = true) }
        return if (i >= 0) list.toMutableList().also { it[i] = p } else list + p
    }

    fun submit() {
        val title = draft.trim()
        if (title.isEmpty()) return
        val p = Pick(me, title)
        picks.value = upsert(picks.value, p)
        // Drop back to the live list so the wheel redraws with this pick on it,
        // instead of still showing whatever was captured at the last spin.
        wheel = emptyList()
        winner = null
        messenger?.send(MSG_PICK, buildJsonObject { put("who", p.who); put("title", p.title) })
        draft = ""
    }

    /** Run the same animation everyone else is running. */
    fun animateTo(entries: List<Pick>, winnerIndex: Int, turns: Int) {
        if (entries.isEmpty()) return
        wheel = entries
        winner = null
        spinning = true
        scope.launch {
            rotation.snapTo(rotation.value % 360f)
            rotation.animateTo(
                targetValue = targetRotation(winnerIndex, entries.size, turns),
                animationSpec = tween(durationMillis = 4200, easing = FastOutSlowInEasing),
            )
            winner = winnerIndex
            spinning = false
        }
    }

    fun spin() {
        val entries = picks.value
        if (entries.size < 2 || spinning) return
        val winnerIndex = entries.indices.random()
        val turns = (4..6).random()
        messenger?.send(
            MSG_SPIN,
            buildJsonObject {
                put("winner", winnerIndex)
                put("entries", packEntries(entries))
                put("turns", turns)
            },
        )
        animateTo(entries, winnerIndex, turns)
    }

    fun clearAll() {
        picks.value = emptyList()
        wheel = emptyList()
        winner = null
        messenger?.send(MSG_CLEAR, buildJsonObject { })
    }

    // Peer messages.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_PICK -> {
                    val who = msg.data["who"]?.jsonPrimitive?.content ?: return@collect
                    val title = msg.data["title"]?.jsonPrimitive?.content ?: return@collect
                    picks.value = upsert(picks.value, Pick(who, title))
                    // Same as a local pick: the drawn wheel must follow the list.
                    wheel = emptyList()
                    winner = null
                }
                MSG_SPIN -> {
                    val entries = unpackEntries(msg.data["entries"]?.jsonPrimitive?.content ?: "")
                    val w = msg.data["winner"]?.jsonPrimitive?.intOrNull ?: return@collect
                    val turns = msg.data["turns"]?.jsonPrimitive?.intOrNull ?: 5
                    if (entries.isNotEmpty() && w in entries.indices) {
                        // Adopt the spinner's list so every phone shows the same wheel.
                        picks.value = entries
                        animateTo(entries, w, turns)
                    }
                }
                MSG_CLEAR -> {
                    picks.value = emptyList()
                    wheel = emptyList()
                    winner = null
                }
            }
        }
    }

    // A phone that joins mid-round should see the picks already on the table.
    LaunchedEffect(messenger) {
        messenger?.memberJoined?.collect {
            picks.value.firstOrNull { p -> p.who == me }?.let { mine ->
                messenger.send(
                    MSG_PICK,
                    buildJsonObject { put("who", mine.who); put("title", mine.title) },
                )
            }
        }
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Pick the Next One", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text(
            when {
                messenger == null ->
                    "Everyone puts a title forward and the wheel decides. Sign in to the hub in " +
                        "Settings so everyone's phone joins the same room."
                connected ->
                    "Everyone puts a title forward. If there's more than one, spin the wheel — " +
                        "it lands on the same name on every phone."
                else -> "Reconnecting to the room…"
            },
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                label = { Text("What do you want to watch?") },
                singleLine = true,
                modifier = Modifier.weight(1f),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
            )
            Button(enabled = draft.isNotBlank(), onClick = { submit() }) { Text("Add") }
        }

        HorizontalDivider()

        val entries = picks.value
        if (entries.isEmpty()) {
            Text(
                "Nobody's picked yet. Put the first one forward.",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Text(
                "${entries.size} on the wheel",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            entries.forEach { p ->
                Card(Modifier.fillMaxWidth()) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            p.who,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.width(96.dp),
                        )
                        Text(p.title, fontSize = 15.sp)
                    }
                }
            }
        }

        // The wheel. Only worth showing once there's something to spin.
        val shown = if (wheel.isNotEmpty()) wheel else entries
        if (shown.size >= 2) {
            Spacer(Modifier.height(4.dp))
            Box(
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f),
                contentAlignment = Alignment.Center,
            ) {
                Wheel(names = shown.map { it.who }, rotationDegrees = rotation.value)
            }
        }

        val w = winner
        if (w != null && w in shown.indices) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text(
                        "${shown[w].who} wins the spin",
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text("Next up: ${shown[w].title}", fontSize = 16.sp)
                }
            }
        }

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                enabled = entries.size >= 2 && !spinning,
                onClick = { spin() },
                modifier = Modifier
                    .weight(1f)
                    .height(52.dp),
            ) { Text(if (spinning) "Spinning…" else "Spin the wheel") }
            OutlinedButton(
                enabled = entries.isNotEmpty() && !spinning,
                onClick = { clearAll() },
                modifier = Modifier.height(52.dp),
            ) { Text("Clear") }
        }

        if (entries.size == 1) {
            Text(
                "Only one pick so far — no need for a wheel yet.",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** The wheel itself: one coloured slice per name, with a fixed pointer at the top. */
@Composable
private fun Wheel(names: List<String>, rotationDegrees: Float) {
    Canvas(Modifier.fillMaxSize()) {
        val count = names.size
        if (count == 0) return@Canvas
        val sweep = 360f / count
        val d = min(size.width, size.height)
        val r = d / 2f
        val centre = Offset(size.width / 2f, size.height / 2f)
        val topLeft = Offset(centre.x - r, centre.y - r)
        val arcSize = Size(d, d)

        rotate(degrees = rotationDegrees, pivot = centre) {
            names.forEachIndexed { i, name ->
                drawArc(
                    color = SLICE_COLORS[i % SLICE_COLORS.size],
                    startAngle = i * sweep,
                    sweepAngle = sweep,
                    useCenter = true,
                    topLeft = topLeft,
                    size = arcSize,
                )
                // Label, laid along the slice's centre line.
                val mid = Math.toRadians((i * sweep + sweep / 2f).toDouble())
                val lx = centre.x + cos(mid).toFloat() * r * 0.62f
                val ly = centre.y + sin(mid).toFloat() * r * 0.62f
                drawContext.canvas.nativeCanvas.apply {
                    val paint = Paint().apply {
                        color = android.graphics.Color.WHITE
                        textSize = (r * 0.11f).coerceIn(22f, 56f)
                        textAlign = Paint.Align.CENTER
                        isAntiAlias = true
                        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                    }
                    val label = if (name.length > 12) name.take(11) + "…" else name
                    save()
                    rotate((i * sweep + sweep / 2f), lx, ly)
                    drawText(label, lx, ly + paint.textSize / 3f, paint)
                    restore()
                }
            }
        }

        // Fixed pointer at 12 o'clock, drawn OUTSIDE the rotate block so it stays put.
        val p = Path().apply {
            moveTo(centre.x - r * 0.07f, centre.y - r * 1.02f)
            lineTo(centre.x + r * 0.07f, centre.y - r * 1.02f)
            lineTo(centre.x, centre.y - r * 0.84f)
            close()
        }
        drawPath(p, Color(0xFFFFD700))
    }
}
