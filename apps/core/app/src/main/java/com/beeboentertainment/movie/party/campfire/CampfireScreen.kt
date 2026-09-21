package com.beeboentertainment.movie.party.campfire

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.badges.BadgeStore
import com.beeboentertainment.movie.party.RoomMessenger
import com.beeboentertainment.movie.party.rememberRoomMessenger
import kotlinx.coroutines.delay
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/*
 * "Campfire Mode" — a calm second act for when the car is parked at a campsite. Two things
 * stay in sync across every phone in the room, all over the SAME hub /room socket the watch
 * party, games and checklist already use (RoomMessenger -> RoomClient), no new server:
 *
 *   (a) A shared ambient soundscape. One phone (the host) picks an ambience and play/pauses;
 *       the choice + play state fan out so every phone plays the same loop together.
 *   (b) A shared photo slideshow. Each phone picks its own local photos via the system photo
 *       picker; the host also broadcasts its picks. The *current slide index* and its advance
 *       are synced, so slides step forward together on every phone. A phone shows its own picks
 *       when it has some (the offline-friendly path), otherwise it tries the host's shared URIs.
 *
 * Wire protocol (RoomClient.sendApp {type, ...}; the hub relays, stamps `from`, never echoes us):
 *
 *   campfire_sound  { trackId, playing }         host sets the ambience + play state
 *   campfire_slides { uris: <json array string> }host shares the photo list it picked
 *   campfire_index  { i }                         the current slide index (host drives the clock)
 *
 * On a new member joining, the host re-broadcasts all three so the newcomer lands in sync.
 */

private const val MSG_SOUND = "campfire_sound"
private const val MSG_SLIDES = "campfire_slides"
private const val MSG_INDEX = "campfire_index"

/** Seconds each slide is held before the host advances the shared index. */
private const val SLIDE_SECONDS = 6L

private val uriListJson = Json { ignoreUnknownKeys = true }
private fun encodeUris(uris: List<String>): String =
    runCatching { uriListJson.encodeToString(ListSerializer(String.serializer()), uris) }.getOrDefault("[]")
private fun decodeUris(text: String): List<String> =
    runCatching { uriListJson.decodeFromString(ListSerializer(String.serializer()), text) }.getOrDefault(emptyList())

/**
 * Route-level entry point, mirroring [com.beeboentertainment.movie.party.games.ThisOrThatScreen]:
 * builds a [RoomMessenger] for the signed-in hub account and hands it to [CampfireMode]. With no
 * hub the screen still works locally (pick photos, hear the loop) — nothing syncs, but it's never
 * a dead end.
 */
@Composable
fun CampfireScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val deviceName = remember { session.userName?.takeIf { it.isNotBlank() } ?: "Camper" }
    val messenger = rememberRoomMessenger(session, deviceName)

    // Parking at the campsite is a trip landmark — count it (deduped per day) toward the
    // "Road Trip Veteran" badge. Purely additive; reads/writes only the badge keys.
    LaunchedEffect(Unit) { BadgeStore.recordTripToday(session.plain) }

    CampfireMode(messenger = messenger, modifier = modifier)
}

