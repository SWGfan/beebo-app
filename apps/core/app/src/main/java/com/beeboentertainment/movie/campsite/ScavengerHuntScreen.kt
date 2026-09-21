package com.beeboentertainment.movie.campsite

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.party.RoomEvent
import com.beeboentertainment.movie.party.RoomMessenger
import com.beeboentertainment.movie.party.rememberRoomMessenger
import com.beeboentertainment.movie.trip.HuntFind
import com.beeboentertainment.movie.trip.TripStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.random.Random

/*
 * "Campsite Scavenger Hunt" — a per-trip, GPS-dropped waypoint hunt. NOT global geocaching:
 * a parent/host walks the campsite and drops a few waypoints using THIS phone's own GPS (no
 * external database), each a captured lat/lng + short label. Kids then hunt; a phone claims a
 * waypoint when it comes within ~15m (or the "I found it" button, enabled when close), and the
 * claim fans out LIVE to every phone over the SAME hub /room socket the watch party, games and
 * campfire already use (RoomMessenger -> RoomClient), no new server — exactly like the bingo
 * live-claim.
 *
 * Wire protocol (RoomClient.sendApp {type, ...}; the hub relays, stamps `from`, never echoes us):
 *
 *   hunt_waypoints { list }        the host shares the full waypoint list (JSON array string)
 *   hunt_found     { id, by }      a phone claims a waypoint; peers fold it in (first-found wins)
 *   hunt_full      { list, found } snapshot to a phone that just joined (found = id -> by object)
 *
 * Convergence mirrors bingo: the FIRST claim per waypoint sticks everywhere (a later claim for an
 * already-found waypoint is ignored), so two kids reaching one spot converge to one finder on
 * every phone without a server tally.
 */

private const val MSG_WAYPOINTS = "hunt_waypoints"
private const val MSG_FOUND = "hunt_found"
private const val MSG_FULL = "hunt_full"

/** How close (metres) a phone must be to auto-claim / enable the "I found it" button. */
private const val FOUND_RADIUS_M = 15f

private val huntJson = Json { ignoreUnknownKeys = true }

/** One dropped point: [id] is stable on the wire, [label] is what the hunter reads. */
data class Waypoint(val id: String, val label: String, val lat: Double, val lng: Double)

private fun encodeWaypoints(list: List<Waypoint>): String = buildJsonArray {
    list.forEach { w ->
        addJsonObject {
            put("id", w.id)
            put("label", w.label)
            put("lat", w.lat)
            put("lng", w.lng)
        }
    }
}.toString()

