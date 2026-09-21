package com.beeboentertainment.movie.campsite

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Hiking
import androidx.compose.material.icons.filled.LocalGasStation
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Cabin
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

/*
 * "Nearby" — pure link-outs. Rather than rebuild a trail finder, campsite database, gas-price map
 * or weather service, this hands off to the apps that already do each best. Every button fires an
 * ACTION_VIEW Intent at the service's https URL, which opens the native app when it's installed and
 * otherwise falls back to the website in a browser. It is deliberately, clearly a hand-off — each
 * row says which app it opens — so there is no pretense of doing the work in-house.
 */

private data class Nearby(
    val title: String,
    val subtitle: String,
    val url: String,
    val icon: ImageVector,
)

private val LINKS = listOf(
    Nearby(
        title = "Find a Trail",
        subtitle = "Opens AllTrails — maps, reviews & difficulty for nearby hikes",
        url = "https://www.alltrails.com/explore",
        icon = Icons.Filled.Hiking,
    ),
    Nearby(
        title = "Find a Campsite",
        subtitle = "Opens Recreation.gov — book campgrounds on public lands",
        url = "https://www.recreation.gov/",
        icon = Icons.Filled.Cabin,
    ),
    Nearby(
        title = "Gas Prices",
        subtitle = "Opens GasBuddy — cheapest fuel near you",
        url = "https://www.gasbuddy.com/",
        icon = Icons.Filled.LocalGasStation,
    ),
    Nearby(
        title = "Weather",
        subtitle = "Opens Weather.com — the forecast for where you are",
        url = "https://weather.com/",
        icon = Icons.Filled.Cloud,
    ),
)

@Composable
fun NearbyScreen(modifier: Modifier = Modifier) {
    val context = LocalContext.current

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Nearby", style = MaterialTheme.typography.titleLarge)
        Text(
            "Quick jumps to the best apps for the trip. Each opens the app if you have it, or its " +
                "website if you don't.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        LINKS.forEach { link ->
            Card(
                Modifier.fillMaxWidth().clickable {
                    // ACTION_VIEW to the https URL: opens the native app if installed, else the web.
                    runCatching {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse(link.url)).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            },
                        )
                    }
                },
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        link.icon,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(32.dp),
                    )
                    Spacer(Modifier.size(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(link.title, style = MaterialTheme.typography.titleMedium)
                        Text(
                            link.subtitle,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Icon(
                        Icons.Filled.OpenInNew,
                        contentDescription = "Opens externally",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
