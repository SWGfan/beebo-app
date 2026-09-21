package com.beeboentertainment.movie.campsite.campfire

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.campsite.games.CampfireStoriesContent
import com.beeboentertainment.movie.campsite.games.StoryMood
import com.beeboentertainment.movie.trip.StoryResult
import com.beeboentertainment.movie.trip.TripStore
import java.security.SecureRandom
import kotlin.math.roundToInt

/**
 * Campfire Stories on the host phone: story starters, a story spinner with read-aloud,
 * and a turn-taking "next line" mode. Offline only - no network calls, no AI; every
 * word comes from the lists in [CampfireStoriesContent] or from the people at the fire.
 */
@Composable
fun CampfireStoriesScreen() {
    var night by rememberSaveable { mutableStateOf(false) }
    var textStep by rememberSaveable { mutableIntStateOf(2) }
    CampfireFrame(night, textStep) {
        StoriesPane(night, { night = it }, textStep, { textStep = it })
    }
}

@Composable
private fun StoriesPane(night: Boolean, onNight: (Boolean) -> Unit, textStep: Int, onTextStep: (Int) -> Unit) {
    val voice = rememberCampfireVoice()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var rate by rememberSaveable { mutableFloatStateOf(0.9f) }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Campfire Stories", style = MaterialTheme.typography.headlineMedium)
        CampfireDisplayBar(night, onNight, textStep, onTextStep)
        HowToPlayCard(
            steps = listOf(
                "Nobody keeps score - the story is the point.",
                "Starters: pick a tone and read a first line out loud. The next person carries on, and so on round the circle.",
                "Spinner: spin a character, a place, a problem and a twist, and get a whole short story to read or listen to.",
                "Next line mode: the story is revealed one sentence at a time, and anyone can type their own sentence to add to it.",
                "Read aloud uses this phone's built-in voice. Slide to change the speed.",
            ),
            note = "Night red dims the screen to a soft red that is easy on eyes used to the dark. Works with no internet.",
        )
        Text("Reading speed: ${(rate * 100).roundToInt()}%", style = MaterialTheme.typography.bodyLarge)
        Slider(
            value = rate, onValueChange = { rate = it }, valueRange = 0.5f..1.5f, steps = 9,
            modifier = Modifier.semantics { contentDescription = "Reading speed"; stateDescription = "${(rate * 100).roundToInt()} percent" },
        )
        TabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { tab = 0; voice.stop() }, text = { Text("Starters") })
            Tab(selected = tab == 1, onClick = { tab = 1; voice.stop() }, text = { Text("Spinner") })
        }
        if (tab == 0) Starters(voice, rate) else Spinner(voice, rate)
    }
}

@Composable
private fun Starters(voice: CampfireVoice, rate: Float) {
    var mood by rememberSaveable { mutableStateOf(StoryMood.COZY.wire) }
    val current = StoryMood.entries.first { it.wire == mood }
    val list = CampfireStoriesContent.STARTERS.getValue(current)
    var index by rememberSaveable { mutableIntStateOf(SecureRandom().nextInt(list.size)) }
    val starter = list[index.coerceIn(0, list.lastIndex)]

    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        StoryMood.entries.forEach { m ->
            FilterChip(selected = m.wire == mood, onClick = { mood = m.wire; index = SecureRandom().nextInt(list.size) }, label = { Text(m.label) })
        }
    }
    Card(Modifier.fillMaxWidth()) {
        Text(starter, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(20.dp))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { voice.speak(starter, rate) }) { Text("Read aloud") }
        OutlinedButton(onClick = { voice.stop() }) { Text("Stop") }
        OutlinedButton(onClick = {
            var next = SecureRandom().nextInt(list.size)
            if (next == index && list.size > 1) next = (next + 1) % list.size
            index = next
        }) { Text("Another") }
    }
    Text("${list.size} ${current.label.lowercase()} starters", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun Spinner(voice: CampfireVoice, rate: Float) {
    var seed by rememberSaveable { mutableLongStateOf(SecureRandom().nextLong()) }
    var lineMode by rememberSaveable { mutableStateOf(false) }
    var shown by rememberSaveable { mutableIntStateOf(1) }
    var added by rememberSaveable { mutableStateOf(listOf<String>()) }
    var draft by rememberSaveable { mutableStateOf("") }
    val story = CampfireStoriesContent.spin(seed)

    Button(onClick = { seed = SecureRandom().nextLong(); shown = 1; added = emptyList(); voice.stop() }, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
        Text("Spin a new story")
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Character: ${story.character}", style = MaterialTheme.typography.bodyLarge)
            Text("Place: ${story.place}", style = MaterialTheme.typography.bodyLarge)
            Text("Problem: ${story.problem}", style = MaterialTheme.typography.bodyLarge)
            Text("Twist: ${story.twist}", style = MaterialTheme.typography.bodyLarge)
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = !lineMode, onClick = { lineMode = false; voice.stop() }, label = { Text("Whole story") })
        FilterChip(selected = lineMode, onClick = { lineMode = true; shown = 1; voice.stop() }, label = { Text("Next line mode") })
    }

    val visible = if (lineMode) story.lines.take(shown) + added else story.lines
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            visible.forEach { Text(it, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Normal) }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { voice.speak(if (lineMode) visible.lastOrNull().orEmpty() else visible.joinToString(" "), rate) }) {
            Text(if (lineMode) "Read last line" else "Read aloud")
        }
        OutlinedButton(onClick = { voice.stop() }) { Text("Stop") }
        if (lineMode && shown < story.lines.size) {
            OutlinedButton(onClick = {
                shown++
                voice.speak(story.lines[shown - 1], rate)
            }) { Text("Next line") }
        }
    }
    SaveToTrip(story, visible, seed)
    if (lineMode) {
        Text("Your turn? Add a sentence and pass the phone on.", style = MaterialTheme.typography.bodyLarge)
        OutlinedTextField(
            value = draft, onValueChange = { draft = it.take(200) },
            label = { Text("Add the next sentence") }, modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = draft.isNotBlank() && added.size < 40, onClick = {
                val line = draft.trim()
                added = added + line; draft = ""
                voice.speak(line, rate)
            }) { Text("Add line") }
            if (added.isNotEmpty()) OutlinedButton(onClick = { added = added.dropLast(1) }) { Text("Undo last") }
        }
        if (added.isNotEmpty()) Text("Read the whole thing back:", style = MaterialTheme.typography.bodyMedium)
        if (added.isNotEmpty()) OutlinedButton(onClick = { voice.speak(visible.joinToString(" "), rate) }) { Text("Read everything aloud") }
    }
}

/**
 * A story spun on this phone has no natural end, so keeping it on the running trip is the
 * person's own tap. Shown only while a trip is running; saving again after adding lines updates
 * the same entry.
 */
@Composable
private fun SaveToTrip(story: CampfireStoriesContent.Spun, lines: List<String>, seed: Long) {
    val store = remember { TripStore.forApp(BeeboApp.instance.session.plain) }
    var savedAt by remember(seed) { mutableIntStateOf(-1) }
    if (store.active() == null) return
    val saved = savedAt == lines.size
    OutlinedButton(
        enabled = !saved,
        onClick = {
            val kept = store.recordStory(
                StoryResult(
                    id = "spin-$seed",
                    title = "Spinner story: ${story.character}",
                    mood = "Spinner",
                    tellers = emptyList(),
                    text = lines.joinToString(" "),
                ),
            )
            if (kept) savedAt = lines.size
        },
    ) { Text(if (saved) "Saved to your trip" else "Save this story to the trip") }
}