private fun decodeWaypoints(text: String): List<Waypoint> = runCatching {
    huntJson.parseToJsonElement(text).jsonArray.mapNotNull { el ->
        val o = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
        val id = o["id"]?.jsonPrimitive?.content ?: return@mapNotNull null
        val label = o["label"]?.jsonPrimitive?.content ?: ""
        val lat = o["lat"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
        val lng = o["lng"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
        Waypoint(id, label, lat, lng)
    }
}.getOrDefault(emptyList())

/** Metres between two lat/lng pairs, via the framework's own great-circle helper. */
private fun distanceM(aLat: Double, aLng: Double, bLat: Double, bLng: Double): Float {
    val out = FloatArray(1)
    Location.distanceBetween(aLat, aLng, bLat, bLng, out)
    return out[0]
}

/** Location update cadence: coarse enough to let the GPS duty-cycle, fine enough for a walk. */
private const val LOCATION_INTERVAL_MS = 5_000L
private const val LOCATION_MIN_DISTANCE_M = 5f

/**
 * Live device location from the framework [LocationManager] — deliberately NOT
 * FusedLocationProviderClient, because play-services-location isn't a dependency of this build, so
 * this adds no new library. Registers for GPS + network updates while [enabled] AND the screen is
 * started (ON_START..ON_STOP), removes them on stop / dispose. Returns the latest fix, or null until
 * one lands. The caller guarantees permission before setting [enabled] true, so the
 * missing-permission lint is safe to suppress.
 */
@SuppressLint("MissingPermission")
@Composable
private fun rememberDeviceLocation(enabled: Boolean): Location? {
    val context = LocalContext.current
    var location by remember { mutableStateOf<Location?>(null) }

    val lifecycleOwner = LocalLifecycleOwner.current

    DisposableEffect(enabled, lifecycleOwner) {
        if (!enabled) return@DisposableEffect onDispose { }
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return@DisposableEffect onDispose { }

        val listener = object : LocationListener {
            override fun onLocationChanged(loc: Location) { location = loc }
            // Empty overrides keep this compatible back to API 24 (deprecated but still called).
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) {}
        }

        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        var any = false

        // Battery: the GPS receiver only runs while the screen is actually in front of the user.
        // A plain DisposableEffect outlives ON_STOP (the composable is still in composition when
        // the phone is locked or the app is backgrounded), which used to leave GPS on in a pocket
        // until the user navigated away. 5 s / 5 m is plenty for walking between waypoints.
        fun start() {
            if (any) return
            providers.forEach { p ->
                if (runCatching { lm.isProviderEnabled(p) }.getOrDefault(false)) {
                    runCatching {
                        // Seed with the last known fix so the UI has something immediately.
                        lm.getLastKnownLocation(p)?.let { last ->
                            if (location == null) location = last
                        }
                        lm.requestLocationUpdates(p, LOCATION_INTERVAL_MS, LOCATION_MIN_DISTANCE_M, listener)
                        any = true
                    }
                }
            }
        }

        fun stop() {
            if (!any) return
            any = false
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
        // addObserver replays ON_START when the owner is already started, so this is normally a
        // no-op (start() is idempotent); it is only a belt-and-braces for a non-replaying owner.
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) start()

        // Even with no provider enabled we still return cleanly; the UI shows "waiting for GPS".
        onDispose {
            lifecycle.removeObserver(observer)
            stop()
        }
    }
    return location
}

/**
 * Route-level entry point, mirroring the other campsite screens: builds a [RoomMessenger] for the
 * signed-in hub account and hands it to [ScavengerHunt]. With no hub the screen still works on this
 * phone (drop + find waypoints locally); nothing syncs, but it is never a dead end.
 */
@Composable
fun ScavengerHuntScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val myName = remember { session.userName?.takeIf { it.isNotBlank() } ?: "Hunter" }
    val messenger = rememberRoomMessenger(session, myName)
    ScavengerHunt(messenger = messenger, myName = myName, modifier = modifier)
}

