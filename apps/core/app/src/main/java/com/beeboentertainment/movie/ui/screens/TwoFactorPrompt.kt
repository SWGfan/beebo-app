package com.beeboentertainment.movie.ui.screens

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.core.SecondStep
import com.beeboentertainment.movie.ui.tv.DpadTextField
import com.beeboentertainment.movie.ui.tv.LocalIsTv

/**
 * The second step after a right password, for an account with two-factor on: the 6-digit code
 * from an authenticator app, or a recovery code. [onSubmit] gets what [SecondStep.classify] read;
 * a malformed code is refused here with a short hint and never reaches the server (a wrong guess
 * counts against the account's lock).
 */
@Composable
fun TwoFactorPrompt(
    busy: Boolean,
    error: String?,
    onSubmit: (SecondStep.Entry) -> Unit,
    onCancel: () -> Unit,
) {
    var code by remember { mutableStateOf("") }
    var hint by remember { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    val isTv = LocalIsTv.current

    fun go() {
        val entry = SecondStep.classify(code)
        when (entry) {
            SecondStep.Entry.Empty -> hint = "Type the code first."
            is SecondStep.Entry.Invalid -> hint = entry.reason
            else -> { hint = null; onSubmit(entry) }
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("Two-step sign-in", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(8.dp))
        Text(
            "Your password was right. Now type the 6-digit code from your authenticator app. " +
                "If you lost your phone, use one of your recovery codes instead.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 14.sp
        )
        Spacer(Modifier.height(20.dp))
        DpadTextField(Modifier.fillMaxWidth(), frameFocusRequester = if (isTv) focus else null) { tv ->
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.take(32); hint = null },
                label = { Text("Code") },
                singleLine = true,
                enabled = !busy,
                modifier = tv.fillMaxWidth().then(if (!isTv) Modifier.focusRequester(focus) else Modifier),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Ascii,
                    capitalization = KeyboardCapitalization.Characters,
                    imeAction = ImeAction.Go
                ),
                keyboardActions = KeyboardActions(onGo = { if (!busy) go() })
            )
        }
        val shown = hint ?: error
        if (shown != null) {
            Spacer(Modifier.height(10.dp))
            Text(shown, color = MaterialTheme.colorScheme.error, modifier = Modifier.fillMaxWidth())
        }
        Spacer(Modifier.height(16.dp))
        Button(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { go() }) {
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Sign in")
        }
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.Center) {
            TextButton(enabled = !busy, onClick = onCancel) { Text("Back to password", fontSize = 13.sp) }
            Spacer(Modifier.width(8.dp))
        }
    }
}
