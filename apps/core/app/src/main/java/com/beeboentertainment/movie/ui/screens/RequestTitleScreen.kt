package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.TitleRequestLogic
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.TitleRequest
import com.beeboentertainment.movie.data.TitleSearchResult
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.ui.ConfirmDialog
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.RequestNoteDialog
import com.beeboentertainment.movie.ui.dpadFocusRing
import kotlinx.coroutines.launch

/**
 * "Request a title": search TMDB through the Beebo server, pick a film or a show, add a note.
 * The second tab lists your requests with their status; the owner sees everyone's and is the
 * only one offered Dismiss. Everything is enforced again on the server.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestTitleScreen(
    onUnauthorized: () -> Unit,
    /** Browse's search that found nothing: the search box starts filled in and runs at once. */
    initialQuery: String = "",
    initialKind: TitleRequestLogic.Kind = TitleRequestLogic.Kind.ALL
) {
    val app = BeeboApp.instance
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current

    var tab by rememberSaveable { mutableStateOf(0) }

    // --- search ---
    var query by rememberSaveable { mutableStateOf(initialQuery) }
    var kindName by rememberSaveable { mutableStateOf(initialKind.name) }
    val kind = TitleRequestLogic.Kind.valueOf(kindName)
    var results by remember { mutableStateOf<List<TitleSearchResult>>(emptyList()) }
    var searched by remember { mutableStateOf(false) }
    var searching by remember { mutableStateOf(false) }
    var searchError by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }

    // --- the request dialog ---
    var requestFor by remember { mutableStateOf<TitleSearchResult?>(null) }
    var requestBusy by remember { mutableStateOf(false) }
    var requestError by remember { mutableStateOf<String?>(null) }

    // --- my requests ---
    var requests by remember { mutableStateOf<List<TitleRequest>>(emptyList()) }
    var canDismiss by remember { mutableStateOf(false) }
    var requestsLoading by remember { mutableStateOf(true) }
    var requestsError by remember { mutableStateOf<String?>(null) }
    var requestsReload by remember { mutableStateOf(0) }
    var dismissFor by remember { mutableStateOf<TitleRequest?>(null) }

    fun runSearch() {
        if (!TitleRequestLogic.canSearch(query)) {
            searchError = "Type at least two letters to search."
            return
        }
        focus.clearFocus()
        searching = true
        searchError = null
        notice = null
        scope.launch {
            try {
                val r = app.api.titleSearch(query, kind.param)
                if (!r.ok) {
                    searchError = com.beeboentertainment.movie.core.AdminErrors.message(r.error)
                    results = emptyList()
                } else {
                    results = r.items
                }
                searched = true
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                searchError = e.message ?: "Search didn't work just now."
            } finally {
                searching = false
            }
        }
    }

    // Prefilled from Browse: search straight away, once.
    var prefillRun by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (!prefillRun && TitleRequestLogic.canSearch(initialQuery)) {
            prefillRun = true
            runSearch()
        }
    }

    // Loaded when the tab is first shown and whenever it's reopened, so an "added" status is fresh.
    LaunchedEffect(tab, requestsReload) {
        if (tab != 1) return@LaunchedEffect
        requestsLoading = requests.isEmpty()
        requestsError = null
        try {
            val r = app.api.titleRequests()
            requests = TitleRequestLogic.sorted(r.items)
            canDismiss = r.canDismiss
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            requestsError = e.message ?: "Couldn't load your requests."
        } finally {
            requestsLoading = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        TabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Search") })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text(if (canDismiss || app.session.isAdmin) "All requests" else "My requests") })
        }

        if (tab == 0) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it; searchError = null },
                    label = { Text("Film or TV show") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { runSearch() }),
                    modifier = Modifier.weight(1f)
                )
                IconButton(
                    onClick = { runSearch() },
                    enabled = !searching,
                    modifier = Modifier.dpadFocusRing(RoundedCornerShape(50))
                ) {
                    Icon(Icons.Filled.Search, contentDescription = "Search")
                }
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                TitleRequestLogic.Kind.entries.forEach { k ->
                    FilterChip(
                        selected = k == kind,
                        onClick = {
                            kindName = k.name
                            if (searched && TitleRequestLogic.canSearch(query)) runSearch()
                        },
                        label = { Text(k.label) }
                    )
                }
            }
            notice?.let {
                Text(it, color = MaterialTheme.colorScheme.primary, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp))
            }
            when {
                searching -> LoadingBox()
                searchError != null -> ErrorBox(searchError!!, onRetry = if (TitleRequestLogic.canSearch(query)) ({ runSearch() }) else null)
                !searched -> EmptyBox("Search for a film or a TV show that isn't in the library, and ask for it.")
                results.isEmpty() -> EmptyBox("Nothing found for \"$query\".")
                else -> LazyColumn(contentPadding = PaddingValues(8.dp), modifier = Modifier.fillMaxSize()) {
                    items(results, key = { it.kind + it.tmdbId }) { r ->
                        val action = TitleRequestLogic.resultAction(r)
                        ResultRow(
                            title = r.title,
                            subtitle = TitleRequestLogic.resultSubtitle(r),
                            detail = r.overview,
                            posterUrl = r.tmdbPoster,
                            actionLabel = TitleRequestLogic.resultButtonLabel(action),
                            actionable = TitleRequestLogic.isActionable(action),
                            onAction = {
                                requestError = null
                                requestFor = r
                            }
                        )
                    }
                }
            }
        } else {
            when {
                requestsLoading -> LoadingBox()
                requestsError != null -> ErrorBox(requestsError!!, onRetry = { requestsReload++ })
                requests.isEmpty() -> EmptyBox(
                    if (canDismiss) "Nobody has asked for anything yet." else "You haven't asked for anything yet. Search for a title to request it."
                )
                else -> LazyColumn(contentPadding = PaddingValues(8.dp), modifier = Modifier.fillMaxSize()) {
                    items(requests, key = { it.id }) { req ->
                        RequestRow(
                            request = req,
                            baseUrl = app.session.baseUrl,
                            showDismiss = TitleRequestLogic.canDismiss(canDismiss, req),
                            onDismiss = { dismissFor = req }
                        )
                    }
                }
            }
        }
    }

    val pending = requestFor
    if (pending != null) {
        RequestNoteDialog(
            title = pending.title,
            subtitle = TitleRequestLogic.resultSubtitle(pending),
            posterUrl = pending.tmdbPoster,
            busy = requestBusy,
            error = requestError,
            onSubmit = { note ->
                requestBusy = true
                requestError = null
                scope.launch {
                    try {
                        val r = app.api.requestTitle(TitleRequestLogic.create(pending, note))
                        results = TitleRequestLogic.markResultRequested(results, pending.kind, pending.tmdbId, r.request)
                        requests = TitleRequestLogic.upsert(requests, r.request)
                        notice = TitleRequestLogic.successMessage(pending.title, r.created, r.deduped, r.appended)
                        requestFor = null
                    } catch (e: UnauthorizedException) {
                        requestFor = null
                        onUnauthorized()
                    } catch (e: Exception) {
                        requestError = e.message ?: "Couldn't send the request."
                    } finally {
                        requestBusy = false
                    }
                }
            },
            onDismiss = { requestFor = null }
        )
    }

    val toDismiss = dismissFor
    if (toDismiss != null) {
        ConfirmDialog(
            title = "Dismiss this request?",
            message = "\"${toDismiss.title}\" will show as declined to whoever asked for it. Nothing on disk is touched.",
            confirmLabel = "Dismiss",
            onConfirm = {
                scope.launch {
                    try {
                        val r = app.api.dismissTitleRequest(toDismiss.id)
                        requests = TitleRequestLogic.sorted(TitleRequestLogic.upsert(requests, r.request))
                    } catch (e: UnauthorizedException) {
                        onUnauthorized()
                    } catch (e: Exception) {
                        requestsError = e.message ?: "Couldn't dismiss that request."
                    }
                }
            },
            onDismiss = { dismissFor = null }
        )
    }
}

