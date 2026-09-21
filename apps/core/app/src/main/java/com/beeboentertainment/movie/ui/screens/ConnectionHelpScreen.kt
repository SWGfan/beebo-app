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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BuildConfig
import com.beeboentertainment.movie.core.ConnectionDoctor
import com.beeboentertainment.movie.core.DoctorFacts
import com.beeboentertainment.movie.core.DoctorFinding
import com.beeboentertainment.movie.core.Level
import com.beeboentertainment.movie.core.PairLink
import com.beeboentertainment.movie.data.ConnectionProbe

/**
 * "Can't connect?" on the phone. Runs the checks a phone can do (Wi-Fi or mobile data, same network as
 * the computer, can the address be found, does the computer answer, which kind of failure) and says in
 * plain words what it means and what to do next. What it cannot see, the computer's firewall and
 * router, it points at the computer's own "Can't connect? Fix it for me". The text can be copied and
 * sent to whoever helps; it holds no password, token or username (core/ConnectionDiagnosis.kt).
 */
@Composable
fun ConnectionHelpScreen(target: PairLink?, lastLoginHttp: Int?, onClose: () -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var run by remember { mutableIntStateOf(0) }
    var facts by remember { mutableStateOf<DoctorFacts?>(null) }
    var copied by remember { mutableStateOf(false) }

    LaunchedEffect(run, target) {
        facts = null
        copied = false
        facts = ConnectionProbe.run(context, target, lastLoginHttp)
    }

    val current = facts
    val findings: List<DoctorFinding> = current?.let { ConnectionDoctor.diagnose(it) }.orEmpty()

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.Start,
    ) {
        Text("Can’t connect?", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(4.dp))
        Text("Beebo checks what this phone can check, and tells you what to try.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp)
        Spacer(Modifier.height(16.dp))

        if (current == null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
                Text("Checking…")
            }
        } else {
            Text(ConnectionDoctor.headline(findings), fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
            Spacer(Modifier.height(12.dp))
            findings.forEach { FindingCard(it) }
            if (current.target == null) {
                Text(
                    "Type your home’s name or address on the sign-in screen first, and Beebo can check that too.",
                    fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(12.dp))
            Text("On the computer", fontWeight = FontWeight.SemiBold)
            Text(
                "Open Beebo and press “Can’t connect? Fix it for me”. It checks the computer’s firewall and router, which this phone cannot see.",
                fontSize = 14.sp,
            )
        }

        Spacer(Modifier.height(20.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = { run++ }, enabled = current != null) { Text("Check again") }
            OutlinedButton(
                enabled = current != null,
                onClick = {
                    val text = ConnectionDoctor.report(current!!, findings, BuildConfig.VERSION_NAME, "Android ${android.os.Build.VERSION.RELEASE}")
                    clipboard.setText(AnnotatedString(text))
                    copied = true
                },
            ) { Text("Copy details") }
        }
        if (copied) {
            Spacer(Modifier.height(6.dp))
            Text("Copied. It has no passwords, only what was found.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("Back to sign in") }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun FindingCard(f: DoctorFinding) {
    val mark = when (f.level) { Level.OK -> "✓"; Level.WARN -> "!"; Level.PROBLEM -> "✕" }
    val color = when (f.level) {
        Level.OK -> MaterialTheme.colorScheme.primary
        Level.WARN -> MaterialTheme.colorScheme.tertiary
        Level.PROBLEM -> MaterialTheme.colorScheme.error
    }
    Row(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
        Text(mark, color = color, fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.width(26.dp))
        Column(Modifier.weight(1f)) {
            Text(f.title, fontWeight = FontWeight.SemiBold)
            Text(f.body, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            f.steps.forEach { Text("•  $it", fontSize = 14.sp, modifier = Modifier.padding(top = 4.dp)) }
        }
    }
}
