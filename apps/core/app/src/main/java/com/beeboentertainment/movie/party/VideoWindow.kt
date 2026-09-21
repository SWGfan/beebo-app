package com.beeboentertainment.movie.party

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.data.SessionStore
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.math.roundToInt

/**
 * A floating, draggable, resizable, hideable video window for viewers.
 *
 * It is deliberately a *frame*: the actual video surface (a Media3 PlayerView, a
 * SurfaceView, etc.) is passed in as [content], so this never has to know how the
 * picture is produced and the app's existing player UI stays untouched. The frame
 * adds only chrome — a move bar, a resize handle, and a hide toggle.
 *
 *  - MOVE: drag the top bar. Position is clamped inside the parent.
 *  - RESIZE: drag the bottom-right handle. Clamped between a sensible minimum and
 *    the parent's own size.
 *  - HIDE: the "disable screen" toggle collapses the frame to a small pill. Audio
 *    is not touched here — [PartyController] owns the player — so hiding the
 *    picture leaves the (host's) sound playing.
 *
 * Geometry (position, size, hidden) is persisted to [SessionStore.videoWindow] as
 * a small JSON blob and restored on the next composition.
 *
 * Place it as the top layer of a Box that fills the area it may roam over.
 */
@Composable
fun VideoWindow(
    session: SessionStore,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val density = LocalDensity.current

    BoxWithConstraints(modifier.fillMaxSize()) {
        val boundsW = constraints.maxWidth.toFloat()
        val boundsH = constraints.maxHeight.toFloat()

        val minWpx = with(density) { MIN_SIZE_DP.dp.toPx() }

        // Restore once; further edits live in these states and are persisted back.
        val saved = remember { parseGeom(session.videoWindow) }

        var xPx by remember {
            mutableFloatStateOf(with(density) { (saved?.x ?: DEFAULT_X_DP).dp.toPx() })
        }
        var yPx by remember {
            mutableFloatStateOf(with(density) { (saved?.y ?: DEFAULT_Y_DP).dp.toPx() })
        }
        var wPx by remember {
            mutableFloatStateOf(with(density) { (saved?.w ?: DEFAULT_W_DP).dp.toPx() })
        }
        var hPx by remember {
            mutableFloatStateOf(with(density) { (saved?.h ?: DEFAULT_H_DP).dp.toPx() })
        }
        var hidden by remember { mutableStateOf(saved?.hidden ?: false) }

        fun persist() {
            val geom = WindowGeom(
                x = with(density) { xPx.toDp().value.roundToInt() },
                y = with(density) { yPx.toDp().value.roundToInt() },
                w = with(density) { wPx.toDp().value.roundToInt() },
                h = with(density) { hPx.toDp().value.roundToInt() },
                hidden = hidden,
            )
            session.videoWindow = Json.encodeToString(geom)
        }

        // Keep width/height within [min, bounds] and the window fully on-screen.
        fun clamp() {
            val maxW = boundsW.coerceAtLeast(minWpx)
            val maxH = boundsH.coerceAtLeast(minWpx)
            wPx = wPx.coerceIn(minWpx, maxW)
            hPx = hPx.coerceIn(minWpx, maxH)
            xPx = xPx.coerceIn(0f, (boundsW - wPx).coerceAtLeast(0f))
            yPx = yPx.coerceIn(0f, (boundsH - hPx).coerceAtLeast(0f))
        }

        // Re-clamp against the live bounds (e.g. a rotation shrank the parent).
        // Done in an effect, not inline, so no snapshot state is written during
        // composition.
        LaunchedEffect(boundsW, boundsH) { clamp() }

        if (hidden) {
            // Collapsed pill: keep it roughly where the window was so "Show" puts
            // the picture back where the user left it.
            Surface(
                shape = RoundedCornerShape(20.dp),
                tonalElevation = 3.dp,
                modifier = Modifier
                    .offset { IntOffset(xPx.roundToInt(), yPx.roundToInt()) }
                    .pointerInput(Unit) {
                        detectDragGestures(
                            onDragEnd = { persist() },
                        ) { change, drag ->
                            change.consume()
                            xPx += drag.x
                            yPx += drag.y
                            clamp()
                        }
                    },
            ) {
                TextButton(onClick = { hidden = false; persist() }) { Text("Show video") }
            }
            return@BoxWithConstraints
        }

        Surface(
            shape = RoundedCornerShape(12.dp),
            tonalElevation = 6.dp,
            modifier = Modifier
                .offset { IntOffset(xPx.roundToInt(), yPx.roundToInt()) }
                .size(
                    width = with(density) { wPx.toDp() },
                    height = with(density) { hPx.toDp() },
                ),
        ) {
            Box(Modifier.fillMaxSize()) {
                Column(Modifier.fillMaxSize()) {
                    // ---- move bar (drag to reposition) + hide toggle
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                            .pointerInput(Unit) {
                                detectDragGestures(
                                    onDragEnd = { persist() },
                                ) { change, drag ->
                                    change.consume()
                                    xPx += drag.x
                                    yPx += drag.y
                                    clamp()
                                }
                            }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "Video",
                            style = MaterialTheme.typography.labelLarge,
                            modifier = Modifier.padding(end = 8.dp),
                        )
                        Box(Modifier.fillMaxWidth()) {
                            TextButton(
                                onClick = { hidden = true; persist() },
                                modifier = Modifier.align(Alignment.CenterEnd),
                            ) {
                                Icon(Icons.Filled.Close, contentDescription = null)
                                Text("  Disable screen")
                            }
                        }
                    }

                    // ---- the caller's video surface fills the rest
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .weight(1f)
                            .clip(RoundedCornerShape(bottomStartPercent = 6, bottomEndPercent = 6)),
                    ) {
                        content()
                    }
                }

                // ---- resize handle, bottom-right corner
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .size(HANDLE_DP.dp)
                        .background(Color.White.copy(alpha = 0.35f))
                        .pointerInput(Unit) {
                            detectDragGestures(
                                onDragEnd = { persist() },
                            ) { change, drag ->
                                change.consume()
                                wPx += drag.x
                                hPx += drag.y
                                clamp()
                            }
                        },
                ) {
                    Icon(
                        Icons.Filled.OpenInFull,
                        contentDescription = "Resize",
                        modifier = Modifier
                            .align(Alignment.Center)
                            .size((HANDLE_DP - 8).dp),
                    )
                }
            }
        }
    }
}

@Serializable
private data class WindowGeom(
    val x: Int,
    val y: Int,
    val w: Int,
    val h: Int,
    val hidden: Boolean,
)

private fun parseGeom(raw: String?): WindowGeom? =
    raw?.let { runCatching { Json.decodeFromString<WindowGeom>(it) }.getOrNull() }

private const val MIN_SIZE_DP = 120
private const val HANDLE_DP = 28
private const val DEFAULT_X_DP = 16
private const val DEFAULT_Y_DP = 16
private const val DEFAULT_W_DP = 240
private const val DEFAULT_H_DP = 160
