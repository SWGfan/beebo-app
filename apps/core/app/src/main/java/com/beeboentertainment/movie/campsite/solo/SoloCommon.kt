package com.beeboentertainment.movie.campsite.solo

import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.campsite.games.SoloGame
import kotlinx.coroutines.delay
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json

/**
 * Local saving for the solo puzzles: one JSON string per key in the app's existing plain
 * SharedPreferences, the same mechanism the campsite match history uses. No file, no
 * database, no network. A value that fails to parse (an older shape, a damaged write) is
 * treated as absent rather than crashing the game.
 */
internal object SoloStore {
    private val JSON = Json { ignoreUnknownKeys = true; encodeDefaults = true; coerceInputValues = true }

    private fun prefs(): SharedPreferences? = runCatching { BeeboApp.instance.session.plain }.getOrNull()

    fun <T> load(key: String, serializer: KSerializer<T>): T? {
        val raw = runCatching { prefs()?.getString(key, null) }.getOrNull() ?: return null
        return runCatching { JSON.decodeFromString(serializer, raw) }.getOrNull()
    }

    fun <T> save(key: String, serializer: KSerializer<T>, value: T) {
        runCatching { prefs()?.edit()?.putString(key, JSON.encodeToString(serializer, value))?.apply() }
    }

    fun remove(key: String) {
        runCatching { prefs()?.edit()?.remove(key)?.apply() }
    }
}

/** m:ss, or h:mm:ss past an hour. */
internal fun soloClock(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0L)
    val h = total / 3600
    val m = (total / 60) % 60
    val s = total % 60
    return if (h > 0) String.format(java.util.Locale.US, "%d:%02d:%02d", h, m, s)
    else String.format(java.util.Locale.US, "%d:%02d", m, s)
}

/** True when the system "Remove animations" setting is on (animator scale 0). */
internal fun reducedMotion(context: Context): Boolean = runCatching {
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
}.getOrDefault(false)

/**
 * A play clock that only runs while this screen is resumed - a puzzle left open in the
 * background does not keep counting - and while [running] is true. [onTick] receives the
 * whole milliseconds that passed since the last tick.
 */
@Composable
internal fun SoloTicker(running: Boolean, onTick: (Long) -> Unit) {
    val owner = LocalLifecycleOwner.current
    var resumed by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, _ ->
            resumed = owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    val tick by rememberUpdatedState(onTick)
    LaunchedEffect(running, resumed) {
        if (!running || !resumed) return@LaunchedEffect
        var last = System.currentTimeMillis()
        while (true) {
            delay(250)
            val now = System.currentTimeMillis()
            val step = (now - last).coerceIn(0L, 1000L)
            last = now
            tick(step)
        }
    }
}

/** Save when the screen goes to the background or is left, whatever state it is in then. */
@Composable
internal fun SaveOnPause(save: () -> Unit) {
    val owner = LocalLifecycleOwner.current
    val latest by rememberUpdatedState(save)
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) latest()
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            owner.lifecycle.removeObserver(observer)
            latest()
        }
    }
}

/** The row of "How to play" / "Stats" buttons every solo puzzle shows at the top. */
@Composable
internal fun SoloHeaderButtons(game: SoloGame, stats: List<Pair<String, String>>, extra: @Composable () -> Unit = {}) {
    var showRules by remember { mutableStateOf(false) }
    var showStats by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { showRules = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("How to play") }
        OutlinedButton(onClick = { showStats = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Stats") }
        extra()
    }
    if (showRules) {
        AlertDialog(
            onDismissRequest = { showRules = false },
            confirmButton = { TextButton(onClick = { showRules = false }) { Text("Got it") } },
            title = { Text("How to play ${game.title}") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    game.howToPlay.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
            },
        )
    }
    if (showStats) {
        AlertDialog(
            onDismissRequest = { showStats = false },
            confirmButton = { TextButton(onClick = { showStats = false }) { Text("Close") } },
            title = { Text("${game.title} stats") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (stats.isEmpty()) Text("Nothing played yet.")
                    stats.forEach { (label, value) ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                            Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(value, style = MaterialTheme.typography.titleSmall)
                        }
                    }
                    Text(
                        "Saved on this phone only.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
        )
    }
}