@Composable
fun ScavengerHunt(
    messenger: RoomMessenger?,
    myName: String,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val connected = messenger?.connected?.collectAsState()?.value ?: false
    val members = messenger?.members?.collectAsState()?.value ?: emptyList()

    // Whether this phone drops the waypoints (the parent/host) or just hunts.
    var isHost by remember { mutableStateOf(false) }

    // Runtime location permission.
    fun hasLocation(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
    var granted by remember { mutableStateOf(hasLocation()) }
    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result -> granted = result.values.any { it } || hasLocation() }

    val location = rememberDeviceLocation(enabled = granted)

    // Shared hunt state.
    val waypoints = remember { mutableStateListOf<Waypoint>() }
    // waypointId -> who found it first. mutableStateMap repaints every phone on a change.
    val found = remember { mutableStateMapOf<String, String>() }

    var newLabel by remember { mutableStateOf("") }

    fun applyFound(id: String, by: String) {
        if (found[id] == null) found[id] = by // first found wins; ignore later claims
    }

    fun broadcastWaypoints() {
        messenger?.send(MSG_WAYPOINTS, buildJsonObject { put("list", encodeWaypoints(waypoints.toList())) })
    }

    fun dropWaypoint() {
        val loc = location ?: return
        val label = newLabel.trim().ifBlank { "Waypoint ${waypoints.size + 1}" }
        val id = "w" + System.currentTimeMillis() + "-" + Random.nextInt(1000)
        waypoints.add(Waypoint(id, label, loc.latitude, loc.longitude))
        newLabel = ""
        broadcastWaypoints()
    }

    fun claim(w: Waypoint) {
        if (found[w.id] != null) return // already found — someone got there first
        applyFound(w.id, myName)
        messenger?.send(MSG_FOUND, buildJsonObject {
            put("id", w.id)
            put("by", myName)
        })
    }

    // Fold in peers' envelopes.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_WAYPOINTS -> {
                    val text = msg.data["list"]?.jsonPrimitive?.content ?: return@collect
                    val incoming = decodeWaypoints(text)
                    // Adopt the shared list; drop found flags for ids no longer present.
                    waypoints.clear()
                    waypoints.addAll(incoming)
                    val liveIds = incoming.map { it.id }.toSet()
                    found.keys.filterNot { it in liveIds }.forEach { found.remove(it) }
                }
                MSG_FOUND -> {
                    val id = msg.data["id"]?.jsonPrimitive?.content ?: return@collect
                    val by = msg.data["by"]?.jsonPrimitive?.content
                        ?: msg.from.ifBlank { "Someone" }
                    applyFound(id, by)
                }
                MSG_FULL -> mergeSnapshot(msg, waypoints, ::applyFound)
            }
        }
    }

    // When someone new joins, the host pushes the whole hunt so they start already in sync.
    LaunchedEffect(messenger, isHost) {
        messenger?.memberJoined?.collect {
            if (isHost) {
                messenger.send(MSG_FULL, buildJsonObject {
                    put("list", encodeWaypoints(waypoints.toList()))
                    put("found", encodeFound(found).toString())
                })
            }
        }
    }

    // Keep the finds on the running trip (nothing happens with no trip). A waypoint's coordinates
    // are handed over too, but TripLogic drops them unless the trip has location saving turned on,
    // which is off by default.
    val tripStore = remember { TripStore.forApp(BeeboApp.instance.session.plain) }
    val foundNow = found.toMap()
    val waypointsNow = waypoints.toList()
    LaunchedEffect(foundNow, waypointsNow) {
        val finds = waypointsNow.mapNotNull { w ->
            foundNow[w.id]?.let { by -> HuntFind(w.id, w.label, by, w.lat, w.lng) }
        }
        if (finds.isNotEmpty()) withContext(Dispatchers.IO) { runCatching { tripStore.recordHunt(finds) } }
    }

    // Distance to a waypoint from the current fix.
    val loc = location
    fun distanceTo(w: Waypoint): Float? =
        loc?.let { distanceM(it.latitude, it.longitude, w.lat, w.lng) }

    // Auto-claim any UNFOUND waypoint the phone walks within range of.
    LaunchedEffect(loc?.latitude, loc?.longitude, waypoints.size) {
        val here = loc ?: return@LaunchedEffect
        waypoints.forEach { w ->
            if (found[w.id] == null) {
                val d = distanceM(here.latitude, here.longitude, w.lat, w.lng)
                if (d <= FOUND_RADIUS_M) claim(w)
            }
        }
    }

    val nearestUnfound: Pair<Waypoint, Float>? = waypoints
        .filter { found[it.id] == null }
        .mapNotNull { w -> distanceTo(w)?.let { w to it } }
        .minByOrNull { it.second }

    val status = when {
        messenger == null ->
            "Not connected to a Beebo Hub — connect one in Settings so finds sync to every phone. " +
                "You can still drop and find waypoints on this phone."
        !connected -> "Connecting to the room…"
        else -> "In the room — ${members.size} " + if (members.size == 1) "phone" else "phones"
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Campsite Scavenger Hunt", style = MaterialTheme.typography.titleLarge)
        Text(
            status,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Host / Hunt toggle — a host drops the waypoints; everyone else hunts.
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FilterChip(selected = isHost, onClick = { isHost = true }, label = { Text("Drop waypoints") })
            FilterChip(selected = !isHost, onClick = { isHost = false }, label = { Text("Go hunting") })
        }

        if (!granted) {
            // Graceful degrade: explain and offer a button to grant.
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Location needed", style = MaterialTheme.typography.titleMedium)
                    // Play requires a prominent disclosure BEFORE the runtime request, and it
                    // has to match what the code actually does. Verified against the code:
                    //   - a hunter's live position is never sent anywhere; distance to a
                    //     waypoint is computed on this device (see the `loc` state below)
                    //   - dropWaypoint() puts lat/lng into MSG_WAYPOINTS, which RoomMessenger
                    //     sends to hub.beebotv.com, which relays it to the other phones
                    //   - MSG_FOUND carries only an id and a name, no coordinates
                    //   - the hub holds rooms in memory (hub/src/room.js) and writes no
                    //     location to its database
                    // If any of that changes, this text has to change with it.
                    Text(
                        "The hunt uses this phone's GPS in two ways.\n\n" +
                            "While you're hunting, your position never leaves this phone. It's used " +
                            "here, on the device, to work out how far away a waypoint is.\n\n" +
                            "When you drop a waypoint, the coordinates of that one spot are sent to " +
                            "the other phones in your room, passed through Beebo's server so they can " +
                            "go and find it. Beebo relays those messages between phones and doesn't " +
                            "store them.\n\n" +
                            "That waypoint is the only location data that ever leaves this phone.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Button(onClick = {
                        permLauncher.launch(
                            arrayOf(
                                Manifest.permission.ACCESS_FINE_LOCATION,
                                Manifest.permission.ACCESS_COARSE_LOCATION,
                            ),
                        )
                    }) { Text("Allow location") }
                }
            }
        } else {
            Text(
                when {
                    loc == null -> "Waiting for a GPS fix…"
                    nearestUnfound != null ->
                        "Nearest waypoint: ${nearestUnfound.first.label} — " +
                            "${nearestUnfound.second.toInt()} m away"
                    waypoints.isEmpty() -> "No waypoints yet."
                    else -> "All waypoints found! 🎉"
                },
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Bold,
            )
        }

        if (isHost && granted) {
            HorizontalDivider()
            Text("Drop a waypoint here", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = newLabel,
                onValueChange = { newLabel = it },
                label = { Text("Label (e.g. \"By the big rock\")") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(enabled = loc != null, onClick = { dropWaypoint() }) {
                Text(if (loc == null) "Waiting for GPS…" else "Drop waypoint here")
            }
        }

        HorizontalDivider()

        val foundCount = waypoints.count { found[it.id] != null }
        Text(
            "Waypoints — $foundCount of ${waypoints.size} found",
            style = MaterialTheme.typography.titleMedium,
        )

        if (waypoints.isEmpty()) {
            Text(
                if (isHost) "Walk to a spot and tap \"Drop waypoint here\" to hide it."
                else "Waiting for the host to drop waypoints. Tap \"Drop waypoints\" to add your own.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            waypoints.forEach { w ->
                val finder = found[w.id]
                val d = distanceTo(w)
                WaypointRow(
                    label = w.label,
                    finder = finder,
                    mine = finder == myName,
                    distanceM = d,
                    canClaim = finder == null && d != null && d <= FOUND_RADIUS_M,
                    onClaim = { claim(w) },
                )
            }
        }
    }
}

