package com.beeboentertainment.movie.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.HideSource
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.core.HouseholdAvailability
import com.beeboentertainment.movie.core.HouseholdSourcePresentation

/** A passive label: no playback, navigation, or network side effects. Text carries the status too. */
@Composable
fun HouseholdSourceLabel(source: HouseholdSourcePresentation, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val (background, foreground) = when (source.availability) {
        HouseholdAvailability.AVAILABLE -> scheme.primaryContainer to scheme.onPrimaryContainer
        HouseholdAvailability.OFFLINE -> scheme.secondaryContainer to scheme.onSecondaryContainer
        HouseholdAvailability.MISSING -> scheme.tertiaryContainer to scheme.onTertiaryContainer
        HouseholdAvailability.UNKNOWN -> scheme.surfaceVariant to scheme.onSurfaceVariant
    }
    val icon = when (source.availability) {
        HouseholdAvailability.AVAILABLE -> Icons.Outlined.CheckCircle
        HouseholdAvailability.OFFLINE -> Icons.Outlined.CloudOff
        HouseholdAvailability.MISSING -> Icons.Outlined.HideSource
        HouseholdAvailability.UNKNOWN -> Icons.AutoMirrored.Outlined.HelpOutline
    }
    Surface(modifier = modifier, color = background, contentColor = foreground, shape = MaterialTheme.shapes.small) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp).semantics(mergeDescendants = true) {},
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(icon, contentDescription = null)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(source.label, style = MaterialTheme.typography.labelMedium)
                source.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}