@Composable
private fun Thumb(url: String?, title: String) {
    Box(
        Modifier
            .width(46.dp)
            .height(69.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center
    ) {
        if (url != null) {
            AsyncImage(model = url, contentDescription = title, modifier = Modifier.fillMaxSize())
        } else {
            Icon(Icons.Filled.Movie, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ResultRow(
    title: String,
    subtitle: String,
    detail: String?,
    posterUrl: String?,
    actionLabel: String,
    actionable: Boolean,
    onAction: () -> Unit
) {
    // The whole row is the D-pad target when it can be requested; otherwise it is plain text.
    val rowModifier = if (actionable) {
        Modifier
            .dpadFocusRing()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onAction)
    } else Modifier
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp)
            .then(rowModifier)
            .padding(6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Thumb(posterUrl, title)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(subtitle, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!detail.isNullOrBlank()) {
                Text(detail, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.width(8.dp))
        if (actionable) {
            // Not separately focusable: the row already is, so the remote needs one press, not two.
            Button(onClick = onAction, modifier = Modifier.focusProperties { canFocus = false }) { Text(actionLabel) }
        } else {
            StatusPill(actionLabel, positive = actionLabel == "In library" || actionLabel == "Added")
        }
    }
}

@Composable
private fun StatusPill(text: String, positive: Boolean) {
    Surface(
        color = if (positive) Color(0xFF1F2A1F) else MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(50)
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = if (positive) Color(0xFF7BD88F) else MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun RequestRow(
    request: TitleRequest,
    baseUrl: String?,
    showDismiss: Boolean,
    onDismiss: () -> Unit
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp)
            // Focusable even without an action, so a TV remote can scroll through the list.
            .dpadFocusRing()
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = true, onClick = { if (showDismiss) onDismiss() })
            .padding(6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Thumb(UrlUtils.join(baseUrl, request.poster), request.title)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(request.title, fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(TitleRequestLogic.requestSubtitle(request), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            request.note?.let {
                Text("Your note: $it", fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            TitleRequestLogic.requestersLine(request)?.let {
                Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            request.requesters.filter { !it.note.isNullOrBlank() && !(request.mine && it.note == request.note) }.forEach {
                Text("“${it.note}” — ${it.name}", fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(8.dp))
        Column(horizontalAlignment = Alignment.End) {
            StatusPill(TitleRequestLogic.statusLabel(request.status), positive = request.status == "added")
            if (showDismiss) {
                Spacer(Modifier.height(6.dp))
                OutlinedButton(onClick = onDismiss, modifier = Modifier.focusProperties { canFocus = false }) { Text("Dismiss") }
            }
        }
    }
}