@Composable
private fun WaypointRow(
    label: String,
    finder: String?,
    mine: Boolean,
    distanceM: Float?,
    canClaim: Boolean,
    onClaim: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    label,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = if (finder != null) FontWeight.Normal else FontWeight.Bold,
                )
                Text(
                    when {
                        finder != null && mine -> "Found by you!"
                        finder != null -> "Found by $finder"
                        distanceM != null -> "${distanceM.toInt()} m away"
                        else -> "Distance unknown"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (finder != null) scheme.primary else scheme.onSurfaceVariant,
                )
            }
            if (finder == null) {
                OutlinedButton(enabled = canClaim, onClick = onClaim) {
                    Text(if (canClaim) "I found it!" else "Get closer")
                }
            } else {
                Text("✓", style = MaterialTheme.typography.titleLarge, color = scheme.primary)
            }
        }
    }
}

/** Merge a hunt_full snapshot: adopt its waypoint list (if we have none) and its found flags. */
private fun mergeSnapshot(
    msg: RoomEvent.App,
    waypoints: SnapshotStateList<Waypoint>,
    applyFound: (String, String) -> Unit,
) {
    val listText = msg.data["list"]?.jsonPrimitive?.content
    if (listText != null && waypoints.isEmpty()) {
        waypoints.addAll(decodeWaypoints(listText))
    }
    val foundText = msg.data["found"]?.jsonPrimitive?.content ?: return
    val obj = runCatching { huntJson.parseToJsonElement(foundText).jsonObject }.getOrNull() ?: return
    obj.forEach { (id, el) ->
        val by = runCatching { el.jsonPrimitive.content }.getOrNull() ?: return@forEach
        applyFound(id, by)
    }
}

/** Encode the live found map as a JSON object id -> finderName for a snapshot. */
private fun encodeFound(found: Map<String, String>) = buildJsonObject {
    found.forEach { (id, by) -> put(id, by) }
}
