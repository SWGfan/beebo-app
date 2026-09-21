package com.beeboentertainment.movie.tts

import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale

/*
 * "Read It To Me" — paste in as much text as you like and have the phone read it aloud.
 *
 * Deliberately a whole page rather than a dialog: the point is a big, comfortable field you
 * can paste a long article or a chapter into and still see what you're doing.
 *
 * Everything here is on-device (android.speech.tts). Nothing is uploaded, nothing is stored,
 * and it works with no signal — so it is safe to paste personal text into.
 *
 * The one real constraint is that Android's TTS engine rejects a single utterance longer than
 * TextToSpeech.getMaxSpeechInputLength() (commonly 4000 characters), so the text is split into
 * sentence-sized chunks and queued. That split is also what makes progress and pause/resume
 * work: we resume at the start of the chunk we were on, not back at the beginning.
 */

/**
 * Longest run of text handed to the engine at once.
 *
 * Android's limit is around 4000 characters, but this is deliberately far smaller. The chunk
 * is also the RESUME GRANULARITY: pausing and resuming, and changing speed mid-read, both
 * re-queue from the start of the current chunk. With one giant chunk, "Resume" would replay
 * the whole article from the top and progress would forever read "Part 1 of 1". Roughly a
 * paragraph is small enough to feel precise and large enough that the voice never sounds
 * chopped - and chunkForSpeech still prefers to break at the end of a sentence.
 */
private const val MAX_CHUNK = 400

/**
 * Split [text] into chunks no longer than [MAX_CHUNK], preferring to break at the end of a
 * sentence, then at a line break, then at a space, and only mid-word as a last resort. Keeping
 * whole sentences together is what stops the voice from clipping oddly between chunks.
 */
internal fun chunkForSpeech(text: String, max: Int = MAX_CHUNK): List<String> {
    val clean = text.trim()
    if (clean.isEmpty()) return emptyList()
    if (clean.length <= max) return listOf(clean)

    val out = mutableListOf<String>()
    var start = 0
    while (start < clean.length) {
        if (clean.length - start <= max) {
            out += clean.substring(start).trim()
            break
        }
        val window = clean.substring(start, start + max)
        // Prefer the last sentence end, then a paragraph break, then a space.
        val cut = listOf(
            window.lastIndexOfAny(charArrayOf('.', '!', '?', '…')),
            window.lastIndexOf('\n'),
            window.lastIndexOf(' '),
        ).firstOrNull { it > max / 4 } ?: (max - 1)

        out += window.substring(0, cut + 1).trim()
        start += cut + 1
    }
    return out.filter { it.isNotEmpty() }
}

