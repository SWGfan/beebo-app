package com.beeboentertainment.movie.stories

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.BeeboApp

/** The computer takes four characters and no more, so the form offers exactly four. */
private const val MAX_CHARACTERS = 4

/**
 * Ask the home computer to write a brand new storybook.
 *
 * This sits on the story shelf, above the books, because that is where a parent already chooses a
 * story and types their child's names in. Nothing else in the app is about stories, and a new book
 * is only worth having next to the ones it joins.
 *
 * The writing itself is handed to [StoryCowriterService] the moment the button is pressed. That is
 * not a detail: a local language model writing ten pages is minutes of work, and this card must be
 * free to disappear - pocket the phone, leave Story Mode, close Beebo - without taking the story
 * with it. What is left here is a live view of [StoryCowriterProgress] and, at the end, a way in.
 *
 * Everything that can go wrong says so in one plain sentence: no computer paired, signed out,
 * Ollama never installed, a model that wrote nonsense, a computer that restarted mid-story. None
 * of it touches the seventeen books in the APK, which keep working with no computer at all.
 */
@Composable
internal fun StoryCowriterCard(notifyAllowed: Boolean, onAskNotify: () -> Unit, onOpen: (String) -> Unit) {
    val context=LocalContext.current
    val progress by StoryCowriterProgress.state.collectAsState()
    var title by rememberSaveable { mutableStateOf("") }
    var idea by rememberSaveable { mutableStateOf("") }
    var names by rememberSaveable { mutableStateOf(List(MAX_CHARACTERS){ "" }) }
    var roles by rememberSaveable { mutableStateOf(List(MAX_CHARACTERS){ "" }) }
    var open by rememberSaveable { mutableStateOf(false) }

    // Read once per composition rather than watched: a story cannot be started without a computer,
    // and this only decides whether to offer the button or explain why there is none.
    val session=remember { BeeboApp.instance.session }
    val connected=!session.baseUrl.isNullOrBlank() && !session.token.isNullOrBlank()
    val characters=(0 until MAX_CHARACTERS).mapNotNull { index ->
        names[index].trim().takeIf { it.isNotEmpty() }?.let { name -> name to roles[index].trim() }
    }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text("Write a new story",style=MaterialTheme.typography.titleMedium)

            if(progress.running){
                Text(progress.message ?: "Asking your computer to start writing...",
                    style=MaterialTheme.typography.bodyMedium)
                Text(
                    if(notifyAllowed) "You can leave this screen or close Beebo. Your phone will tell you when the story is written."
                    else "You can leave this screen - it keeps going. Notifications are off for Beebo, so come back here to see when it is done.",
                    style=MaterialTheme.typography.bodyMedium
                )
                LinearProgressIndicator(Modifier.fillMaxWidth())
                TextButton(onClick={ StoryCowriterService.stop(context) }){Text("Stop waiting on this phone")}
                return@Column
            }

            val ready=progress.readySlug
            if(ready!=null){
                val written=progress.title.ifBlank { "Your story" }
                Text("$written is written and on the shelf.",style=MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                    Button(onClick={ StoryCowriterProgress.clearReady();onOpen(ready) }){Text("Read it now")}
                    TextButton(onClick={ StoryCowriterProgress.clearReady();open=true }){Text("Write another")}
                }
                return@Column
            }

            progress.error?.let { Text(it,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodyMedium) }

            if(!connected){
                Text("Your computer writes these stories with its own AI. Connect this phone to your Beebo computer and sign in to use it. The books already on your phone work without it.",
                    style=MaterialTheme.typography.bodyMedium)
                return@Column
            }

            if(!open){
                Text("Your computer can write a brand new story about anyone you like, using its own AI. It stays on your computer and costs nothing.",
                    style=MaterialTheme.typography.bodyMedium)
                Button(onClick={open=true},modifier=Modifier.fillMaxWidth()){Text("Write a new story")}
                return@Column
            }

            Text("Say what the story is about and who is in it. Your computer writes it - this takes a few minutes, and longer the first time.",
                style=MaterialTheme.typography.bodyMedium)
            OutlinedTextField(value=idea,onValueChange={idea=it.take(800)},
                label={Text("What happens in the story?")},minLines=3,modifier=Modifier.fillMaxWidth())
            OutlinedTextField(value=title,onValueChange={title=it.take(80)},
                label={Text("Title (optional)")},singleLine=true,modifier=Modifier.fillMaxWidth())
            (0 until MAX_CHARACTERS).forEach { index ->
                OutlinedTextField(value=names[index],
                    onValueChange={ value -> names=names.toMutableList().also{ it[index]=value.take(40) } },
                    label={Text(if(index==0)"Who is the story about?" else "Another character (optional)")},
                    singleLine=true,modifier=Modifier.fillMaxWidth())
                OutlinedTextField(value=roles[index],
                    onValueChange={ value -> roles=roles.toMutableList().also{ it[index]=value.take(120) } },
                    label={Text("Who are they? (optional)")},singleLine=true,modifier=Modifier.fillMaxWidth())
            }
            // The computer refuses both of these, but a greyed-out button explains itself better
            // than a round trip that comes back saying no.
            Button(
                enabled=idea.isNotBlank() && characters.isNotEmpty(),
                onClick={
                    if(!notifyAllowed)onAskNotify()
                    // The writing starts either way: a refused notification must not quietly do nothing.
                    StoryCowriterService.start(context,title.trim(),idea.trim(),characters)
                },
                modifier=Modifier.fillMaxWidth()
            ){Text("Ask my computer to write it")}
            Text("Keep the computer on and connected while it writes. Stories are made by a computer, not a person, so read a new one yourself before it is read to a child.",
                style=MaterialTheme.typography.bodyMedium)
        }
    }
}
