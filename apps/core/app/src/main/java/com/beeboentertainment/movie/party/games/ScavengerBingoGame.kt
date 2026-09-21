package com.beeboentertainment.movie.party.games

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.party.RoomEvent
import com.beeboentertainment.movie.party.RoomMessenger
import com.beeboentertainment.movie.party.rememberRoomMessenger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/*
 * "Road Trip Bingo" — the synced live-claim scavenger board and the flagship showcase
 * for the hub room plumbing (RoomMessenger -> RoomClient -> the same /room socket a watch
 * party uses). A shared checklist of things to spot; ANY passenger taps an item to CLAIM
 * it, and the claim lands on every phone at once with who got it. Once claimed, everyone
 * else sees it's taken — the "someone beat me to it" race is the whole point.
 *
 * Wire protocol (all ride RoomClient.sendApp {type, ...}; the hub stamps `from` and never
 * echoes our own):
 *
 *   bingo_claim  { packId, itemId, by, at }   a phone claims a square; peers fold it in
 *   bingo_pack   { packId }                    someone switched the active pack; all reset
 *   bingo_full   { packId, claims }            snapshot to a phone that just joined
 *                                                (claims = JSON object itemId -> {by,at})
 *
 * Convergence: a claim carries the claimant's [by] name and the wall-clock [at] it was
 * tapped. Every phone keeps the EARLIEST claim per square (tie-break by name), so two
 * people grabbing the same square converge to one winner everywhere without a server
 * tally — first tap wins, the slower tapper watches it flip to whoever beat them.
 */

private const val MSG_CLAIM = "bingo_claim"
private const val MSG_PACK = "bingo_pack"
private const val MSG_FULL = "bingo_full"

/** A single square to spot. [id] is stable on the wire; [label] is what the player sees. */
data class BingoItem(val id: String, val label: String)

/** A named board of squares the family can switch between. */
data class BingoPack(val id: String, val title: String, val items: List<BingoItem>)

/** Who claimed a square and when, so every phone can pick the same first-tap winner. */
private data class Claim(val by: String, val at: Long)

private val json = Json { ignoreUnknownKeys = true }

/** US state license plates — spot a car from each state. */
private val PLATE_PACK = BingoPack(
    id = "plates",
    title = "License plates",
    items = listOf(
        "AL" to "Alabama", "AK" to "Alaska", "AZ" to "Arizona", "AR" to "Arkansas",
        "CA" to "California", "CO" to "Colorado", "CT" to "Connecticut", "DE" to "Delaware",
        "FL" to "Florida", "GA" to "Georgia", "HI" to "Hawaii", "ID" to "Idaho",
        "IL" to "Illinois", "IN" to "Indiana", "IA" to "Iowa", "KS" to "Kansas",
        "KY" to "Kentucky", "LA" to "Louisiana", "ME" to "Maine", "MD" to "Maryland",
        "MA" to "Massachusetts", "MI" to "Michigan", "MN" to "Minnesota", "MS" to "Mississippi",
        "MO" to "Missouri", "MT" to "Montana", "NE" to "Nebraska", "NV" to "Nevada",
        "NH" to "New Hampshire", "NJ" to "New Jersey", "NM" to "New Mexico", "NY" to "New York",
        "NC" to "North Carolina", "ND" to "North Dakota", "OH" to "Ohio", "OK" to "Oklahoma",
        "OR" to "Oregon", "PA" to "Pennsylvania", "RI" to "Rhode Island", "SC" to "South Carolina",
        "SD" to "South Dakota", "TN" to "Tennessee", "TX" to "Texas", "UT" to "Utah",
        "VT" to "Vermont", "VA" to "Virginia", "WA" to "Washington", "WV" to "West Virginia",
        "WI" to "Wisconsin", "WY" to "Wyoming",
    ).map { (abbr, name) -> BingoItem(abbr, name) },
)

/** A themed "spot it out the window" list. */
private val SPOT_PACK = BingoPack(
    id = "spot",
    title = "Spot it!",
    items = listOf(
        "cow", "A cow", "yellowcar", "A yellow car", "reststop", "A rest stop",
        "redbarn", "A red barn", "watertower", "A water tower", "motorcycle", "A motorcycle",
        "policecar", "A police car", "schoolbus", "A school bus", "bridge", "A bridge",
        "tractor", "A tractor", "rv", "An RV / camper", "dogincar", "A dog in a car",
        "gasstation", "A gas station", "billboard", "A billboard", "tunnel", "A tunnel",
        "train", "A train", "horse", "A horse", "flag", "An American flag",
        "airplane", "An airplane overhead", "roadworkers", "Road workers",
    ).chunked(2).map { BingoItem(it[0], it[1]) },
)

