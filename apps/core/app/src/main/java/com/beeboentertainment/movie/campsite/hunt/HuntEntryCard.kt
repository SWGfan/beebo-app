package com.beeboentertainment.movie.campsite.hunt

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The entry card on the Campsite screen. It only opens the hunt's own screen. */
@Composable
fun HuntEntryCard(onOpen: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onOpen)) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("🔎", fontSize = 28.sp)
            Spacer(Modifier.size(14.dp))
            Column {
                Text("Scavenger Hunt for Everyone", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                Spacer(Modifier.height(2.dp))
                Text(
                    "Five hunt cards for the campsite, nature and rainy days. Guests join in their browser, no app or internet.",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
