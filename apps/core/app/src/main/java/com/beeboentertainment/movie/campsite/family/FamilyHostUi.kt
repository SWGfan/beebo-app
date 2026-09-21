package com.beeboentertainment.movie.campsite.family

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.campsite.CampsiteHost
import com.beeboentertainment.movie.campsite.CampsiteInvite
import com.beeboentertainment.movie.campsite.qrBitmap

/*
 * Small pieces of host-phone UI shared by the Songbook and Quiz screens. Kept in this package so the
 * shared Campsite screen files stay untouched apart from one entry each.
 */

/**
 * How guests reach [path] (for example "/songbook"): the address and a QR code while Campsite is
 * running, or a button that starts inviting when it is not. Everything on the host phone still works
 * with no guests and no network; this card only adds other people's phones.
 */
@Composable
internal fun FamilyGuestsCard(path: String, what: String) {
    val campsite by CampsiteHost.state.collectAsState()
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Other phones", fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            val url = campsite.url
            if (campsite.running && url != null) {
                val target = url + path
                val qr = remember(target) { qrBitmap(target, 600) }
                if (qr != null) Image(qr.asImageBitmap(), contentDescription = "Code to open $what on a guest's phone", modifier = Modifier.size(200.dp))
                Spacer(Modifier.height(6.dp))
                Text(target, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                Spacer(Modifier.height(4.dp))
                Text(
                    if (campsite.guests.isEmpty()) "Nobody has joined yet. Guests need to be on your campsite Wi-Fi."
                    else "${campsite.guests.size} connected: " + campsite.guests.joinToString(", "),
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text(
                    "This works on this phone alone, with no signal. To let other phones follow along, invite guests.",
                    fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(10.dp))
                Button(onClick = { CampsiteInvite.invitePlayers() }) { Text("Invite guests") }
            }
        }
    }
}

/** The two entry cards on the Campsite screen. Both open screens that work on this phone alone. */
@Composable
fun FamilyPackBEntryCards(onOpenSongbook: () -> Unit, onOpenQuiz: () -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        FamilyEntryCard("🎶", "Campfire Songbook", "Big-print traditional songs and rounds. Works offline.", onOpenSongbook)
        FamilyEntryCard("❓", "Roadside Quiz", "Animals, space, geography and more. Guests answer on their phones, or play on this one.", onOpenQuiz)
    }
}

@Composable
private fun FamilyEntryCard(icon: String, title: String, detail: String, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(icon, fontSize = 28.sp)
            Spacer(Modifier.size(14.dp))
            Column {
                Text(title, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                Spacer(Modifier.height(2.dp))
                Text(detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** A row of single-choice chips. [selected] is the index chosen. */
@Composable
internal fun <T> ChoiceChips(options: List<T>, selected: Int, label: (T) -> String, onPick: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEachIndexed { i, option ->
            FilterChip(selected = i == selected, onClick = { onPick(i) }, label = { Text(label(option), fontSize = 13.sp) })
        }
    }
}