private val PACKS = listOf(PLATE_PACK, SPOT_PACK)
private fun packById(id: String): BingoPack = PACKS.firstOrNull { it.id == id } ?: PLATE_PACK

/**
 * Route-level entry point: builds a [RoomMessenger] for the signed-in hub account and hands
 * it to the board. Falls back to a local-only board (taps claim for you, nothing syncs) when
 * the device isn't on a Beebo Hub, so the screen is never a dead end. Mirrors [ThisOrThatScreen].
 */
@Composable
fun ScavengerBingoScreen(modifier: Modifier = Modifier) {
    val session = remember { BeeboApp.instance.session }
    val myName = remember {
        session.userName?.takeIf { it.isNotBlank() } ?: "Player"
    }
    val messenger = rememberRoomMessenger(session, myName)
    ScavengerBingoGame(messenger = messenger, myName = myName, modifier = modifier)
}

@Composable
fun ScavengerBingoGame(
    messenger: RoomMessenger?,
    myName: String,
    modifier: Modifier = Modifier,
) {
    val connected = messenger?.connected?.collectAsState()?.value ?: false
    val members = messenger?.members?.collectAsState()?.value ?: emptyList()

    var packId by remember { mutableStateOf(PLATE_PACK.id) }
    val pack = packById(packId)
    // itemId -> who claimed it first. mutableStateMap repaints every board on a change.
    val claims = remember { mutableStateMapOf<String, Claim>() }

    // Keep only the earliest claim per square (tie-break by name) so all phones converge.
    fun applyClaim(itemId: String, by: String, at: Long) {
        val existing = claims[itemId]
        if (existing == null || at < existing.at || (at == existing.at && by < existing.by)) {
            claims[itemId] = Claim(by, at)
        }
    }

    // Switch to (or reset) a board: clears every claim and, when we drove it, tells the room.
    // A bingo_pack for the pack already showing is a deliberate "fresh board" reset.
    fun switchPack(id: String, broadcast: Boolean) {
        packId = id
        claims.clear()
        if (broadcast) messenger?.send(MSG_PACK, buildJsonObject { put("packId", id) })
    }

    fun claim(item: BingoItem) {
        if (claims[item.id] != null) return // already taken — someone beat us to it
        val at = System.currentTimeMillis()
        applyClaim(item.id, myName, at)
        messenger?.send(
            MSG_CLAIM,
            buildJsonObject {
                put("packId", packId)
                put("itemId", item.id)
                put("by", myName)
                put("at", at)
            },
        )
    }

    // Fold in peers' envelopes.
    LaunchedEffect(messenger) {
        messenger?.app?.collect { msg ->
            when (msg.msgType) {
                MSG_CLAIM -> {
                    val pid = msg.data["packId"]?.jsonPrimitive?.content ?: packId
                    if (pid != packId) return@collect
                    val itemId = msg.data["itemId"]?.jsonPrimitive?.content ?: return@collect
                    val by = msg.data["by"]?.jsonPrimitive?.content ?: msg.from.ifBlank { "Someone" }
                    val at = msg.data["at"]?.jsonPrimitive?.longOrNull ?: System.currentTimeMillis()
                    applyClaim(itemId, by, at)
                }
                MSG_PACK -> {
                    val pid = msg.data["packId"]?.jsonPrimitive?.content ?: return@collect
                    switchPack(pid, broadcast = false)
                }
                MSG_FULL -> {
                    val snapPack = msg.data["packId"]?.jsonPrimitive?.content ?: packId
                    // Adopt the sender's pack only if we haven't started our own board.
                    if (claims.isEmpty() && snapPack != packId) packId = snapPack
                    // Merge the snapshot's claims only when it's the board we're showing.
                    if (snapPack == packId) mergeSnapshotClaims(msg, ::applyClaim)
                }
            }
        }
    }

    // When someone new joins, push them the whole board so they start already in sync.
    LaunchedEffect(messenger) {
        messenger?.memberJoined?.collect {
            messenger.send(
                MSG_FULL,
                buildJsonObject {
                    put("packId", packId)
                    put("claims", encodeClaims(claims).toString())
                },
            )
        }
    }

    // Per-player tallies for the little scoreboard.
    val scores: List<Pair<String, Int>> = claims.values
        .groupingBy { it.by }.eachCount()
        .toList().sortedByDescending { it.second }

    val status = when {
        messenger == null ->
            "Not connected to a Beebo Hub — connect one in Settings to race the whole car. " +
                "You can still mark squares here."
        !connected -> "Connecting to the room…"
        else -> "In the room — ${members.size} " + if (members.size == 1) "player" else "players"
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Road Trip Bingo", style = MaterialTheme.typography.titleLarge)
        Text(
            status,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Pack picker — switching resets the board for everyone.
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            PACKS.forEach { p ->
                FilterChip(
                    selected = p.id == packId,
                    onClick = { switchPack(p.id, broadcast = true) },
                    label = { Text(p.title) },
                )
            }
        }

        Text(
            "Tap a square the moment you spot it — first tap wins it. ${claims.size} of " +
                "${pack.items.size} claimed.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Scoreboard.
        if (scores.isNotEmpty()) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Scores", style = MaterialTheme.typography.titleMedium)
                    scores.forEach { (name, count) ->
                        val mine = name == myName
                        Text(
                            (if (mine) "You" else name) + ": $count",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (mine) FontWeight.Bold else FontWeight.Normal,
                            color = if (mine) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        }

        // The board — a two-column grid of tappable squares.
        val cols = 2
        pack.items.chunked(cols).forEach { rowItems ->
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                rowItems.forEach { item ->
                    BingoSquare(
                        item = item,
                        claim = claims[item.id],
                        mine = claims[item.id]?.by == myName,
                        onClaim = { claim(item) },
                        modifier = Modifier.weight(1f),
                    )
                }
                // Pad a short final row so single squares don't stretch full width.
                repeat(cols - rowItems.size) { Spacer(Modifier.weight(1f)) }
            }
        }

        OutlinedButton(onClick = { switchPack(packId, broadcast = true) }) {
            Text("Start a fresh board")
        }
    }
}

@Composable
private fun BingoSquare(
    item: BingoItem,
    claim: Claim?,
    mine: Boolean,
    onClaim: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val claimed = claim != null
    val container = when {
        mine -> scheme.primaryContainer
        claimed -> scheme.tertiaryContainer
        else -> scheme.secondaryContainer
    }
    val onContainer = when {
        mine -> scheme.onPrimaryContainer
        claimed -> scheme.onTertiaryContainer
        else -> scheme.onSecondaryContainer
    }
    Box(
        modifier = modifier
            .heightIn(min = 84.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(container)
            .then(
                if (mine) Modifier.border(3.dp, scheme.primary, RoundedCornerShape(16.dp))
                else Modifier
            )
            .clickable(enabled = !claimed) { onClaim() }
            .padding(10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                item.label,
                textAlign = TextAlign.Center,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                color = onContainer,
            )
            if (claimed) {
                Text(
                    if (mine) "You got it!" else "${claim!!.by} got it",
                    textAlign = TextAlign.Center,
                    fontSize = 13.sp,
                    color = onContainer,
                )
            }
        }
    }
}

/**
 * Merge a bingo_full snapshot's claims into local state via the same earliest-wins rule used
 * for live claims, so a late joiner lands already caught up. The caller has already decided the
 * snapshot is for the board we're showing.
 */
private fun mergeSnapshotClaims(
    msg: RoomEvent.App,
    applyClaim: (String, String, Long) -> Unit,
) {
    val text = msg.data["claims"]?.jsonPrimitive?.content ?: return
    val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
    obj.forEach { (itemId, el) ->
        val o = runCatching { el.jsonObject }.getOrNull() ?: return@forEach
        val by = o["by"]?.jsonPrimitive?.content ?: return@forEach
        val at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L
        applyClaim(itemId, by, at)
    }
}

/** Encode the live claim map as a JSON object itemId -> {by, at} for a snapshot. */
private fun encodeClaims(claims: Map<String, Claim>) = buildJsonObject {
    claims.forEach { (itemId, c) ->
        put(itemId, buildJsonObject {
            put("by", c.by)
            put("at", c.at)
        })
    }
}
