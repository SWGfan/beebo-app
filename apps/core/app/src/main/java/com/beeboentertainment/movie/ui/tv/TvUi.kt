package com.beeboentertainment.movie.ui.tv

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.FocusInteraction
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.node.DelegatableNode
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.core.PlayerRemoteKeys
import com.beeboentertainment.movie.core.SelectPressTracker
import com.beeboentertainment.movie.core.TvDetection
import kotlinx.coroutines.launch

/*
 * Android TV support for the shared Compose screens.
 *
 * There is no separate TV UI: the phone screens run on the TV, and these pieces are what make
 * them work from a remote - knowing the device is a TV, drawing an obvious focus ring, a
 * long-press for the select button, and text boxes that do not throw the full-screen TV keyboard
 * up merely because the D-pad passed over them.
 */

object TvDevice {
    @Volatile
    private var cached: Boolean? = null

    /** Decided once per process; a phone does not turn into a TV while the app is running. */
    fun isTv(context: Context): Boolean = cached ?: detect(context.applicationContext).also { cached = it }

    private fun detect(context: Context): Boolean {
        val uiMode = runCatching {
            (context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager)?.currentModeType
        }.getOrNull() ?: context.resources.configuration.uiMode
        val pm = context.packageManager
        val leanback = runCatching {
            pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
                pm.hasSystemFeature("android.software.leanback_only")
        }.getOrDefault(false)
        val fireTv = runCatching { pm.hasSystemFeature(TvDetection.FIRE_TV_FEATURE) }.getOrDefault(false)
        return TvDetection.isTelevision(uiMode, leanback, fireTv)
    }
}

/** True on Android TV / Google TV. Provided by BeeboEntertainmentTheme. */
val LocalIsTv = staticCompositionLocalOf { false }

/**
 * The TV replacement for the ripple on plain `Modifier.clickable` surfaces (posters, list rows,
 * cards): a thick brand-coloured ring plus a light wash while focused. A ripple's faint focus
 * layer is invisible from a sofa.
 */
class TvFocusIndication(private val ring: Color) : IndicationNodeFactory {

    override fun create(interactionSource: InteractionSource): DelegatableNode =
        FocusRingNode(interactionSource, ring)

    override fun equals(other: Any?): Boolean = other is TvFocusIndication && other.ring == ring

    override fun hashCode(): Int = ring.hashCode()

    private class FocusRingNode(
        private val source: InteractionSource,
        private val ring: Color,
    ) : Modifier.Node(), DrawModifierNode {
        private var focused = false
        private var pressed = false

        override fun onAttach() {
            coroutineScope.launch {
                var focusCount = 0
                var pressCount = 0
                source.interactions.collect { interaction ->
                    when (interaction) {
                        is FocusInteraction.Focus -> focusCount++
                        is FocusInteraction.Unfocus -> focusCount--
                        is PressInteraction.Press -> pressCount++
                        is PressInteraction.Release, is PressInteraction.Cancel -> pressCount--
                    }
                    val f = focusCount > 0
                    val p = pressCount > 0
                    if (f != focused || p != pressed) {
                        focused = f
                        pressed = p
                        invalidateDraw()
                    }
                }
            }
        }

        override fun ContentDrawScope.draw() {
            drawContent()
            if (pressed) drawRect(Color.White.copy(alpha = 0.12f))
            if (focused) {
                val stroke = 3.dp.toPx()
                drawRect(ring.copy(alpha = 0.14f))
                drawRoundRect(
                    color = ring,
                    topLeft = Offset(stroke / 2, stroke / 2),
                    size = Size(size.width - stroke, size.height - stroke),
                    cornerRadius = CornerRadius(8.dp.toPx()),
                    style = Stroke(stroke),
                )
            }
        }
    }
}

/**
 * On a TV, gives the remote's select button a long press ([onLongClick], typically "details"),
 * and maps the Menu / Info keys to the same thing. Place it BEFORE the element's `clickable`.
 * A no-op on phones, where touch long-press is unchanged.
 */
fun Modifier.tvLongPress(onClick: () -> Unit, onLongClick: (() -> Unit)?): Modifier = composed {
    if (!LocalIsTv.current || onLongClick == null) return@composed Modifier
    val tracker = remember { SelectPressTracker() }
    val click by rememberUpdatedState(onClick)
    val long by rememberUpdatedState(onLongClick)
    Modifier.onPreviewKeyEvent { event ->
        val native = event.nativeKeyEvent
        val code = native.keyCode
        if (code == PlayerRemoteKeys.KEYCODE_MENU || code == PlayerRemoteKeys.KEYCODE_INFO) {
            if (event.type == KeyEventType.KeyDown && native.repeatCount == 0) long()
            return@onPreviewKeyEvent true
        }
        if (!PlayerRemoteKeys.isSelectKey(code)) return@onPreviewKeyEvent false
        when (event.type) {
            KeyEventType.KeyDown ->
                if (tracker.onKeyDown(native.repeatCount) == SelectPressTracker.Result.LONG_CLICK) long()
            KeyEventType.KeyUp ->
                if (tracker.onKeyUp() == SelectPressTracker.Result.CLICK) click()
        }
        true
    }
}

/**
 * A text box that works with a remote.
 *
 * Compose opens the keyboard as soon as a text field gains focus, and on a TV that keyboard is
 * full screen - so a search box at the top of a grid would pop it up every time the D-pad moved
 * past. On a TV the field therefore sits behind a focusable frame: D-pad focus lands on the frame
 * (with a ring), select opens the field and its keyboard, and moving away closes it again.
 * On a phone [field] is emitted exactly as before with a plain Modifier.
 *
 * [field] receives the Modifier to put FIRST on the text field's own modifier chain.
 */
@Composable
fun DpadTextField(
    modifier: Modifier = Modifier,
    frameFocusRequester: FocusRequester? = null,
    field: @Composable (Modifier) -> Unit,
) {
    if (!LocalIsTv.current) {
        field(Modifier)
        return
    }
    var editing by remember { mutableStateOf(false) }
    var fieldHadFocus by remember { mutableStateOf(false) }
    val fieldFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    LaunchedEffect(editing) {
        if (editing) {
            runCatching { fieldFocus.requestFocus() }
            keyboard?.show()
        }
    }

    Box(
        modifier
            .then(if (frameFocusRequester != null) Modifier.focusRequester(frameFocusRequester) else Modifier)
            .focusProperties { canFocus = !editing }
            .clickable { editing = true }
    ) {
        field(
            Modifier
                .focusRequester(fieldFocus)
                .focusProperties { canFocus = editing }
                .onFocusChanged { state ->
                    if (state.isFocused) {
                        fieldHadFocus = true
                    } else if (fieldHadFocus) {
                        fieldHadFocus = false
                        editing = false
                    }
                }
        )
    }
}

/** Shown if something still navigates to a phone-only feature on a TV. */
@Composable
fun NotAvailableOnTv(feature: String) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("📱", fontSize = 44.sp)
        Spacer(Modifier.height(12.dp))
        Text("$feature is not available on TV", fontSize = 20.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(
            "It needs a phone or tablet. Open Beebo on your phone to use it.",
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
