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
import com.beeboentertainment.movie.core.TvFeatures

/**
 * Amazon Appstore build (Fire TV and Fire tablets): no in-app purchase flow at all - the same
 * line the Play build shows on a TV. Same route/composable name as the play build's real screen
 * so MainActivity.kt can reference it unconditionally. The wording is TvFeatures's, which the
 * payments guard (PaymentsGuardTest, checkAmazonDebugPolicy) already accepts.
 */
@Composable
fun HouseholdPlanScreen() {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Household plan", style = MaterialTheme.typography.headlineSmall)
        Text(TvFeatures.MANAGE_ON_PHONE_MESSAGE)
    }
}
