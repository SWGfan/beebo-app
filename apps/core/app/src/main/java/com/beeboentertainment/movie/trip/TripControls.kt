package com.beeboentertainment.movie.trip

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp

/**
 * "We're heading out" and "We're home": the two taps that make a trip. Shown on the Campsite
 * screen and at the top of the recap so it is where people already are.
 *
 * Starting a trip copies the packing list and the badges earned so far; finishing copies them
 * again. Nothing else is asked of anybody and nothing leaves the phone.
 */
@Composable
fun TripControlCard(modifier: Modifier = Modifier, onChanged: () -> Unit = {}) {
    val session = remember { BeeboApp.instance.session }
    val store = remember { TripStore.forApp(session.plain) }
    var rev by remember { mutableIntStateOf(0) }
    val active = remember(rev) { store.active() }
    var askName by remember { mutableStateOf(false) }

    fun changed() {
        rev++
        onChanged()
    }

    Card(modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (active == null) {
                Text("Trip journal", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
                Text(
                    "Tap when you leave and again when you're home. The games, stories, badges and packing list " +
                        "from that stretch become one recap you can present or save as a video. It all stays on this phone.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(onClick = { askName = true }, Modifier.fillMaxWidth()) { Text("We're heading out") }
            } else {
                Text("On a trip: ${active.name}", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
                Text(
                    "Started " + TripFormat.dateRange(active.startedAt, 0L, System.currentTimeMillis()) +
                        ". Games, stories and hunt finds from now are kept for the recap.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TripNames(active, store, onAdded = { changed() })
                LocationOptIn(active, store, onChanged = { changed() })
                Button(
                    onClick = {
                        store.end(TripData.badgesNow(session), TripData.packingNow(session), TripData.rosterFor(active, session))
                        changed()
                    },
                    Modifier.fillMaxWidth(),
                ) { Text("We're home") }
            }
        }
    }

    if (askName) {
        StartTripDialog(
            onStart = { name, names ->
                store.start(name, names, TripData.badgesNow(session), TripData.packingNow(session))
                askName = false
                changed()
            },
            onDismiss = { askName = false },
        )
    }
}

@Composable
private fun StartTripDialog(onStart: (String, List<String>) -> Unit, onDismiss: () -> Unit) {
    var name by rememberSaveable { mutableStateOf("Our trip") }
    var people by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("We're heading out") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it.take(TripLogic.MAX_NAME) },
                    label = { Text("Trip name") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = people, onValueChange = { people = it.take(300) },
                    label = { Text("Who's coming (optional, separate with commas)") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(NAMES_NOTE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = {
            TextButton(onClick = { onStart(name, splitNames(people)) }) { Text("Start trip") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun TripNames(trip: Trip, store: TripStore, onAdded: () -> Unit) {
    var draft by rememberSaveable { mutableStateOf("") }
    if (trip.roster.isNotEmpty()) {
        Text("With " + trip.roster.joinToString(", "), style = MaterialTheme.typography.bodyMedium)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = draft, onValueChange = { draft = it.take(120) },
            label = { Text("Add a name") }, singleLine = true, modifier = Modifier.weight(1f),
        )
        OutlinedButton(enabled = draft.isNotBlank(), onClick = {
            store.addRoster(trip.id, splitNames(draft))
            draft = ""
            onAdded()
        }) { Text("Add") }
    }
    Text(NAMES_NOTE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun LocationOptIn(trip: Trip, store: TripStore, onChanged: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text("Save hunt locations", style = MaterialTheme.typography.bodyLarge)
            Text(
                "Off: a scavenger hunt keeps only what was found and who found it. On: each found waypoint's " +
                    "coordinates are kept on this phone as well. Turning it off erases them.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = trip.saveLocation, onCheckedChange = { store.setSaveLocation(it); onChanged() })
    }
}

private const val NAMES_NOTE =
    "Names are whatever people typed on their phones. Nothing checks who they are, and two people who type " +
        "the same name count as one."

/** Names typed as "Ana, Ben, Dad": split on commas and newlines, blanks dropped. */
internal fun splitNames(text: String): List<String> =
    text.split(',', '\n', ';').map { it.trim() }.filter { it.isNotEmpty() }
