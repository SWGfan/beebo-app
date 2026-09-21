package com.beeboentertainment.movie.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.AdminGate
import com.beeboentertainment.movie.data.AdminSummaryResponse
import com.beeboentertainment.movie.ui.LoadingBox
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The admin area.
 *
 * Reached only from the shield action in the app bar, which itself only exists when /api/me says
 * this account is an admin — a non-admin sees no trace of any of it. The API enforces the same
 * rule independently, so this is about not showing someone a door they cannot open.
 *
 * Laid out as a scrollable tab row mirroring the desktop app's tabs, so the owner recognises it.
 */
private enum class AdminTab(val label: String) {
    OVERVIEW("Overview"),
    DASHBOARD("Dashboard"),
    USERS("Users"),
    FAMILY("Family & sharing"),
    REQUESTS("Requests"),
    FLAGS("Flags"),
    MISSING("Missing"),
    CONVERSIONS("Conversions"),
    HISTORY("History"),
    MARKERS("Markers"),
    SETTINGS("Settings")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AdminScreen(onUnauthorized: () -> Unit, onLeave: () -> Unit) {
    val app = BeeboApp.instance

    // Belt and braces: if the flag ever went false while this screen was open, get out.
    if (!AdminGate.canOpenAdmin(app.session.isLoggedIn, app.session.isAdmin)) {
        LaunchedEffect(Unit) { onLeave() }
        return
    }

    var tab by remember { mutableStateOf(AdminTab.OVERVIEW) }

    Column(Modifier.fillMaxSize()) {
        ScrollableTabRow(
            selectedTabIndex = tab.ordinal,
            edgePadding = 8.dp
        ) {
            AdminTab.entries.forEach { entry ->
                Tab(
                    selected = tab == entry,
                    onClick = { tab = entry },
                    text = { Text(entry.label, fontSize = 13.sp) }
                )
            }
        }

        when (tab) {
            AdminTab.OVERVIEW -> AdminOverviewTab(onUnauthorized)
            AdminTab.DASHBOARD -> AdminDashboardTab(onUnauthorized)
            AdminTab.USERS -> AdminUsersTab(onUnauthorized)
            AdminTab.FAMILY -> AdminFamilyTab(onUnauthorized)
            AdminTab.REQUESTS -> AdminRequestsTab(onUnauthorized)
            AdminTab.FLAGS -> AdminFlagsTab(onUnauthorized)
            AdminTab.MISSING -> AdminMissingTab(onUnauthorized)
            AdminTab.CONVERSIONS -> AdminConversionsTab(onUnauthorized)
            AdminTab.HISTORY -> AdminHistoryTab(onUnauthorized)
            AdminTab.MARKERS -> AdminMarkersTab(onUnauthorized)
            AdminTab.SETTINGS -> AdminSettingsTab(onUnauthorized)
        }
    }
}

/* ------------------------------- overview -------------------------------- */

/**
 * The badge counts. The endpoint walks the library, so it is polled at minutes rather than
 * seconds — every 60s while this tab is open, and never in the background.
 */
@Composable
private fun AdminOverviewTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    var summary by remember { mutableStateOf<AdminSummaryResponse?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    val lifecycleOwner = LocalLifecycleOwner.current

    // Only while the app is actually on screen (STARTED): backgrounding the app suspends the
    // loop, and coming back restarts it with a fresh fetch.
    LaunchedEffect(reloadKey) {
        var signedOut = false
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if (signedOut) return@repeatOnLifecycle
            while (true) {
                try {
                    summary = app.api.adminSummary()
                    error = null
                } catch (t: Throwable) {
                    if (isSessionFailure(t)) { signedOut = true; onUnauthorized(); return@repeatOnLifecycle }
                    error = adminErrorMessage(t)
                } finally {
                    loading = false
                }
                // "Poll at minutes, not seconds" — this walks the library on the server.
                delay(60_000)
            }
        }
    }