@Composable
fun ReadItToMeScreen(modifier: Modifier = Modifier) {
    val context = LocalContext.current

    var text by remember { mutableStateOf("") }
    var ready by remember { mutableStateOf(false) }
    var unavailable by remember { mutableStateOf<String?>(null) }
    var speaking by remember { mutableStateOf(false) }
    var paused by remember { mutableStateOf(false) }
    var rate by remember { mutableStateOf(1.0f) }

    // Chunk index currently being spoken, and the chunk list it refers to.
    var spokenIndex by remember { mutableIntStateOf(0) }
    var chunks by remember { mutableStateOf<List<String>>(emptyList()) }

    // One engine for the life of the screen. Created in remember (not a side effect) so it is
    // available to the callbacks below; torn down in the DisposableEffect.
    val tts = remember {
        // The init callback needs the engine it is initialising, which does not exist yet at
        // the point the callback is written. A one-slot holder is the least clever way out:
        // the callback is asynchronous, so the slot is always filled before it fires.
        val holder = arrayOfNulls<TextToSpeech>(1)
        val engine = TextToSpeech(context.applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val e = holder[0]
                val r = e?.setLanguage(Locale.getDefault())
                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                    // Fall back to US English rather than failing outright.
                    e?.setLanguage(Locale.US)
                }
                ready = true
            } else {
                unavailable = "This phone doesn't have a text-to-speech voice installed."
            }
        }
        holder[0] = engine
        engine
    }

    DisposableEffect(Unit) {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                utteranceId?.toIntOrNull()?.let { spokenIndex = it }
            }

            override fun onDone(utteranceId: String?) {
                val i = utteranceId?.toIntOrNull() ?: return
                // The last chunk finished: we're done reading.
                if (i >= chunks.lastIndex) {
                    speaking = false
                    paused = false
                    spokenIndex = 0
                }
            }

            // Abstract on the base class, so it must be overridden even though the platform
            // marks it deprecated in favour of the (errorCode) overload.
            override fun onError(utteranceId: String?) {
                speaking = false
                paused = false
            }
        })
        onDispose {
            runCatching { tts.stop() }
            runCatching { tts.shutdown() }
        }
    }

    /** Queue [from] onwards. Used both to start and to resume after a pause. */
    fun speakFrom(from: Int) {
        val list = chunks
        if (list.isEmpty()) return
        runCatching { tts.setSpeechRate(rate) }
        // QUEUE_FLUSH on the first chunk clears anything left over, then add the rest.
        list.drop(from).forEachIndexed { offset, chunk ->
            val index = from + offset
            tts.speak(
                chunk,
                if (offset == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD,
                null,
                index.toString(),
            )
        }
        speaking = true
        paused = false
    }

    fun start() {
        val list = chunkForSpeech(text)
        if (list.isEmpty()) return
        chunks = list
        spokenIndex = 0
        speakFrom(0)
    }

    fun pause() {
        // stop() drops the queue; we remember where we were and re-queue from there on resume.
        runCatching { tts.stop() }
        speaking = false
        paused = true
    }

    fun stop() {
        runCatching { tts.stop() }
        speaking = false
        paused = false
        spokenIndex = 0
    }

    Column(
        modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Read It To Me", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text(
            "Paste in anything — an article, a chapter, a long message — and have it read aloud. " +
                "It all happens on this phone: nothing is uploaded, nothing is saved, and it works " +
                "with no signal.",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        unavailable?.let {
            Card(Modifier.fillMaxWidth()) {
                Text(
                    it + " You can usually add one in Android Settings under " +
                        "Accessibility → Text-to-speech output.",
                    Modifier.padding(14.dp),
                    fontSize = 13.sp,
                )
            }
        }

        // The big field. weight(1f) is what makes it "an entire page": it takes every pixel
        // the controls below don't need, at any screen size.
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            label = { Text("Paste or type your text") },
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        )

        if (chunks.isNotEmpty() && (speaking || paused)) {
            val progress = (spokenIndex + 1).toFloat() / chunks.size.toFloat()
            LinearProgressIndicator(
                progress = { progress.coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Part ${spokenIndex + 1} of ${chunks.size}" + if (paused) "  —  paused" else "",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // Speed.
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Speed", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            listOf(0.75f, 1.0f, 1.25f, 1.5f).forEach { r ->
                FilterChip(
                    selected = rate == r,
                    onClick = {
                        rate = r
                        // Apply immediately by re-queueing from the current chunk, so a speed
                        // change takes effect now rather than at the next paragraph.
                        if (speaking) speakFrom(spokenIndex)
                    },
                    label = { Text(if (r == 1.0f) "Normal" else "${r}x") },
                )
            }
        }

        // Transport.
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                enabled = ready && text.isNotBlank(),
                onClick = {
                    when {
                        speaking -> pause()
                        paused -> speakFrom(spokenIndex)
                        else -> start()
                    }
                },
                modifier = Modifier
                    .weight(1f)
                    .height(52.dp),
            ) {
                Icon(
                    if (speaking) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = null,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    when {
                        speaking -> "Pause"
                        paused -> "Resume"
                        else -> "Read it to me"
                    }
                )
            }
            OutlinedButton(
                enabled = speaking || paused,
                onClick = { stop() },
                modifier = Modifier.height(52.dp),
            ) {
                Icon(Icons.Filled.Stop, contentDescription = null)
                Spacer(Modifier.width(6.dp))
                Text("Stop")
            }
            OutlinedButton(
                enabled = text.isNotBlank(),
                onClick = { stop(); text = "" },
                modifier = Modifier.height(52.dp),
            ) { Text("Clear") }
        }

        if (!ready && unavailable == null) {
            Text(
                "Getting the voice ready…",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
