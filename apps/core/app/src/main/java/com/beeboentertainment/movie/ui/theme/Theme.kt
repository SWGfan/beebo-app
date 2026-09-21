package com.beeboentertainment.movie.ui.theme

import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import com.beeboentertainment.movie.ui.tv.LocalIsTv
import com.beeboentertainment.movie.ui.tv.TvDevice
import com.beeboentertainment.movie.ui.tv.TvFocusIndication

private val Brand = Color(0xFFE5B94E)
private val DarkBg = Color(0xFF0F1420)
private val DarkSurface = Color(0xFF182033)

private val DarkColors = darkColorScheme(
    primary = Brand,
    onPrimary = Color(0xFF1A1200),
    secondary = Brand,
    background = DarkBg,
    onBackground = Color(0xFFE9ECF3),
    surface = DarkSurface,
    onSurface = Color(0xFFE9ECF3),
    surfaceVariant = Color(0xFF232C42),
    onSurfaceVariant = Color(0xFFB9C1D4)
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF7A5A00),
    secondary = Color(0xFF7A5A00)
)

/**
 * Material components (buttons, chips, tabs, the nav rail) draw focus through their ripple's state
 * layer. Its stock focus alpha is a barely-there 10%, so on a TV it is turned right up.
 */
@OptIn(ExperimentalMaterial3Api::class)
private val TvRipple = RippleConfiguration(
    color = Color.White,
    rippleAlpha = RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.38f, hoveredAlpha = 0.16f, pressedAlpha = 0.24f)
)

/**
 * A media app basically wants to be dark; light scheme is kept only as a courtesy.
 * On a TV it is always dark, and focus is drawn big enough to see from across the room.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BeeboEntertainmentTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val context = LocalContext.current
    val isTv = remember { TvDevice.isTv(context) }
    MaterialTheme(
        colorScheme = if (darkTheme || isTv) DarkColors else LightColors
    ) {
        if (isTv) {
            CompositionLocalProvider(
                LocalIsTv provides true,
                LocalIndication provides remember { TvFocusIndication(Brand) },
                LocalRippleConfiguration provides TvRipple,
                content = content
            )
        } else {
            content()
        }
    }
}
