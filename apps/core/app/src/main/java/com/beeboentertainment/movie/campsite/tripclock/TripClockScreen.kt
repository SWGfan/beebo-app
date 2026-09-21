package com.beeboentertainment.movie.campsite.tripclock

import android.Manifest
import android.annotation.SuppressLint
import android.app.TimePickerDialog
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.KeyboardOptions
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.campsite.family.SharedPrefsFamilyStorage
import com.beeboentertainment.movie.campsite.family.WallClock
import com.beeboentertainment.movie.trip.TripData
import com.beeboentertainment.movie.trip.TripStore
import kotlinx.coroutines.delay
import java.util.TimeZone

/**
 * The host's Trip Clock: answers "are we there yet?" with a picture and a countdown for the back seat.
 *
 * A PASSENGER feature, for the grown-up to set up before the drive (or for a passenger to hold). It
 * says so on screen, and says "Estimate only. Use your navigation app for directions." at all times.
 * It is not navigation, not a safety product, and never claims to help the driver.
 *
 * Works with no internet. GPS is OFF every time this screen opens; if the parent switches it on it
 * uses coarse on-device location, only while this screen is in front, keeps it in memory, and saves
 * nothing (see [PathProgress]).
 */
@Composable
fun TripClockScreen(onOpenGames: () -> Unit = {}) {
    val session = remember { BeeboApp.instance.session }
    val controller = remember {
        TripClockController(
            store = TripClockStore(SharedPrefsFamilyStorage(session.plain)),
            trips = TripStore.forApp(session.plain),
            badges = { TripData.badgesNow(session) },
            packing = { TripData.packingNow(session) },
        )
    }
    var rev by remember { mutableIntStateOf(0) }
    val state = remember(rev) { controller.state() }
    val now by produceState(System.currentTimeMillis()) {
        while (true) { delay(5_000); value = System.currentTimeMillis() }
    }
    fun changed() { rev++ }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("🚗 Are we there yet?", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text(
            TripClockView.PASSENGERS + " " + TripClockView.DISCLAIMER,
            fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (!state.running) {
            SetupCard(controller, onStarted = { changed() })
        } else {
            RunningCard(controller, state, now, onOpenGames, onChanged = { changed() })
        }
    }
}

@Composable
private fun SetupCard(controller: TripClockController, onStarted: () -> Unit) {
    var mode by remember { mutableStateOf("length") }
    var hours by remember { mutableStateOf("2") }
    var minutes by remember { mutableStateOf("0") }
    var arriveMinute by remember { mutableIntStateOf(-1) }
    var distanceKm by remember { mutableStateOf("") }
    var unit by remember { mutableStateOf(KidUnit.EPISODES) }
    var nudge by remember { mutableIntStateOf(30) }
    var error by remember { mutableStateOf("") }
    val context = LocalContext.current

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Set up the trip", fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
            Text(
                "Tell it when you expect to arrive. You can push the time back with one tap if traffic happens. " +
                    "Nothing here needs the internet, and nothing leaves this phone.",
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = mode == "length", onClick = { mode = "length" }, label = { Text("Trip length") }, modifier = Modifier.heightIn(min = 48.dp))
                FilterChip(selected = mode == "arrive", onClick = { mode = "arrive" }, label = { Text("Arrive at") }, modifier = Modifier.heightIn(min = 48.dp))
            }
            if (mode == "length") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = hours, onValueChange = { hours = it.filter(Char::isDigit).take(2) },
                        label = { Text("Hours") }, singleLine = true, modifier = Modifier.weight(1f),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                    OutlinedTextField(
                        value = minutes, onValueChange = { minutes = it.filter(Char::isDigit).take(2) },
                        label = { Text("Minutes") }, singleLine = true, modifier = Modifier.weight(1f),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                }
            } else {
                OutlinedButton(
                    onClick = {
                        val cal = java.util.Calendar.getInstance()
                        TimePickerDialog(context, { _, h, m -> arriveMinute = h * 60 + m }, cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE), false).show()
                    },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text(if (arriveMinute < 0) "Choose the arrival time" else "Arrive at " + WallClock.clockText(arriveMinute)) }
            }
            OutlinedTextField(
                value = distanceKm, onValueChange = { distanceKm = it.filter { c -> c.isDigit() || c == '.' }.take(6) },
                label = { Text("Distance in km (optional, not exact)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
            Text("Show time left as", fontSize = 13.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                KidUnit.values().forEach { u ->
                    FilterChip(selected = unit == u, onClick = { unit = u }, label = { Text(u.label) }, modifier = Modifier.heightIn(min = 48.dp))
                }
            }
            Text("Suggest a game or activity", fontSize = 13.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(0 to "Never", 30 to "Every 30 min", 60 to "Every hour").forEach { (m, label) ->
                    FilterChip(selected = nudge == m, onClick = { nudge = m }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp))
                }
            }
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            Button(
                onClick = {
                    error = ""
                    val now = System.currentTimeMillis()
                    val eta = if (mode == "length") {
                        val total = (hours.toIntOrNull() ?: 0) * 60 + (minutes.toIntOrNull() ?: 0)
                        if (total <= 0) { error = "Enter how long the trip will take."; return@Button }
                        TripClockLogic.etaFromNow(now, total)
                    } else {
                        if (arriveMinute < 0) { error = "Choose the arrival time."; return@Button }
                        TripClockLogic.etaFromWallClock(now, arriveMinute, TimeZone.getDefault())
                    }
                    val meters = ((distanceKm.toDoubleOrNull() ?: 0.0) * 1000).toInt().coerceIn(0, TripClockLogic.MAX_DISTANCE_M)
                    runCatching { controller.start(eta, meters, unit, nudge) }
                        .onSuccess { onStarted() }
                        .onFailure { error = it.message ?: "That did not work." }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text("Start the clock") }
            Text(
                "Starting the clock also starts your Trip Journal if one is not running, so stops and arrival appear in the recap.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun RunningCard(
    controller: TripClockController,
    state: TripClockState,
    now: Long,
    onOpenGames: () -> Unit,
    onChanged: () -> Unit,
) {
    val context = LocalContext.current
    var gpsOn by remember { mutableStateOf(false) } // off every time the screen opens
    var granted by remember { mutableStateOf(hasCoarse(context)) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> granted = ok; gpsOn = ok }
    val path = remember(state.startedAtMs, state.distanceM) { PathProgress(state.distanceM) }
    var fixes by remember { mutableIntStateOf(0) }
    val location = rememberCoarseLocation(enabled = gpsOn && granted && state.arrivedAtMs == 0L)
    LaunchedEffect(location) {
        val fix = location ?: return@LaunchedEffect
        if (path.onFix(fix.latitude, fix.longitude, fix.accuracy, fix.time)) fixes++
    }
    val pathFraction = if (gpsOn) path.fraction() else null
    val view = remember(state, now, fixes, gpsOn) { TripClockLogic.view(state, now, TimeZone.getDefault(), pathFraction) }
    var confirmArrive by remember { mutableStateOf(false) }
    var confirmStop by remember { mutableStateOf(false) }
    var stopName by remember { mutableStateOf("") }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (view.arrived) {
                Text("🏕️ We're here!", fontSize = 30.sp, fontWeight = FontWeight.Bold)
            } else {
                Text(if (view.late) "Nearly there" else "Time left", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(view.leftText, fontSize = 36.sp, fontWeight = FontWeight.Bold)
                if (view.kidText.isNotEmpty()) Text(view.kidText, fontSize = 22.sp, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                Text("Expected about ${view.etaText}", fontSize = 14.sp)
                if (view.delayMs > 0L) Text("Running about ${WallClock.durationText(view.delayMs)} later than first planned.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            RoadScene(view)
            if (view.distanceText.isNotEmpty()) Text(view.distanceText, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (view.source == "distance") Text("Progress from this phone's rough location. Not exact.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(TripClockView.DISCLAIMER, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
    }

    if (view.nudgeDue > 0) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(view.nudgeText, fontWeight = FontWeight.SemiBold)
                Text("Try Plate & Sign Hunt, a quiz, or a song. For passengers only.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { controller.acknowledgeNudge(); onChanged(); onOpenGames() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Pick a game") }
                    OutlinedButton(onClick = { controller.acknowledgeNudge(); onChanged() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Not now") }
                }
            }
        }
    }

    if (!view.arrived) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Running late?", fontWeight = FontWeight.SemiBold)
                Button(
                    onClick = { controller.adjust(TripClockLogic.ADJUST_STEP_MIN); onChanged() },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                ) { Text("+15 min") }
                Text("Pushes the arrival back 15 minutes. Tap again for more.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

                Text("Add a stop", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("Snack", "Fuel", "Stretch").forEach { label ->
                        OutlinedButton(onClick = { addStop(controller, label, gpsOn, location); onChanged() }, modifier = Modifier.heightIn(min = 48.dp)) { Text(label) }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = stopName, onValueChange = { stopName = it.take(TripClockLogic.MAX_TITLE) },
                        label = { Text("Or name it") }, singleLine = true, modifier = Modifier.weight(1f),
                    )
                    OutlinedButton(
                        enabled = stopName.isNotBlank(),
                        onClick = { addStop(controller, stopName, gpsOn, location); stopName = ""; onChanged() },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text("Add") }
                }
                if (state.stops.isNotEmpty()) Text("Stops: " + state.stops.joinToString(", ") { it.title }, fontSize = 13.sp)
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Time left as", fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    KidUnit.values().forEach { u ->
                        FilterChip(selected = state.kidUnit == u.wire, onClick = { controller.setKidUnit(u); onChanged() }, label = { Text(u.label) }, modifier = Modifier.heightIn(min = 48.dp))
                    }
                }
                Text("Suggest an activity", fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(0 to "Never", 30 to "30 min", 60 to "1 hour").forEach { (m, label) ->
                        FilterChip(selected = state.nudgeMinutes == m, onClick = { controller.setNudge(m); onChanged() }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp))
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Use this phone's rough location", fontWeight = FontWeight.SemiBold)
                        Text(
                            "Off by default. Only while this screen is open, only on this phone, and not saved. Needs a route distance above.",
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = gpsOn,
                        onCheckedChange = { want ->
                            if (!want) gpsOn = false
                            else if (granted) gpsOn = true
                            else permission.launch(Manifest.permission.ACCESS_COARSE_LOCATION)
                        },
                    )
                }
            }
        }
        Button(onClick = { confirmArrive = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("We've arrived") }
    }
    OutlinedButton(onClick = { confirmStop = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
        Text(if (view.arrived) "Clear the clock" else "Stop the clock")
    }
    Text(
        "Guests on the Campsite Wi-Fi can open \"Are we there yet?\" on their own phones to watch it too.",
        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    if (confirmArrive) AlertDialog(
        onDismissRequest = { confirmArrive = false },
        title = { Text("Have you arrived?") },
        text = { Text("This marks the arrival on your Trip Journal. The trip keeps going until you tap We're home.") },
        confirmButton = { TextButton(onClick = { controller.arrive(); confirmArrive = false; onChanged() }) { Text("Yes, we're here") } },
        dismissButton = { TextButton(onClick = { confirmArrive = false }) { Text("Not yet") } },
    )
    if (confirmStop) AlertDialog(
        onDismissRequest = { confirmStop = false },
        title = { Text(if (view.arrived) "Clear the clock?" else "Stop the clock?") },
        text = { Text("The clock goes away. Your Trip Journal keeps its stops and arrival.") },
        confirmButton = { TextButton(onClick = { controller.reset(); confirmStop = false; onChanged() }) { Text("Yes") } },
        dismissButton = { TextButton(onClick = { confirmStop = false }) { Text("Keep it") } },
    )
}

/** Add a stop. The position goes along only when GPS is on and a fix exists, and the trip drops it unless the trip opted in. */
private fun addStop(controller: TripClockController, title: String, gpsOn: Boolean, fix: Location?) {
    if (gpsOn && fix != null) controller.addStop(title, fix.latitude, fix.longitude) else controller.addStop(title)
}

/** A road with a car on it, the parent's stops as pins, and a flag at the end. */
@Composable
private fun RoadScene(view: TripClockView) {
    val track = MaterialTheme.colorScheme.surfaceVariant
    val done = MaterialTheme.colorScheme.primary
    Box(Modifier.fillMaxWidth().height(72.dp)) {
        Box(Modifier.align(Alignment.CenterStart).fillMaxWidth().height(12.dp).clip(RoundedCornerShape(6.dp)).background(track))
        Box(Modifier.align(Alignment.CenterStart).fillMaxWidth(view.fraction.toFloat().coerceIn(0.02f, 1f)).height(12.dp).clip(RoundedCornerShape(6.dp)).background(done))
        view.stopFractions.forEach { f ->
            Text("📍", fontSize = 18.sp, modifier = Modifier.align(BiasAlignment(f.toFloat() * 2f - 1f, 0.55f)))
        }
        Text("🏁", fontSize = 26.sp, modifier = Modifier.align(BiasAlignment(1f, -0.9f)))
        Text("🚗", fontSize = 30.sp, modifier = Modifier.align(BiasAlignment(view.fraction.toFloat() * 2f - 1f, -0.9f)))
    }
}

private fun hasCoarse(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

/**
 * The phone's rough (network) location while [enabled] and this screen is in front. Registered on
 * start, removed on stop and on leaving: nothing updates with the screen off. The framework
 * LocationManager only, so no Google Play services (the Amazon build stays free of them). Values are
 * held in memory by the caller and never written anywhere.
 */
@SuppressLint("MissingPermission")
@Composable
private fun rememberCoarseLocation(enabled: Boolean): Location? {
    val context = LocalContext.current
    var location by remember { mutableStateOf<Location?>(null) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(enabled, lifecycleOwner) {
        if (!enabled) { location = null; return@DisposableEffect onDispose { } }
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return@DisposableEffect onDispose { }
        val listener = object : LocationListener {
            override fun onLocationChanged(loc: Location) { location = loc }
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) {}
        }
        var registered = false
        fun start() {
            if (registered) return
            if (runCatching { lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) }.getOrDefault(false)) {
                runCatching {
                    lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 30_000L, 100f, listener)
                    registered = true
                }
            }
        }
        fun stop() {
            if (!registered) return
            registered = false
            runCatching { lm.removeUpdates(listener) }
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> start()
                Lifecycle.Event.ON_STOP -> stop()
                else -> Unit
            }
        }
        val lifecycle = lifecycleOwner.lifecycle
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) start()
        onDispose {
            lifecycle.removeObserver(observer)
            stop()
            location = null
        }
    }
    return location
}
