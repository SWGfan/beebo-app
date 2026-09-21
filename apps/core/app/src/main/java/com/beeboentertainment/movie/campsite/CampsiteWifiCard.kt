package com.beeboentertainment.movie.campsite

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.ActivityCompat
import com.beeboentertainment.movie.BeeboApp

/**
 * "Step 1 - get guests on the Wi-Fi". Shown only after the host tapped Invite, and it starts
 * nothing by itself: the host picks one of three ways and only "Start BeeboTV Wi-Fi" makes a
 * network (and only then is the Wi-Fi permission asked for). Typing in the phone's own hotspot
 * details and "we're all on the same Wi-Fi" cost nothing and are remembered for next time.
 */
@Composable
internal fun WifiStepCard() {
    val context = LocalContext.current
    val wifi by BeeboWifi.state.collectAsState()
    val choice by CampsiteInvite.wifi.collectAsState()

    // Last session's free choice comes back; Beebo's own Wi-Fi never switches itself on.
    LaunchedEffect(Unit) { CampsiteInvite.restoreChoice() }

    var permanentlyDenied by remember { mutableStateOf(false) }
    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        if (!BeeboWifi.hasPermissions(context)) {
            val activity = context.findActivity()
            // Android stops showing the dialog after the second "Don't allow"; then only Settings can.
            permanentlyDenied = activity != null && BeeboWifi.requiredPermissions().none {
                ActivityCompat.shouldShowRequestPermissionRationale(activity, it)
            }
        }
        // Either starts, or records NEEDS_PERMISSION for the message.
        CampsiteInvite.chooseWifi(WifiChoice.BEEBO_WIFI)
    }
    // Android 8-12: explain the Location prompt before Android shows it.
    var locationNotice by remember { mutableStateOf(false) }
    /** The one explicit tap that is allowed to make a hotspot. */
    fun startWifi() {
        if (BeeboWifi.hasPermissions(context)) CampsiteInvite.chooseWifi(WifiChoice.BEEBO_WIFI)
        else if (WifiJoin.asksForLocation(Build.VERSION.SDK_INT)) locationNotice = true
        else permLauncher.launch(BeeboWifi.requiredPermissions())
    }
    if (locationNotice) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { locationNotice = false },
            title = { Text("Why Beebo asks for Location") },
            text = { Text(WifiJoin.LOCATION_NOTICE) },
            confirmButton = {
                TextButton(onClick = {
                    locationNotice = false
                    permLauncher.launch(BeeboWifi.requiredPermissions())
                }) { Text("Continue") }
            },
            dismissButton = { TextButton(onClick = { locationNotice = false }) { Text("Not now") } },
        )
    }

    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Step 1  \u2014  get guests on the Wi-Fi", fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text(
                if (choice == null) "Pick how the other phones reach yours. Nothing is switched on until you pick."
                else "Guests scan this first. Their phone joins your Wi-Fi \u2014 no typing, no password to read out.",
                fontSize = 12.sp, textAlign = TextAlign.Center, color = muted,
            )
            Spacer(Modifier.height(12.dp))

            // A TV only offers the Wi-Fi everyone is already on (no hotspot choices).
            val offered = CampsiteGameGate.wifiChoicesFor(
                isTv = com.beeboentertainment.movie.ui.tv.LocalIsTv.current,
                beeboWifiSupported = BeeboWifi.isSupported(),
            )
            when {
                choice == null -> {
                    if (WifiChoice.BEEBO_WIFI in offered) {
                        Button(onClick = { startWifi() }, modifier = Modifier.fillMaxWidth()) {
                            Text("Start ${BeeboWifi.expectedName()} Wi-Fi")
                        }
                        Text(
                            "Beebo makes a Wi-Fi just for this, with no internet, and turns it off when you stop.",
                            fontSize = 12.sp, textAlign = TextAlign.Center, color = muted,
                        )
                        Spacer(Modifier.height(8.dp))
                    }
                    if (WifiChoice.PHONE_HOTSPOT in offered) {
                        OutlinedButton(onClick = { CampsiteInvite.chooseWifi(WifiChoice.PHONE_HOTSPOT) }, modifier = Modifier.fillMaxWidth()) {
                            Text("Use my phone's own hotspot")
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                    OutlinedButton(onClick = { CampsiteInvite.chooseWifi(WifiChoice.SAME_WIFI) }, modifier = Modifier.fillMaxWidth()) {
                        Text("Everyone's already on the same Wi-Fi")
                    }
                }

                choice == WifiChoice.PHONE_HOTSPOT -> {
                    ManualHotspot(onUseBeebo = if (BeeboWifi.isSupported()) ({ startWifi() }) else null)
                    TextButton(onClick = { CampsiteInvite.clearWifiChoice() }) { Text("Choose a different way") }
                }

                choice == WifiChoice.SAME_WIFI -> {
                    Text(
                        "No hotspot needed. Guests stay on the Wi-Fi they're on and scan the theatre code below.",
                        fontSize = 14.sp, textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Some public and hotel Wi-Fi keeps phones from seeing each other. If the code won't open for a guest, use a hotspot instead.",
                        fontSize = 12.sp, textAlign = TextAlign.Center, color = muted,
                    )
                    if (offered.size > 1) {
                        TextButton(onClick = { CampsiteInvite.clearWifiChoice() }) { Text("Choose a different way") }
                    }
                }

                wifi.phase == BeeboWifi.Phase.ON -> {
                    JoinCode(ssid = wifi.ssid, password = wifi.password)
                    Spacer(Modifier.height(8.dp))
                    val why = when (wifi.kind) {
                        BeeboWifi.Kind.WIFI_DIRECT ->
                            "Why not plain \"BeeboTV\"? Until Android 17, Android only lets an app name its own Wi-Fi if the name starts with DIRECT-."
                        BeeboWifi.Kind.SYSTEM_HOTSPOT ->
                            "Your phone chose this name and password. This version of Android doesn't let apps pick them."
                        else -> null
                    }
                    if (why != null) Text(why, fontSize = 12.sp, textAlign = TextAlign.Center, color = muted)
                    if (WifiJoin.isGeneratedPassword(wifi.password)) {
                        Text(
                            "Why 8 and not 6? Wi-Fi passwords must be at least 8 characters, or iPhones and most Androids can't join.",
                            fontSize = 12.sp, textAlign = TextAlign.Center, color = muted,
                        )
                    }
                    Text(
                        "This Wi-Fi has no internet — guests only need it to reach your phone. If a guest's page won't load after joining, have them turn mobile data off for a minute.",
                        fontSize = 12.sp, textAlign = TextAlign.Center, color = muted,
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                        OutlinedButton(onClick = { CampsiteInvite.clearWifiChoice() }) { Text("Turn off Wi-Fi") }
                        if (wifi.kind != BeeboWifi.Kind.SYSTEM_HOTSPOT) {
                            Spacer(Modifier.size(8.dp))
                            TextButton(onClick = { BeeboWifi.newPassword(context) }) { Text("New password") }
                        }
                    }
                    TextButton(onClick = { CampsiteInvite.chooseWifi(WifiChoice.PHONE_HOTSPOT) }) {
                        Text("Use my phone's own hotspot instead")
                    }
                }

                wifi.phase == BeeboWifi.Phase.STARTING -> {
                    CircularProgressIndicator(Modifier.size(36.dp))
                    Spacer(Modifier.height(8.dp))
                    Text("Making the ${BeeboWifi.expectedName()} Wi-Fi…", fontSize = 13.sp, color = muted)
                }

                else -> {
                    Button(onClick = { startWifi() }, modifier = Modifier.fillMaxWidth()) {
                        Text("Start ${BeeboWifi.expectedName()} Wi-Fi")
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Beebo makes its own Wi-Fi and fills in the name and password for you.",
                        fontSize = 12.sp, textAlign = TextAlign.Center, color = muted,
                    )
                    val problem = wifi.problem
                    if (problem != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            BeeboWifi.problemText(problem),
                            fontSize = 13.sp, textAlign = TextAlign.Center,
                            color = MaterialTheme.colorScheme.error,
                        )
                        val fix: Pair<String, () -> Intent>? = when {
                            problem == BeeboWifi.Problem.NEEDS_PERMISSION && permanentlyDenied ->
                                "Open app settings" to {
                                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                                }
                            problem == BeeboWifi.Problem.WIFI_OFF -> "Turn on Wi-Fi" to {
                                Intent(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) Settings.Panel.ACTION_WIFI else Settings.ACTION_WIFI_SETTINGS)
                            }
                            problem == BeeboWifi.Problem.LOCATION_OFF -> "Turn on Location" to {
                                Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
                            }
                            problem == BeeboWifi.Problem.HOTSPOT_ALREADY_ON -> "Open hotspot settings" to {
                                Intent(Settings.ACTION_WIRELESS_SETTINGS)
                            }
                            else -> null
                        }
                        if (fix != null) {
                            TextButton(onClick = {
                                runCatching { context.startActivity(fix.second().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                            }) { Text(fix.first) }
                        }
                    }
                    TextButton(onClick = { CampsiteInvite.chooseWifi(WifiChoice.PHONE_HOTSPOT) }) { Text("Use my phone's own hotspot instead") }
                    TextButton(onClick = { CampsiteInvite.clearWifiChoice() }) { Text("Choose a different way") }
                }
            }
        }
    }
}

