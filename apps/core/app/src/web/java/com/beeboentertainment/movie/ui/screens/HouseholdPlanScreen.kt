package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Website/sideload build: no in-app purchase flow here at all (the website keeps selling and
 * managing the household plan through Stripe, unchanged). Same route/composable name as the Play
 * build's real Play Billing screen (src/play) so MainActivity.kt can reference it unconditionally,
 * exactly the pattern DistributionFeatures already uses. See
 * docs/GOOGLE-PLAY-BILLING-AND-SEAT-ADDON.md section 6.1.
 */
@Composable
fun HouseholdPlanScreen() {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Household plan", style = MaterialTheme.typography.headlineSmall)
        Text("Manage your household's plan and extra household spots from Beebo's website, on the same account you use here.")
    }
}
