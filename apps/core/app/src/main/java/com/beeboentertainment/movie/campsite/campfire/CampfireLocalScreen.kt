package com.beeboentertainment.movie.campsite.campfire

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Opens a game's own offline screen by its [com.beeboentertainment.movie.campsite.games.CampsiteGame.localRoute].
 * Nothing here starts the guest server or the hotspot.
 */
@Composable
internal fun CampfireLocalScreen(route: String, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        OutlinedButton(onClick = onBack, modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) { Text("← Games") }
        Box(Modifier.weight(1f)) {
            when (route) {
                "hotpotato" -> HotPotatoScreen()
                "naturebingo" -> NatureBingoScreen()
                "campfirestories" -> CampfireStoriesScreen()
                "classicbingo" -> ClassicBingoScreen()
                else -> Text("This game isn't available on this phone.", Modifier.padding(16.dp))
            }
        }
    }
}
