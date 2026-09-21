package com.beeboentertainment.movie.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.DistributionPolicy
import com.beeboentertainment.movie.core.ConnectionDoctor
import com.beeboentertainment.movie.core.PairLink
import com.beeboentertainment.movie.core.PairLinks
import com.beeboentertainment.movie.core.PairMessages
import com.beeboentertainment.movie.core.PairParse
import com.beeboentertainment.movie.core.PairRequests
import com.beeboentertainment.movie.core.SecondStep
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.scan.QrScanResult
import com.beeboentertainment.movie.scan.rememberQrScanner
import com.beeboentertainment.movie.hub.HubAuth
import com.beeboentertainment.movie.hub.HubException
import com.beeboentertainment.movie.hub.ServerResolution
import com.beeboentertainment.movie.rtc.HomeEntry
import com.beeboentertainment.movie.rtc.RemoteAccess
import com.beeboentertainment.movie.rtc.RemoteMessages
import com.beeboentertainment.movie.rtc.RemoteSignIn
import com.beeboentertainment.movie.rtc.SignInPlan
import com.beeboentertainment.movie.rtc.TunnelConnection
import kotlinx.coroutines.launch
import com.beeboentertainment.movie.tvpair.TvPairMessages
import com.beeboentertainment.movie.tvpair.TvPairing
import com.beeboentertainment.movie.ui.tv.DpadTextField
import com.beeboentertainment.movie.ui.tv.LocalIsTv
import androidx.compose.ui.focus.FocusRequester

/**
 * The ONE sign-in screen, at home and away:
 *
 *   Home      the paying account's email, or the home's name (nick / nick.beebo.tv),
 *             or, as before, a server address
 *   Username  your own username on the home Beebo
 *   Password  your own password (or access code) on the home Beebo
 *
 * At home (Wi-Fi, and the app knows the computer's address) it signs in to the computer
 * directly. Away, it signs in through beebo.tv with the same username and password, connects
 * peer-to-peer ("Connecting to your home..."), and the home computer signs the same person in:
 * there is no second login, and nobody needs the paying account's password. The owner can still
 * use the account email and password through the "Owner sign-in" link, on this same screen.
 */
@Composable
fun SetupScreen(
    onServerAccepted: () -> Unit,
    onExploreWithoutServer: () -> Unit = {}
) {
    // On a TV, typing with a remote is the fallback: the code to enter on a phone comes first.
    val isTv = LocalIsTv.current
    var typed by remember { mutableStateOf(!TvPairing.offersPhoneSignIn(isTv)) }
    if (!typed) {
        TvPairSignIn(
            onSignedIn = onServerAccepted,
            onTypeInstead = { typed = true },
            onExploreWithoutServer = onExploreWithoutServer,
        )
        return
    }
    TypedSignIn(onServerAccepted, onExploreWithoutServer, onUsePhone = if (isTv) ({ typed = false }) else null)
}

/**
 * A password that was right for an account with two-factor on, waiting for its code. Only the
 * short-lived challenge is kept (never a session); [directBaseUrl] is null for the away-from-home
 * path, which finishes over the tunnel it already opened.
 */
private data class PendingSecondStep(
    val challenge: String,
    val directBaseUrl: String?,
    val entry: HomeEntry,
    val signIn: RemoteSignIn,
)

