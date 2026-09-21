package com.beeboentertainment.movie.party

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.core.TvFeatures
import com.beeboentertainment.movie.ui.tv.LocalIsTv

@Composable
fun WatchTogetherScreen(onMovies: () -> Unit, onDownloads: () -> Unit, onSettings: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Watch Together", style = MaterialTheme.typography.headlineMedium)
        Text("Play, pause and seek together using the video player's Watch together button.")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("1. Open a movie or episode on each phone. Any one will do \u2014 viewers follow the host.")
                Text("2. Tap the picture to show the player controls, then tap 👥 Watch together.")
                Text("3. One phone chooses Host. The others choose Join as viewer in the same hub household.")
                Text("4. Use the host's player to play, pause, seek or change film. The viewers follow.")
            }
        }
        Text("Online sync needs an internet connection and hub sign-in on each app. When the host changes film, each viewer looks that title up on its own server and opens it \u2014 a phone whose account cannot reach that title says so and stays where it is.", style = MaterialTheme.typography.bodyMedium)
        Button(onClick = onMovies, modifier = Modifier.fillMaxWidth()) { Text("Choose a movie") }
        if (TvFeatures.downloadsAvailable(LocalIsTv.current)) {
            OutlinedButton(onClick = onDownloads, modifier = Modifier.fillMaxWidth()) { Text("Open downloads") }
        }
        OutlinedButton(onClick = onSettings, modifier = Modifier.fillMaxWidth()) { Text("Hub sign-in & settings") }
        Text("Campsite guests: the local browser can also watch together — join a \"Playing now\" session from the library to stay in sync with the host and other guests, or open any shared video on your own to watch it independently.", style = MaterialTheme.typography.bodyMedium)
    }
}
