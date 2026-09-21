package com.beeboentertainment.movie.campsite.campfire

import android.content.ActivityNotFoundException
import android.graphics.Bitmap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.beeboentertainment.movie.campsite.games.BingoGrid
import com.beeboentertainment.movie.campsite.games.NatureBingoCards
import com.beeboentertainment.movie.campsite.games.NaturePack
import java.security.SecureRandom
import kotlin.random.asKotlinRandom

/** The rules text, shared with the guest page's wording. */
internal val NATURE_BINGO_STEPS = listOf(
    "Choose one or more packs: Easy, Night-time, Water or Forest.",
    "You get a card of 24 things to spot, with a free square in the middle.",
    "When you really see something on your card, tap it to mark it. Tap again to un-mark.",
    "Optional: add a photo as proof. Photos stay on this phone only and are never uploaded.",
    "Mark a full row, column or diagonal and call Bingo. Show your line to the host to check it.",
)
internal const val NATURE_BINGO_SAFETY =
    "Stay safe: look, don't touch - leave wildlife, nests and berries alone. Don't wander off alone at night, and stay on the path."

/**
 * Nature Bingo on this phone alone - no campsite server, hotspot or internet. Other
 * phones can play the same game together through Invite players.
 */
@Composable
fun NatureBingoScreen() {
    var night by rememberSaveable { mutableStateOf(false) }
    var textStep by rememberSaveable { mutableIntStateOf(1) }
    CampfireFrame(night, textStep) {
        NatureBingoPane(night, { night = it }, textStep, { textStep = it })
    }
}

@Composable
private fun NatureBingoPane(night: Boolean, onNight: (Boolean) -> Unit, textStep: Int, onTextStep: (Int) -> Unit) {
    var packs by rememberSaveable { mutableStateOf(setOf("easy", "forest")) }
    var card by rememberSaveable { mutableStateOf<List<String>>(emptyList()) }
    var marks by rememberSaveable { mutableStateOf(setOf(BingoGrid.FREE)) }
    var selected by rememberSaveable { mutableIntStateOf(-1) }
    // Photo proof lives in memory on this phone only. It is never written to storage or sent anywhere.
    val photos = remember { mutableStateMapOf<Int, Bitmap>() }
    var cameraMissing by remember { mutableStateOf(false) }
    var photoFor by remember { mutableIntStateOf(-1) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap ->
        if (bitmap != null && photoFor >= 0) {
            photos[photoFor] = bitmap
            marks = marks + photoFor
        }
        photoFor = -1
    }

    val chosen = NaturePack.entries.filter { it.wire in packs }.toSet()
    val lines = BingoGrid.completeLines(marks)

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Nature Bingo", style = MaterialTheme.typography.headlineMedium)
        CampfireDisplayBar(night, onNight, textStep, onTextStep)
        HowToPlayCard(NATURE_BINGO_STEPS, NATURE_BINGO_SAFETY)
        Text("Packs", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            NaturePack.entries.forEach { p ->
                FilterChip(
                    selected = p.wire in packs,
                    onClick = { packs = if (p.wire in packs) packs - p.wire else packs + p.wire },
                    label = { Text(p.label) },
                )
            }
        }
        Button(
            onClick = {
                card = NatureBingoCards.generate(chosen, SecureRandom().asKotlinRandom())
                marks = setOf(BingoGrid.FREE); selected = -1; photos.clear()
            },
            enabled = chosen.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
        ) { Text(if (card.isEmpty()) "Deal my card" else "New card") }
        Text(
            "Photos stay on this phone and are cleared when you leave. Nothing is uploaded.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (card.size == BingoGrid.CELLS) {
            if (lines.isNotEmpty()) {
                Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                    Text("Bingo! Show your line to someone to check it.", style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold, modifier = Modifier.padding(16.dp))
                }
            }
            val winning = lines.flatten().toSet()
            for (r in 0 until BingoGrid.SIZE) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (c in 0 until BingoGrid.SIZE) {
                        val i = r * BingoGrid.SIZE + c
                        val marked = i in marks
                        val shape = RoundedCornerShape(8.dp)
                        Box(
                            Modifier.weight(1f).aspectRatio(1f).clip(shape)
                                .background(if (marked) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant)
                                .border(if (i == selected) 3.dp else if (i in winning) 2.dp else 1.dp,
                                    if (i in winning || i == selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline, shape)
                                .clickable(enabled = i != BingoGrid.FREE, role = Role.Checkbox) {
                                    selected = i
                                    marks = if (marked) marks - i else marks + i
                                    if (marked) photos.remove(i)
                                }
                                .semantics(mergeDescendants = true) {
                                    this.selected = marked
                                    contentDescription = card[i] + if (marked) ", marked" else ", not marked"
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            photos[i]?.let {
                                Image(it.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop,
                                    modifier = Modifier.fillMaxSize(), alpha = 0.55f)
                            }
                            Text(
                                if (i == BingoGrid.FREE) "★ FREE" else card[i],
                                style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center,
                                fontWeight = if (marked) FontWeight.Bold else FontWeight.Normal,
                                modifier = Modifier.padding(2.dp),
                            )
                            if (marked && i != BingoGrid.FREE) Text("✓", Modifier.align(Alignment.TopEnd).padding(2.dp).size(14.dp))
                        }
                    }
                }
            }
            if (selected in card.indices && selected != BingoGrid.FREE) {
                Text("Selected: ${card[selected]}", style = MaterialTheme.typography.titleMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = {
                        photoFor = selected
                        try { camera.launch(null) } catch (_: ActivityNotFoundException) { cameraMissing = true; photoFor = -1 }
                    }) { Text(if (selected in photos) "Retake photo proof" else "Add photo proof") }
                    if (selected in photos) OutlinedButton(onClick = { photos.remove(selected) }) { Text("Remove photo") }
                }
                if (cameraMissing) Text("No camera app is available on this device.", color = MaterialTheme.colorScheme.error)
            }
            Text("${marks.size - 1} of 24 spotted", style = MaterialTheme.typography.bodyLarge)
        }
    }
}