    val data = summary
    when {
        loading && data == null -> LoadingBox()
        error != null && data == null -> AdminErrorPanel(error!!) { reloadKey++ }
        data == null -> AdminErrorPanel("No summary available.") { reloadKey++ }
        else -> LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 150.dp),
            contentPadding = PaddingValues(10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxSize()
        ) {
            item {
                AdminStatCard(
                    label = "Users",
                    value = data.users.total.toString(),
                    detail = "${data.users.pending} awaiting email · ${data.users.revoked} revoked"
                )
            }
            item {
                AdminStatCard(
                    label = "Access requests",
                    value = data.requests.pending.toString(),
                    detail = "waiting for a decision",
                    highlight = data.requests.pending > 0
                )
            }
            item {
                AdminStatCard(
                    label = "Quality flags",
                    value = data.flags.unresolved.toString(),
                    detail = "unresolved",
                    highlight = data.flags.unresolved > 0
                )
            }
            item {
                AdminStatCard(
                    label = "Missing files",
                    value = data.missing.unresolved.toString(),
                    detail = "requested but not on disk",
                    highlight = data.missing.unresolved > 0
                )
            }
            item {
                AdminStatCard(
                    label = "Conversions",
                    value = "${data.conversions.queued + data.conversions.converting}",
                    detail = "${data.conversions.converting} running · " +
                        "${data.conversions.done} done · ${data.conversions.error} failed",
                    highlight = data.conversions.error > 0
                )
            }
            item {
                AdminStatCard(
                    label = "Library",
                    value = "${data.library.movies}",
                    detail = "movies · ${data.library.shows} shows · ${data.library.episodes} episodes"
                )
            }
            item {
                AdminStatCard(
                    label = "Converted on disk",
                    value = adminFormatBytes(data.storage.convertedBytes),
                    detail = "originals still kept: ${adminFormatBytes(data.storage.originalBytes)}"
                )
            }
            item {
                AdminStatCard(
                    label = "HTTPS",
                    value = if (data.https.active) "On" else "Off",
                    detail = data.https.daysRemaining?.let { "$it days left on the certificate" }
                        ?: "no certificate loaded",
                    highlight = !data.https.active
                )
            }
            item {
                Column(Modifier.padding(4.dp)) {
                    if (error != null) {
                        Text(
                            error!!,
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                    TextButton(onClick = { reloadKey++ }) { Text("Refresh now") }
                }
            }
        }
    }
}

/* --------------------------------- users --------------------------------- */

@Composable
private fun AdminUsersTab(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    val scope = rememberCoroutineScope()

    var users by remember { mutableStateOf<List<com.beeboentertainment.movie.data.AdminUser>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var pending by remember { mutableStateOf<PendingUserAction?>(null) }
    var codeToShow by remember { mutableStateOf<Pair<String, String>?>(null) }

    LaunchedEffect(reloadKey) {
        loading = true
        try {
            users = app.api.adminUsers().users
            error = null
        } catch (t: Throwable) {
            if (isSessionFailure(t)) { onUnauthorized(); return@LaunchedEffect }
            error = adminErrorMessage(t)
        } finally {
            loading = false
        }
    }

    fun run(action: PendingUserAction) {
        scope.launch {
            try {
                val r = when (action.type) {
                    UserActionType.APPROVE -> app.api.adminApproveUser(action.user.id)
                    UserActionType.REACTIVATE -> app.api.adminReactivateUser(action.user.id)
                    UserActionType.REVOKE -> app.api.adminRevokeUser(action.user.id)
                    UserActionType.MAKE_ADMIN -> app.api.adminSetAdmin(action.user.id, true)
                    UserActionType.DROP_ADMIN -> app.api.adminSetAdmin(action.user.id, false)
                    UserActionType.REGENERATE -> app.api.adminRegenerateCode(action.user.id)
                }
                if (!r.ok) {
                    // last_admin and friends arrive as 200 {ok:false} — surface, never swallow.
                    notice = com.beeboentertainment.movie.core.AdminErrors.message(r.error)
                } else {
                    r.code?.let { codeToShow = it to action.user.name }
                    notice = when {
                        r.unchanged -> "${action.user.name} was already approved."
                        else -> action.successMessage
                    }
                    reloadKey++
                }
            } catch (t: Throwable) {
                if (isSessionFailure(t)) onUnauthorized() else notice = adminErrorMessage(t)
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        notice?.let {
            Text(
                it,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)
            )
        }
        when {
            loading && users.isEmpty() -> LoadingBox()
            error != null && users.isEmpty() -> AdminErrorPanel(error!!) { reloadKey++ }
            users.isEmpty() -> AdminErrorPanel("No accounts yet.") { reloadKey++ }
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(users, key = { it.id }) { user ->
                    AdminRowCard(
                        title = "${user.name}${if (user.isAdmin) "  ★ admin" else ""}",
                        subtitle = "@${user.username} · ${user.email}",
                        detail = "${user.statusLabel} · last seen ${adminFormatTime(user.lastSeenAt)}" +
                            (user.lastSeenIp?.let { " from $it" } ?: "")
                    ) {
                        if (user.isPending) {
                            TextButton(onClick = {
                                pending = PendingUserAction(
                                    user, UserActionType.APPROVE,
                                    "Approve ${user.name}?",
                                    "This turns their signup into a working account.",
                                    "Approve", false, "${user.name} approved."
                                )
                            }) { Text("Approve") }
                        }
                        if (user.isRevoked) {
                            TextButton(onClick = {
                                pending = PendingUserAction(
                                    user, UserActionType.REACTIVATE,
                                    "Let ${user.name} back in?",
                                    "Their account becomes active again immediately.",
                                    "Reactivate", false, "${user.name} reactivated."
                                )
                            }) { Text("Reactivate") }
                        }
                        if (user.isApproved) {
                            TextButton(onClick = {
                                pending = PendingUserAction(
                                    user, UserActionType.REVOKE,
                                    "Revoke ${user.name}?",
                                    "They lose access straight away — their phone stops working " +
                                        "on its very next request. You can reactivate them later.",
                                    "Revoke", true, "${user.name} revoked."
                                )
                            }) { Text("Revoke") }
                        }
                        TextButton(onClick = {
                            val makeAdmin = !user.isAdmin
                            pending = PendingUserAction(
                                user,
                                if (makeAdmin) UserActionType.MAKE_ADMIN else UserActionType.DROP_ADMIN,
                                if (makeAdmin) "Make ${user.name} an admin?" else "Remove ${user.name}'s admin?",
                                if (makeAdmin) "They'll be able to manage accounts, files and settings."
                                else "They'll lose access to the admin tools.",
                                if (makeAdmin) "Make admin" else "Remove admin",
                                !makeAdmin,
                                if (makeAdmin) "${user.name} is now an admin." else "${user.name} is no longer an admin."
                            )
                        }) { Text(if (user.isAdmin) "Un-admin" else "Make admin") }
                        TextButton(onClick = {
                            pending = PendingUserAction(
                                user, UserActionType.REGENERATE,
                                "New access code for ${user.name}?",
                                "Their current code stops working immediately. The new one is " +
                                    "shown once and can't be looked up again.",
                                "Generate", true, "New code generated."
                            )
                        }) { Text("New code") }
                    }
                }
            }
        }
    }

    pending?.let { action ->
        AdminConfirmDialog(
            title = action.title,
            message = action.message,
            confirmLabel = action.confirmLabel,
            destructive = action.destructive,
            onConfirm = { run(action) },
            onDismiss = { pending = null }
        )
    }

    codeToShow?.let { (code, name) ->
        AdminCodeDialog(code = code, forName = name, onDismiss = { codeToShow = null })
    }
}

private enum class UserActionType { APPROVE, REACTIVATE, REVOKE, MAKE_ADMIN, DROP_ADMIN, REGENERATE }

private data class PendingUserAction(
    val user: com.beeboentertainment.movie.data.AdminUser,
    val type: UserActionType,
    val title: String,
    val message: String,
    val confirmLabel: String,
    val destructive: Boolean,
    val successMessage: String
)