@Composable
fun CampfireMode(messenger: RoomMessenger?, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val connected = messenger?.connected?.collectAsState()?.value ?: false
    val members = messenger?.members?.collectAsState()?.value ?: emptyList()

    // Whether this phone drives the campfire (soundscape choice + slideshow clock). Mirrors the
    // party/game Host/Join chips.
    var isHost by remember { mutableStateOf(false) }

    // ---- Soundscape state (synced) ----
    var trackId by remember { mutableStateOf<String?>(null) }
    var playing by remember { mutableStateOf(false) }

    // ---- Slideshow state ----
    val myUris = remember { mutableStateListOf<Uri>() }       // this phone's own picks
    val sharedUris = remember { mutableStateListOf<String>() } // host's broadcast picks
    var slideIndex by remember { mutableStateOf(0) }

    // The list this phone actually shows: its own picks first (offline-friendly), else the host's.
    val displayUris: List<Uri> = if (myUris.isNotEmpty()) myUris.toList()
    else sharedUris.mapNotNull { runCatching { Uri.parse(it) }.getOrNull() }

    // The looping player. Rebuilt only if the context changes; released on dispose.
    val soundPlayer = remember(context) { AmbiencePlayer(context) }
    var audioAvailable by remember { mutableStateOf(true) }
    DisposableEffect(soundPlayer) { onDispose { soundPlayer.release() } }
    // Keep the actual audio in step with the synced (trackId, playing).
    LaunchedEffect(trackId, playing) {
        audioAvailable = soundPlayer.apply(trackId, playing)
    }

    // The system photo picker (ACTION_PICK / PickVisualMedia). Multiple images, offline.
    val pickImages = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(),
    ) { uris ->
        if (uris.isNotEmpty()) {
            myUris.clear()
            myUris.addAll(uris)
            slideIndex = 0
            // Share our picks + reset the shared clock. Cross-device content URIs may not resolve
            // on peers; those phones fall back to their own picks against the same synced index.
            messenger?.send(MSG_SLIDES, buildJsonObject { put("uris", encodeUris(uris.map { it.toString() })) })
            messenger?.send(MSG_INDEX, buildJsonObject { put("i", 0) })
        }
    }

    fun broadcastSound() {
        messenger?.send(
            MSG_SOUND,
            buildJsonObject {
                put("trackId", trackId ?: "")
                put("playing", playing)
            },
        )
    }

    fun chooseTrack(id: String) {
        trackId = id
        playing = true
        broadcastSound()
    }

    fun togglePlay() {
        playing = !playing
        broadcastSound()
    }

    // Fold in peers' campfire envelopes.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_SOUND -> {
                    val id = msg.data["trackId"]?.jsonPrimitive?.content
                    trackId = id?.takeIf { it.isNotBlank() }
                    playing = msg.data["playing"]?.jsonPrimitive?.booleanOrNull ?: false
                }
                MSG_SLIDES -> {
                    val text = msg.data["uris"]?.jsonPrimitive?.content ?: return@collect
                    sharedUris.clear()
                    sharedUris.addAll(decodeUris(text))
                }
                MSG_INDEX -> {
                    val i = msg.data["i"]?.jsonPrimitive?.intOrNull ?: return@collect
                    slideIndex = i
                }
            }
        }
    }

    // A newcomer catches up: the host re-sends the full campfire state.
    LaunchedEffect(messenger, isHost) {
        messenger?.memberJoined?.collect {
            if (isHost) {
                broadcastSound()
                messenger.send(MSG_SLIDES, buildJsonObject { put("uris", encodeUris(sharedUris.toList())) })
                messenger.send(MSG_INDEX, buildJsonObject { put("i", slideIndex) })
            }
        }
    }

    // The host drives the slideshow clock: advance the shared index on a timer and broadcast it.
    // Everyone (host + peers) renders their display list at that index, so slides step together.
    LaunchedEffect(isHost, displayUris.size) {
        if (!isHost || displayUris.size < 2) return@LaunchedEffect
        while (true) {
            delay(SLIDE_SECONDS * 1000)
            val next = (slideIndex + 1) % displayUris.size
            slideIndex = next
            messenger?.send(MSG_INDEX, buildJsonObject { put("i", next) })
        }
    }

    val status = when {
        messenger == null ->
            "Not connected to a Beebo Hub — connect one in Settings to share the campfire with the car. " +
                "You can still set the mood on this phone."
        !connected -> "Connecting to the room…"
        else -> "Around the campfire — ${members.size} " + if (members.size == 1) "phone" else "phones"
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Campfire Mode", style = MaterialTheme.typography.titleLarge)
        Text(
            status,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Host / Join toggle — a host picks the ambience and runs the slideshow clock.
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FilterChip(selected = isHost, onClick = { isHost = true }, label = { Text("Run the campfire") })
            FilterChip(selected = !isHost, onClick = { isHost = false }, label = { Text("Just relax") })
        }

        // ---- Soundscape ----
        Text("Ambient sound", style = MaterialTheme.typography.titleMedium)
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AMBIENCES.forEach { amb ->
                FilterChip(
                    selected = amb.id == trackId,
                    onClick = { if (isHost) chooseTrack(amb.id) },
                    enabled = isHost,
                    label = { Text("${amb.emoji} ${amb.label}") },
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(enabled = isHost && trackId != null, onClick = { togglePlay() }) {
                Icon(
                    if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (playing) "Pause" else "Play",
                )
                Text(if (playing) "  Pause" else "  Play")
            }
            Text(
                when {
                    trackId == null -> if (isHost) "Pick an ambience above." else "Waiting for the host to pick a sound."
                    !audioAvailable -> "${ambienceById(trackId)?.label} — synced (this phone couldn't play sound)"
                    playing -> "${ambienceById(trackId)?.label} — playing"
                    else -> "${ambienceById(trackId)?.label} — paused"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        HorizontalDivider()

        // ---- Slideshow ----
        Text("Photo slideshow", style = MaterialTheme.typography.titleMedium)
        Card(Modifier.fillMaxWidth()) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(4f / 3f)
                    .clip(RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                if (displayUris.isEmpty()) {
                    Text(
                        "No photos yet — tap \"Add photos\" to pick some from this phone. " +
                            "Slides advance together on every phone.",
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(24.dp),
                    )
                } else {
                    val safeIndex = if (displayUris.isEmpty()) 0 else slideIndex % displayUris.size
                    AsyncImage(
                        model = displayUris[safeIndex],
                        contentDescription = "Slide ${safeIndex + 1}",
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(onClick = {
                pickImages.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                )
            }) { Text("Add photos") }
            if (displayUris.isNotEmpty()) {
                Text(
                    "Slide ${(slideIndex % displayUris.size) + 1} of ${displayUris.size}" +
                        if (myUris.isEmpty() && sharedUris.isNotEmpty()) " (shared)" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
