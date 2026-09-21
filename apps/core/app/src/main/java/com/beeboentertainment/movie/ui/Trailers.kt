package com.beeboentertainment.movie.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.TrailerLogic
import com.beeboentertainment.movie.data.UnauthorizedException
import kotlinx.coroutines.launch

/** Opens [url] in whatever app handles it (the browser, usually). False when nothing can. */
fun openExternalUrl(context: Context, url: String): Boolean = try {
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
} catch (_: ActivityNotFoundException) {
    false
} catch (_: SecurityException) {
    false
}

/** YouTube app first, then the web page. Same on a phone and on Android TV. */
fun openYouTube(context: Context, key: String): Boolean =
    TrailerLogic.launchOrder(key).any { openExternalUrl(context, it) }

/**
 * A function that looks a title's trailer up on the server and plays it on YouTube, or shows
 * "No trailer found". One lookup at a time; a second tap while one is running is ignored.
 */
@Composable
fun rememberTrailerOpener(onUnauthorized: () -> Unit = {}): (kind: String, tmdbId: Int?) -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    return remember(context) {
        var busy = false
        val open: (String, Int?) -> Unit = open@{ kind, tmdbId ->
            if (busy) return@open
            // Trailers are off for a profile with parental controls and for a shared-library guest.
            if (!com.beeboentertainment.movie.core.ProfileLimits.of(com.beeboentertainment.movie.BeeboApp.instance.session.isAdmin, com.beeboentertainment.movie.BeeboApp.instance.session.isRestricted, com.beeboentertainment.movie.BeeboApp.instance.session.isGuest).showTrailers) return@open
            if (!TrailerLogic.canShow(tmdbId)) {
                Toast.makeText(context, TrailerLogic.NO_TRAILER, Toast.LENGTH_SHORT).show()
                return@open
            }
            busy = true
            scope.launch {
                try {
                    val key = BeeboApp.instance.api.trailer(kind, tmdbId!!).youtubeKey
                    if (key == null || !openYouTube(context, key)) {
                        Toast.makeText(context, TrailerLogic.NO_TRAILER, Toast.LENGTH_SHORT).show()
                    }
                } catch (e: UnauthorizedException) {
                    onUnauthorized()
                } catch (e: Exception) {
                    // An older server (404) or no connection: the same short answer.
                    Toast.makeText(context, TrailerLogic.NO_TRAILER, Toast.LENGTH_SHORT).show()
                } finally {
                    busy = false
                }
            }
        }
        open
    }
}
