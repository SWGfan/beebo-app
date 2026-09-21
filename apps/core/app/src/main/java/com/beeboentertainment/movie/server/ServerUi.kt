package com.beeboentertainment.movie.server

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.data.UnauthorizedException
import kotlinx.coroutines.CancellationException

/** One load with the usual loading / error / signed-out handling, shared by the new screens. */
class Loaded<T>(val value: T?, val loading: Boolean, val error: String?)

@Composable
fun <T> rememberServerLoad(key: Any?, onUnauthorized: () -> Unit, reload: Int = 0, load: suspend () -> T): Loaded<T> {
    var value by remember(key) { mutableStateOf<T?>(null) }
    var loading by remember(key) { mutableStateOf(true) }
    var error by remember(key) { mutableStateOf<String?>(null) }
    LaunchedEffect(key, reload) {
        loading = true
        error = null
        try {
            value = load()
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: "That didn't load."
        } finally {
            loading = false
        }
    }
    return Loaded(value, loading, error)
}

/**
 * What the connected server can do, re-asked when stale. Screens that hide behind a feature read
 * [ServerFeatures.Snapshot.has]; nothing is shown before the first answer, so a section never
 * flashes up and then disappears.
 */
@Composable
fun rememberServerFeatures(): State<ServerFeatures.Snapshot> {
    val app = BeeboApp.instance
    val key = "${app.session.baseUrl}|${app.session.userId}|${app.session.isLoggedIn}"
    LaunchedEffect(key) {
        if (app.session.isLoggedIn && !app.session.demoMode) {
            if (ServerFeatures.isStale(System.currentTimeMillis()) || ServerFeatures.state.value.byFeature.isEmpty()) {
                ServerFeatures.refresh(ServerJson.get(), key)
            }
        } else {
            ServerFeatures.clear()
        }
    }
    return ServerFeatures.state.collectAsState()
}
