package com.beeboentertainment.movie.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.data.LibraryStatusResponse
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.data.WatchlistAddRequest
import kotlinx.coroutines.launch

/**
 * Which title the personal-library controls act on.
 *
 * [id] is what every one of the library routes takes: for a movie the file id from /api/movies,
 * for a whole show the show key from /api/tvshows. [kind] is "movie" or "tv" - the server folds
 * anything else to "movie", so those are the only two values worth sending.
 */
data class LibraryTarget(
    val kind: String,
    val id: String,
    val title: String,
    val poster: String? = null,
    val stream: String? = null,
    /** Repeated into the watchlist entry for TV so a later reader can tell a show from a film. */
    val showKey: String? = null
)

/** The server treats "show" as a synonym for "tv" in the watchlist; everything else is a movie. */
private fun normalizedKind(kind: String): String = if (kind == "tv" || kind == "show") "tv" else "movie"

/**
 * Favourite / watchlist / watched, as three chips.
 *
 * Absent, not broken, when signed out: every one of these routes needs a bearer token, so with
 * no session there is nothing here at all rather than three controls that answer 401.
 *
 * OPTIMISTIC UI POLICY: confirm-then-fill. A chip does not change state until the server has
 * said it saved. The alternative - fill instantly, revert on failure - hides its own failure on
 * exactly the connection this app spends its life on (a phone reaching a home PC), and a star
 * that flicks back while the reader is already scrolling leaves them believing it saved. The
 * cost is one round trip of a chip that has not moved yet; the chip is disabled while that is in
 * flight, so it reads as "working", not "dead".
 */
@Composable
fun LibraryControlsRow(
    target: LibraryTarget,
    onUnauthorized: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    val app = BeeboApp.instance
    if (!app.session.isLoggedIn) return

    val scope = rememberCoroutineScope()

    var status by remember { mutableStateOf<LibraryStatusResponse?>(null) }
    var onWatchlist by remember { mutableStateOf<Boolean?>(null) }
    var loadFailed by remember { mutableStateOf(false) }
    /** Name of the control with a request in flight, or null. */
    var busy by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var addToPlaylistOpen by remember { mutableStateOf(false) }

    LaunchedEffect(target.kind, target.id) {
        status = null
        onWatchlist = null
        loadFailed = false
        message = null
        busy = null
        try {
            val s = app.api.libraryStatus(target.kind, target.id)
            // Watchlist membership is NOT part of library-status - it lives in its own store on
            // the server - so it costs a second call. The list is capped at 500 tiny entries,
            // which is cheaper than a per-title membership route the server does not have.
            val w = app.api.watchlist()
            status = s
            onWatchlist = w.items.any {
                it.id == target.id && normalizedKind(it.kind) == normalizedKind(target.kind)
            }
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            // Offline is a fact about the connection, not a fault to shout about. One quiet
            // line, and no toggles at all - a toggle whose real state is unknown can only lie.
            loadFailed = true
        }
    }

    /**
     * Run one control's write. [block] applies the state change itself and returns the server's
     * ok. Named `submit` rather than `run` so it cannot shadow kotlin.run inside this function.
     */
    fun submit(control: String, block: suspend () -> Boolean) {
        busy = control
        message = null
        scope.launch {
            try {
                if (!block()) message = "Your server didn't accept that, so nothing was saved."
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                message = "Couldn't reach your server, so nothing was saved."
            } finally {
                busy = null
            }
        }
    }

    val current = status
    val listed = onWatchlist

    Column(modifier.fillMaxWidth()) {
        if (loadFailed) {
            Text(
                "Favourites and watchlist need your server - it isn't answering right now.",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else if (current != null && listed != null) {
            // Nothing is drawn until BOTH answers are in. A chip rendered "off" and corrected a
            // moment later is indistinguishable from one the reader just turned off themselves.
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                FilterChip(
                    selected = current.favorite,
                    enabled = busy == null,
                    onClick = {
                        val next = !current.favorite
                        submit("favourite") {
                            val ok = app.api.setFavorite(target.kind, target.id, next).ok
                            if (ok) status = current.copy(favorite = next)
                            ok
                        }
                    },
                    leadingIcon = {
                        Icon(
                            if (current.favorite) Icons.Filled.Star else Icons.Filled.StarBorder,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp)
                        )
                    },
                    label = { Text("Favourite", fontSize = 12.sp) }
                )
                FilterChip(
                    selected = listed,
                    enabled = busy == null,
                    onClick = {
                        val next = !listed
                        submit("watchlist") {
                            val ok = if (next) {
                                // The server stores this entry verbatim and never derives a
                                // poster or stream of its own, so what is sent here is exactly
                                // what the Watchlist view will have to render later.
                                app.api.addToWatchlist(
                                    WatchlistAddRequest(
                                        id = target.id,
                                        kind = normalizedKind(target.kind),
                                        title = target.title,
                                        poster = target.poster,
                                        stream = target.stream,
                                        showKey = target.showKey
                                    )
                                ).ok
                            } else {
                                app.api.removeFromWatchlist(target.id, normalizedKind(target.kind)).ok
                            }
                            if (ok) onWatchlist = next
                            ok
                        }
                    },
                    leadingIcon = {
                        Icon(
                            if (listed) Icons.Filled.Bookmark else Icons.Filled.BookmarkBorder,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp)
                        )
                    },
                    label = { Text("Watchlist", fontSize = 12.sp) }
                )
                FilterChip(
                    selected = current.watched,
                    enabled = busy == null,
                    onClick = {
                        val next = !current.watched
                        submit("watched") {
                            // A film, or a whole show (every episode in it). Marking watched
                            // takes each covered item out of Continue Watching on the server,
                            // and markTitle mirrors exactly those ids into the phone's Continue
                            // cache and resume marks. Unwatching restores nothing.
                            val ok = WatchedActions.markTitle(app, target.kind, target.id, next).ok
                            if (ok) status = current.copy(watched = next)
                            ok
                        }
                    },
                    leadingIcon = {
                        Icon(
                            if (current.watched) Icons.Filled.CheckCircle
                            else Icons.Filled.RadioButtonUnchecked,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp)
                        )
                    },
                    label = { Text("Watched", fontSize = 12.sp) }
                )
                // Playlists and the play queue: always offered, it needs no status of its own.
                FilterChip(
                    selected = false,
                    onClick = { addToPlaylistOpen = true },
                    label = { Text("＋ Playlist", fontSize = 12.sp) }
                )
            }
        }
        if (addToPlaylistOpen) {
            val isShow = normalizedKind(target.kind) == "tv" && !target.showKey.isNullOrBlank()
            AddToPlaylistDialog(
                ref = com.beeboentertainment.movie.core.PlaylistLogic.refFor(
                    normalizedKind(target.kind), target.id, target.showKey, target.title
                ),
                title = target.title,
                queueItem = if (isShow) null else com.beeboentertainment.movie.core.QueueItem(
                    kind = normalizedKind(target.kind),
                    id = target.id,
                    title = target.title,
                    stream = target.stream,
                    poster = target.poster
                ),
                onUnauthorized = onUnauthorized,
                onDismiss = { addToPlaylistOpen = false }
            )
        }
        message?.let {
            Spacer(Modifier.height(4.dp))
            Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