@Composable
private fun TypedSignIn(
    onServerAccepted: () -> Unit,
    onExploreWithoutServer: () -> Unit,
    onUsePhone: (() -> Unit)?,
) {
    val app = BeeboApp.instance
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val saved = remember { RemoteAccess.savedSignIn() }

    var ownerMode by remember { mutableStateOf(saved?.kind == RemoteSignIn.Kind.OWNER) }
    var home by remember {
        mutableStateOf(
            saved?.home
                ?: app.session.baseUrl?.let { UrlUtils.beeboTvName(it) ?: it }
                ?: ""
        )
    }
    var username by remember { mutableStateOf(saved?.takeIf { it.kind == RemoteSignIn.Kind.MEMBER }?.id ?: "") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showConnectionTest by remember { mutableStateOf(false) }
    val tunnel by RemoteAccess.status.collectAsState()

    // The QR code / link from the computer: it only fills Home in. Nothing is signed in or saved by it.
    var pairedServer by remember { mutableStateOf<String?>(null) }
    var pairNote by remember { mutableStateOf<String?>(null) }
    var pendingConfirm by remember { mutableStateOf<PairLink?>(null) }
    var showHelp by remember { mutableStateOf(false) }
    var lastLoginHttp by remember { mutableStateOf<Int?>(null) }
    // Set when the password was right and this account has two-factor on: the code prompt shows instead.
    var secondStep by remember { mutableStateOf<PendingSecondStep?>(null) }
    val clipboard = LocalClipboardManager.current

    fun applyPair(link: PairLink) {
        // The house name wins for Home, so the same sign-in works away from home too; the scanned
        // address is only what is tried first when the phone is on the home Wi-Fi.
        home = link.houseName ?: link.server
        pairedServer = if (link.trust == com.beeboentertainment.movie.core.ServerTrust.BEEBO_TV) null else link.server
        ownerMode = false
        error = null
        pairNote = "Found your Beebo at ${link.houseName ?: link.server}. Now type your username and password."
    }
    fun handlePairText(text: String?) {
        when (val r = PairLinks.parse(text)) {
            is PairParse.Ok -> if (PairMessages.confirmation(r.link) != null) pendingConfirm = r.link else applyPair(r.link)
            is PairParse.Rejected -> { pairNote = null; error = PairMessages.problem(r.problem) }
        }
    }
    val scanner = rememberQrScanner { result ->
        when (result) {
            is QrScanResult.Text -> handlePairText(result.value)
            is QrScanResult.Cancelled -> {}
            is QrScanResult.Unavailable -> { pairNote = null; error = result.message }
        }
    }
    // A beebo://pair link that opened the app (cold start) or arrived while it was open (warm start).
    val incomingPair by PairRequests.pending.collectAsState()
    LaunchedEffect(incomingPair) {
        val text = incomingPair ?: return@LaunchedEffect
        val fresh = PairRequests.isFresh()
        PairRequests.consume()
        if (fresh) handlePairText(text)
    }

    var hubEmail by remember { mutableStateOf("") }
    var hubPassword by remember { mutableStateOf("") }
    // The Beebo hub is an older way to find a home server. It stays out of the way unless this phone already uses it.
    var showAdvanced by remember { mutableStateOf(!app.session.hubToken.isNullOrBlank()) }
    // "Show password": typing a long password blind on a phone is where most sign-ins go wrong.
    var showPassword by remember { mutableStateOf(false) }
    var showHubPassword by remember { mutableStateOf(false) }

    // Android TV: start the remote on the Home box (select opens the keyboard).
    val isTv = LocalIsTv.current
    val firstField = remember { FocusRequester() }
    if (isTv) androidx.compose.runtime.LaunchedEffect(Unit) { runCatching { firstField.requestFocus() } }

    fun finishDirect(baseUrl: String, token: String, user: com.beeboentertainment.movie.data.User?) {
        app.session.saveLogin(token, user)
        onServerAccepted()
    }

    fun submit() {
        error = null
        showConnectionTest = false
        lastLoginHttp = null
        if (ownerMode) {
            if (!home.contains('@') || password.isBlank()) { error = "Enter the Beebo account email and password."; return }
        } else if (home.isBlank() || username.isBlank() || password.isBlank()) {
            error = "Fill in all three boxes."; return
        }
        val entry = if (ownerMode) HomeEntry.Email(home.trim().lowercase()) else HomeEntry.parse(home)
        if (entry is HomeEntry.Invalid) { error = "Home should be your home's name (like thesmiths), thesmiths.beebo.tv, or the account email."; return }

        busy = true
        scope.launch {
            try {
                val signIn = if (ownerMode) RemoteSignIn(RemoteSignIn.Kind.OWNER, home.trim().lowercase(), home.trim().lowercase(), password)
                else RemoteSignIn(RemoteSignIn.Kind.MEMBER, home.trim(), username.trim(), password)
                val steps = if (ownerMode) listOf(SignInPlan.Step.Remote)
                else SignInPlan.steps(entry, pairedServer ?: app.session.directBaseUrl, RemoteAccess.currentNetwork)

                for (step in steps) {
                    when (step) {
                        is SignInPlan.Step.Direct -> {
                            val result = runCatching { app.api.login(username.trim(), password, step.baseUrl) }
                            val r = result.getOrNull()
                            if (r != null && r.needsSecondStep) {
                                // Right password, two-factor on: ask for the code before anything is saved.
                                secondStep = PendingSecondStep(r.challenge.orEmpty(), step.baseUrl, entry, signIn)
                                return@launch
                            }
                            if (r != null && r.ok && !r.token.isNullOrBlank()) {
                                if (entry is HomeEntry.Address) {
                                    RemoteAccess.onBaseUrlChanged(step.baseUrl)
                                    app.session.baseUrl = step.baseUrl
                                } else {
                                    RemoteAccess.rememberForLater(signIn, step.baseUrl)
                                }
                                finishDirect(step.baseUrl, r.token, r.user)
                                return@launch
                            }
                            if (r != null && !r.ok && r.error == "bad_credentials") lastLoginHttp = 401
                            if (entry is HomeEntry.Address) {
                                error = r?.failureMessage() ?: result.exceptionOrNull()?.message ?: "Couldn't reach that server."
                                return@launch
                            }
                            // A name or email: the computer isn't answering here, so try away from home.
                        }
                        is SignInPlan.Step.Remote -> {
                            when (val r = RemoteAccess.signIn(signIn)) {
                                is RemoteAccess.SignInResult.SignedIn -> { onServerAccepted(); return@launch }
                                is RemoteAccess.SignInResult.Refused -> {
                                    val challenge = r.secondStepChallenge
                                    if (challenge != null) secondStep = PendingSecondStep(challenge, null, entry, signIn)
                                    else error = r.message
                                    return@launch
                                }
                                is RemoteAccess.SignInResult.NotConnected -> {
                                    error = r.message
                                    showConnectionTest = r.showConnectionTest
                                    return@launch
                                }
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                error = e.message ?: "Couldn't sign in."
            } finally {
                busy = false
            }
        }
    }

    /** The code box's answer: finish exactly the way the password step would have. */
    fun submitCode(pending: PendingSecondStep, entry: SecondStep.Entry) {
        val code = SecondStep.codeToSend(entry) ?: return
        error = null
        busy = true
        scope.launch {
            try {
                val direct = pending.directBaseUrl
                if (direct != null) {
                    when (val o = SecondStep.outcome(app.api.loginSecondStep(pending.challenge, code, direct))) {
                        is SecondStep.Outcome.SignedIn -> {
                            if (pending.entry is HomeEntry.Address) {
                                RemoteAccess.onBaseUrlChanged(direct)
                                app.session.baseUrl = direct
                            } else {
                                RemoteAccess.rememberForLater(pending.signIn, direct)
                            }
                            finishDirect(direct, o.token, o.user)
                        }
                        is SecondStep.Outcome.TryAgain -> error = o.message
                        is SecondStep.Outcome.StartOver -> { secondStep = null; password = ""; error = o.message }
                        is SecondStep.Outcome.Locked -> error = o.message
                        is SecondStep.Outcome.Failed -> error = o.message
                    }
                } else {
                    when (val r = RemoteAccess.completeSecondStep(pending.challenge, code)) {
                        is RemoteAccess.SignInResult.SignedIn -> onServerAccepted()
                        is RemoteAccess.SignInResult.Refused -> {
                            if (r.secondStepChallenge != null) error = r.message
                            else { secondStep = null; password = ""; error = r.message }
                        }
                        is RemoteAccess.SignInResult.NotConnected -> error = r.message
                    }
                }
            } catch (e: Exception) {
                error = e.message ?: "Couldn't sign in."
            } finally {
                busy = false
            }
        }
    }

    val pendingSecond = secondStep
    if (pendingSecond != null) {
        TwoFactorPrompt(
            busy = busy,
            error = error,
            onSubmit = { entry -> submitCode(pendingSecond, entry) },
            onCancel = { secondStep = null; password = ""; error = null },
        )
        return
    }

    pendingConfirm?.let { link ->
        AlertDialog(
            onDismissRequest = { pendingConfirm = null },
            title = { Text("Use this code?") },
            text = { Text(PairMessages.confirmation(link).orEmpty()) },
            confirmButton = { TextButton(onClick = { pendingConfirm = null; applyPair(link) }) { Text("Use it") } },
            dismissButton = { TextButton(onClick = { pendingConfirm = null }) { Text("Cancel") } },
        )
    }

    if (showHelp) {
        ConnectionHelpScreen(
            target = ConnectionDoctor.targetFor(home, pairedServer, RemoteAccess.currentNetwork),
            lastLoginHttp = lastLoginHttp,
            onClose = { showHelp = false },
        )
        return
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("Beebo Entertainment", fontSize = 32.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(8.dp))
        Text(
            if (ownerMode) "Sign in with the Beebo account that pays for your home Beebo."
            else "Sign in once, at home or away. Use the same username and password as Beebo at home.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 14.sp
        )
        Spacer(Modifier.height(20.dp))

        // The fastest way in: scan the code Beebo shows on the computer (or paste its link). No camera on a TV.
        if (!isTv && !ownerMode) {
            Button(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { scanner.start() }) { Text("Scan QR code") }
            TextButton(enabled = !busy, onClick = {
                val text = clipboard.getText()?.text
                if (text.isNullOrBlank()) { pairNote = null; error = "Nothing to paste yet. Copy the link from Beebo on your computer first." } else handlePairText(text)
            }) { Text("Paste a link instead", fontSize = 13.sp) }
            pairNote?.let {
                Text(it, color = MaterialTheme.colorScheme.primary, fontSize = 14.sp)
                Spacer(Modifier.height(8.dp))
            }
        }

        // On a TV each box opens the keyboard on select, not whenever the D-pad passes over it;
        // the remote starts on the Home box.
        DpadTextField(Modifier.fillMaxWidth(), frameFocusRequester = firstField) { tv ->
            OutlinedTextField(
                value = home,
                onValueChange = { home = it; error = null; pairedServer = null; pairNote = null },
                label = { Text(if (ownerMode) "Beebo account email" else "Home") },
                supportingText = if (ownerMode) null else ({ Text("Your home's name (like thesmiths or thesmiths.beebo.tv), or the email of whoever pays for Beebo") }),
                singleLine = true,
                enabled = !busy,
                modifier = tv.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = if (ownerMode) KeyboardType.Email else KeyboardType.Uri, imeAction = ImeAction.Next)
            )
        }
        if (!ownerMode) {
            Spacer(Modifier.height(8.dp))
            DpadTextField(Modifier.fillMaxWidth()) { tv ->
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it; error = null },
                    label = { Text("Username") },
                    singleLine = true,
                    enabled = !busy,
                    modifier = tv.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next)
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        DpadTextField(Modifier.fillMaxWidth()) { tv ->
            OutlinedTextField(
                value = password,
                onValueChange = { password = it; error = null },
                label = { Text(if (ownerMode) "Beebo account password" else "Password") },
                singleLine = true,
                enabled = !busy,
                visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                modifier = tv.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go)
            )
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .toggleable(value = showPassword, enabled = !busy, role = Role.Checkbox) { showPassword = it }
                .padding(top = 4.dp)
        ) {
            Checkbox(checked = showPassword, onCheckedChange = null, enabled = !busy)
            Spacer(Modifier.width(8.dp))
            Text("Show password", fontSize = 14.sp)
        }

        if (busy && tunnel is TunnelConnection.Status.Connecting) {
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("Connecting to your home…", fontSize = 14.sp)
            }
        }

        error?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }
        if (showConnectionTest && !DistributionPolicy.opensWebsiteLinks(DistributionPolicy.current)) {
            // Google Play build: the website's menu links to Pricing, so name the page instead of linking.
            Spacer(Modifier.height(8.dp))
            Text(
                "To test whether Beebo can work on your connections, visit " +
                    DistributionPolicy.plainAddress(RemoteMessages.CONNECTION_TEST_URL) + " in a web browser.",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else if (showConnectionTest) {
            TextButton(onClick = {
                runCatching {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(RemoteMessages.CONNECTION_TEST_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }) { Text("Test whether Beebo can work on your connections") }
        }

        Spacer(Modifier.height(16.dp))
        Button(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { submit() }) {
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Sign in")
        }
        TextButton(enabled = !busy, onClick = { ownerMode = !ownerMode; error = null; password = "" }) {
            Text(if (ownerMode) "Sign in with your username instead" else "Owner sign-in", fontSize = 13.sp)
        }
        // Always one tap away, and offered outright after a failure: this is where it helps most.
        if (error != null) {
            OutlinedButton(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { showHelp = true }) { Text("Find out why I can’t connect") }
        } else {
            TextButton(enabled = !busy, onClick = { showHelp = true }) { Text("Can’t connect?", fontSize = 13.sp) }
        }
        if (onUsePhone != null) {
            OutlinedButton(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = onUsePhone) { Text(TvPairMessages.PHONE_INSTEAD) }
        }

        // --- The hub, for watch parties: behind "Advanced" unless this phone already uses it ----
        Spacer(Modifier.height(20.dp))
        HorizontalDivider()
        if (!showAdvanced) {
            TextButton(enabled = !busy, onClick = { showAdvanced = true }) { Text("Advanced: Beebo hub account", fontSize = 13.sp) }
        } else {
        Spacer(Modifier.height(16.dp))
        Text("Beebo hub account", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(4.dp))
        Text(
            "Signed in to the Beebo hub? It can find your home server for you.",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(12.dp))
        DpadTextField(Modifier.fillMaxWidth()) { tv ->
            OutlinedTextField(
                value = hubEmail,
                onValueChange = { hubEmail = it; error = null },
                label = { Text("Hub email") },
                singleLine = true,
                modifier = tv.fillMaxWidth()
            )
        }
        Spacer(Modifier.height(8.dp))
        DpadTextField(Modifier.fillMaxWidth()) { tv ->
            OutlinedTextField(
                value = hubPassword,
                onValueChange = { hubPassword = it; error = null },
                label = { Text("Hub password") },
                singleLine = true,
                visualTransformation = if (showHubPassword) VisualTransformation.None else PasswordVisualTransformation(),
                modifier = tv.fillMaxWidth()
            )
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .toggleable(value = showHubPassword, enabled = !busy, role = Role.Checkbox) { showHubPassword = it }
                .padding(top = 4.dp)
        ) {
            Checkbox(checked = showHubPassword, onCheckedChange = null, enabled = !busy)
            Spacer(Modifier.width(8.dp))
            Text("Show password", fontSize = 14.sp)
        }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(
            enabled = !busy && hubEmail.isNotBlank() && hubPassword.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                busy = true
                error = null
                scope.launch {
                    try {
                        HubAuth.signIn(app.session, hubEmail.trim(), hubPassword)
                        val outcome = HubAuth.refreshServerAddress(app.session)
                        if (outcome is ServerResolution.Applied) {
                            // The hub found the address; this screen still signs the person in.
                            home = app.session.baseUrl.orEmpty()
                            error = "Found your home server. Now enter your username and password above."
                        } else {
                            error = "Signed in. " + outcome.message
                        }
                    } catch (e: HubException) {
                        error = e.message
                    } catch (e: Exception) {
                        error = e.message ?: "Couldn't sign in to the hub."
                    } finally {
                        busy = false
                    }
                }
            }
        ) { Text("Find my home server with the hub") }
        }

        // --- No server? Let them in anyway. ---------------------------------
        Spacer(Modifier.height(28.dp))
        HorizontalDivider()
        Spacer(Modifier.height(20.dp))
        Text("Don't have a Beebo server yet?", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
        Spacer(Modifier.height(6.dp))
        Text(
            "Have a look around first. A sample library shows how Beebo looks, and the games, " +
                "Campsite tools and Star Chart all work on their own, with no computer needed. " +
                "You can connect your home library whenever you're ready.",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = onExploreWithoutServer, modifier = Modifier.fillMaxWidth()) { Text("Look around without a server") }
        Spacer(Modifier.height(24.dp))
    }
}