/** The big join QR with the name and the password to read out underneath. */
@Composable
private fun JoinCode(ssid: String, password: String) {
    val qr = remember(ssid, password) { qrBitmap(WifiJoin.qrPayload(ssid, password), 720) }
    if (qr != null) {
        Image(qr.asImageBitmap(), contentDescription = "Wi-Fi join code for $ssid", modifier = Modifier.size(260.dp))
    }
    Spacer(Modifier.height(8.dp))
    Text("Network", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(ssid, fontWeight = FontWeight.Bold, fontSize = 20.sp, textAlign = TextAlign.Center)
    if (password.isNotBlank()) {
        Spacer(Modifier.height(6.dp))
        val generated = WifiJoin.isGeneratedPassword(password)
        Text(
            if (generated) "Password (type it without the space)" else "Password",
            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            if (generated) WifiJoin.spacedForReading(password) else password,
            fontWeight = FontWeight.Bold,
            fontSize = if (generated) 28.sp else 16.sp,
            fontFamily = FontFamily.Monospace,
            letterSpacing = if (generated) 3.sp else 0.sp,
            textAlign = TextAlign.Center,
        )
    }
}

/** Today's path, kept as it was: the host types their own hotspot's details once. */
@Composable
private fun ManualHotspot(onUseBeebo: (() -> Unit)?) {
    val context = LocalContext.current
    val prefs = remember { BeeboApp.instance.session.plain }
    var ssid by remember { mutableStateOf(prefs.getString(KEY_SSID, "") ?: "") }
    var pass by remember { mutableStateOf(prefs.getString(KEY_PASS, "") ?: "") }
    var editing by remember { mutableStateOf(ssid.isBlank()) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    if (editing) {
        Text(
            "Type your hotspot's name and password exactly as they appear in your phone's hotspot settings.",
            fontSize = 12.sp, textAlign = TextAlign.Center, color = muted,
        )
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = ssid, onValueChange = { ssid = it },
            label = { Text("Hotspot name") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = pass, onValueChange = { pass = it },
            label = { Text("Hotspot password") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.Center) {
            OutlinedButton(onClick = {
                runCatching {
                    context.startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }) { Text("Where do I find this?") }
            Spacer(Modifier.size(8.dp))
            Button(
                onClick = {
                    prefs.edit().putString(KEY_SSID, ssid.trim()).putString(KEY_PASS, pass).apply()
                    ssid = ssid.trim()
                    editing = false
                },
                enabled = ssid.isNotBlank(),
            ) { Text("Save") }
        }
    } else {
        JoinCode(ssid = ssid, password = pass)
        TextButton(onClick = { editing = true }) { Text("Change Wi-Fi details") }
    }
    if (onUseBeebo != null) {
        TextButton(onClick = onUseBeebo) { Text("Let Beebo make the Wi-Fi instead") }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

private const val KEY_SSID = "campsite_hotspot_ssid"
private const val KEY_PASS = "campsite_hotspot_pass"
