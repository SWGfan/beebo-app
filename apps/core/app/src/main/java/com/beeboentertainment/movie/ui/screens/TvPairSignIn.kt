package com.beeboentertainment.movie.ui.screens

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.provider.Settings
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.DistributionPolicy
import com.beeboentertainment.movie.rtc.RemoteAccess
import com.beeboentertainment.movie.tvpair.PairFailure
import com.beeboentertainment.movie.tvpair.TvPairController
import com.beeboentertainment.movie.tvpair.TvPairHttp
import com.beeboentertainment.movie.tvpair.TvPairMessages
import com.beeboentertainment.movie.tvpair.TvPairOutcome
import com.beeboentertainment.movie.tvpair.TvPairState
import com.beeboentertainment.movie.tvpair.TvPairing
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter

/**
 * The TV's first sign-in screen: a code to enter on a phone, so nobody types an email and password
 * with a remote. The code and its polling live in [TvPairController]; this only draws it and hands
 * the approval to RemoteAccess. Typing stays one button away (and is the fallback whenever pairing
 * can't work).
 *
 * Not yet run on a real TV: focus order and layout here are written to the platform's rules only.
 */
@Composable
fun TvPairSignIn(
    onSignedIn: () -> Unit,
    onTypeInstead: () -> Unit,
    onExploreWithoutServer: () -> Unit,
) {
    val context = LocalContext.current
    val app = BeeboApp.instance
    val controller = remember {
        TvPairController(
            service = TvPairHttp(),
            deviceName = TvPairing.deviceLabel(
                runCatching { Settings.Global.getString(context.contentResolver, "device_name") }.getOrNull(),
                android.os.Build.MANUFACTURER,
                android.os.Build.MODEL,
            ),
            deviceModel = android.os.Build.MODEL.orEmpty(),
            nowMs = { android.os.SystemClock.elapsedRealtime() },
        )
    }
    val state by controller.state.collectAsState()

    // Bumped by "New code" and after a refusal, to start a fresh session.
    var round by remember { mutableIntStateOf(0) }
    var outcome by remember { mutableStateOf<TvPairOutcome?>(null) }
    var connectError by remember { mutableStateOf<String?>(null) }
    var connecting by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }

    // Poll only while the app is on screen: a TV left on another input must not keep asking for codes.
    LaunchedEffect(round) {
        outcome = null
        connectError = null
        val lifecycle = (context as? LifecycleOwner)?.lifecycle
        if (lifecycle == null) {
            outcome = controller.run()
        } else {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { if (outcome == null) outcome = controller.run() }
        }
    }

    val approved = outcome as? TvPairOutcome.Approved
    LaunchedEffect(approved, attempt) {
        if (approved == null) return@LaunchedEffect
        connecting = true
        connectError = null
        when (val r = RemoteAccess.signInWithViewerToken(approved.name, approved.token)) {
            is RemoteAccess.SignInResult.SignedIn -> {
                app.session.demoMode = false
                onSignedIn()
            }
            is RemoteAccess.SignInResult.Refused -> connectError = r.message
            is RemoteAccess.SignInResult.NotConnected -> connectError = r.message
        }
        connecting = false
    }

    val firstAction = remember { FocusRequester() }
    LaunchedEffect(outcome, connectError) { runCatching { firstAction.requestFocus() } }

    val hasWebsite = DistributionPolicy.opensWebsiteLinks(DistributionPolicy.current)

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 48.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Beebo Entertainment", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(4.dp))
        Text(TvPairMessages.PRIMARY_ACTION, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(20.dp))

        when {
            approved != null -> ApprovedBody(connecting, connectError)
            outcome is TvPairOutcome.Denied -> Text(
                TvPairMessages.denied((outcome as TvPairOutcome.Denied).reason),
                fontSize = 18.sp,
                textAlign = TextAlign.Center,
            )
            outcome is TvPairOutcome.Unavailable -> Text(TvPairMessages.UNAVAILABLE, fontSize = 18.sp, textAlign = TextAlign.Center)
            else -> PairingBody(state, hasWebsite)
        }

        Spacer(Modifier.height(28.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            when {
                // The token was handed over once and is still good: connecting is retried with it, not with a new code.
                approved != null && connectError != null ->
                    Button(onClick = { attempt++ }, modifier = Modifier.focusRequester(firstAction)) { Text("Try again") }
                approved != null -> Unit
                outcome is TvPairOutcome.Unavailable ->
                    Button(onClick = onTypeInstead, modifier = Modifier.focusRequester(firstAction)) { Text(TvPairMessages.TYPE_INSTEAD) }
                else ->
                    Button(onClick = { round++ }, modifier = Modifier.focusRequester(firstAction)) { Text("New code") }
            }
            if (approved == null && outcome !is TvPairOutcome.Unavailable) {
                OutlinedButton(onClick = onTypeInstead) { Text(TvPairMessages.TYPE_INSTEAD) }
            }
        }
        if (approved == null) {
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onExploreWithoutServer) { Text("Look around without a server") }
        }
    }
}

@Composable
private fun ApprovedBody(connecting: Boolean, error: String?) {
    if (error != null) {
        Text(error, fontSize = 18.sp, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
    } else {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
            Spacer(Modifier.width(12.dp))
            Text(if (connecting) "Connecting to your home…" else "Approved", fontSize = 20.sp)
        }
    }
}

@Composable
private fun PairingBody(state: TvPairState, hasWebsite: Boolean) {
    when (state) {
        TvPairState.Starting -> Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
            Spacer(Modifier.width(12.dp))
            Text("Getting a code…", fontSize = 20.sp)
        }
        is TvPairState.Waiting -> Text(
            TvPairMessages.problem(state.failure, state.retryInS),
            fontSize = 18.sp,
            textAlign = TextAlign.Center,
            color = if (state.failure.kind == PairFailure.Kind.OFFLINE) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        )
        is TvPairState.ShowCode -> {
            val address = DistributionPolicy.plainAddress(state.verificationUri)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(40.dp)) {
                Column(Modifier.width(520.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        state.userCode,
                        fontSize = 64.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        letterSpacing = 6.sp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        TvPairMessages.steps(hasWebsite, address),
                        fontSize = 16.sp,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text("The code refreshes by itself.", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (state.offline) {
                        Spacer(Modifier.height(8.dp))
                        Text(TvPairMessages.OFFLINE_BANNER, fontSize = 15.sp, color = MaterialTheme.colorScheme.error)
                    }
                }
                // A QR code is a link to the website, so the Google Play build leaves it out (see DistributionPolicy).
                if (hasWebsite && state.verificationUriWithCode.isNotEmpty()) {
                    val qr = remember(state.verificationUriWithCode) { qr(state.verificationUriWithCode, 360) }
                    if (qr != null) {
                        Image(
                            bitmap = qr.asImageBitmap(),
                            contentDescription = "QR code that opens the sign-in page with this code filled in",
                            modifier = Modifier
                                .size(200.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(androidx.compose.ui.graphics.Color.White)
                                .padding(8.dp),
                        )
                    }
                }
            }
        }
    }
}

private fun qr(text: String, size: Int): Bitmap? = runCatching {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
    val pixels = IntArray(size * size) { i -> if (m.get(i % size, i / size)) AndroidColor.BLACK else AndroidColor.WHITE }
    Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
}.getOrNull()
