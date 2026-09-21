package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.rtc.RemoteAccess
import com.beeboentertainment.movie.tvpair.LinkError
import com.beeboentertainment.movie.tvpair.LinkResult
import com.beeboentertainment.movie.tvpair.TvDecision
import com.beeboentertainment.movie.tvpair.TvLinkMessages
import com.beeboentertainment.movie.tvpair.TvLinkRequests
import com.beeboentertainment.movie.tvpair.TvLinkService
import com.beeboentertainment.movie.tvpair.TvPairCodes
import com.beeboentertainment.movie.tvpair.TvPairHttp
import com.beeboentertainment.movie.tvpair.TvRequest
import kotlinx.coroutines.launch

private sealed interface LinkStep {
    data object Enter : LinkStep
    data class Confirm(val code: String, val tv: TvRequest) : LinkStep
    data class Done(val tv: TvRequest, val approved: Boolean) : LinkStep
}

/**
 * Settings > Link a TV. Type the code a TV is showing (or arrive here from the beebo://tv-link
 * deep link with it filled in), see which TV asked, and approve or deny. The TV then signs in as
 * this account. Needs a Beebo account sign-in on this phone, the one used for beebo.tv.
 */
@Composable
fun LinkTvScreen(service: TvLinkService = remember { TvPairHttp() }) {
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf<LinkStep>(LinkStep.Enter) }
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // A code that came in from a link: fill it in, and look it up straight away.
    val fromLink by TvLinkRequests.pending.collectAsState()

    suspend fun token(): String? = RemoteAccess.accountToken().also {
        if (it == null) error = TvLinkMessages.forError(LinkError.UNAUTHORIZED)
    }

    fun refuse(r: LinkResult.Refused) {
        error = TvLinkMessages.forError(r.error, r.retryAfterS)
    }

    fun lookup(raw: String) {
        val code = TvPairCodes.normalize(raw)
        if (code == null) { error = TvLinkMessages.forError(LinkError.INVALID_CODE); return }
        busy = true
        error = null
        scope.launch {
            try {
                val t = token() ?: return@launch
                when (val r = service.lookup(t, code)) {
                    is LinkResult.Ok -> step = LinkStep.Confirm(code, r.value)
                    is LinkResult.Refused -> refuse(r)
                }
            } finally {
                busy = false
            }
        }
    }

    fun decide(s: LinkStep.Confirm, decision: TvDecision) {
        busy = true
        error = null
        scope.launch {
            try {
                val t = token() ?: return@launch
                when (val r = service.decide(t, s.code, decision)) {
                    is LinkResult.Ok -> step = LinkStep.Done(s.tv, decision == TvDecision.APPROVE)
                    is LinkResult.Refused -> refuse(r)
                }
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(fromLink) {
        val incoming = fromLink ?: return@LaunchedEffect
        TvLinkRequests.consume()
        text = TvPairCodes.normalize(incoming)?.let { TvPairCodes.format(it) } ?: ""
        step = LinkStep.Enter
        if (text.isNotEmpty()) lookup(text)
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Link a TV", style = MaterialTheme.typography.titleLarge)

        when (val s = step) {
            LinkStep.Enter -> {
                Text(
                    "Open Beebo on your TV. It shows a code. Enter it here to sign that TV in to your account.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = TvPairCodes.formatTyped(it); error = null },
                    label = { Text("Code on the TV") },
                    placeholder = { Text("ABCD-EFGH") },
                    singleLine = true,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii),
                )
                Button(enabled = !busy && TvPairCodes.normalize(text) != null, onClick = { lookup(text) }) { Text("Continue") }
            }

            is LinkStep.Confirm -> {
                Text("Sign this TV in to your account?", style = MaterialTheme.typography.titleMedium)
                Text(s.tv.deviceName, style = MaterialTheme.typography.headlineSmall)
                if (s.tv.deviceModel.isNotBlank() && !s.tv.deviceName.contains(s.tv.deviceModel, ignoreCase = true)) {
                    Text(s.tv.deviceModel, style = MaterialTheme.typography.bodyMedium)
                }
                Text("Asked ${TvLinkMessages.ago(s.tv.requestedMinutesAgo)}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    "Only approve it if that is the TV in front of you, showing this code right now. " +
                        "Approving lets it watch your library until it is signed out.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(enabled = !busy, onClick = { decide(s, TvDecision.APPROVE) }) { Text("Approve") }
                    OutlinedButton(enabled = !busy, onClick = { decide(s, TvDecision.DENY) }) { Text("Deny") }
                }
            }

            is LinkStep.Done -> {
                Text(
                    if (s.approved) "${s.tv.deviceName} is signing in. It should open Beebo in a few seconds."
                    else "Denied. ${s.tv.deviceName} was not signed in.",
                    style = MaterialTheme.typography.bodyLarge,
                )
                OutlinedButton(onClick = { text = ""; step = LinkStep.Enter }) { Text("Link another TV") }
            }
        }

        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}
