package com.beeboentertainment.movie.campsite

import android.content.Context
import android.speech.tts.TextToSpeech
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import java.util.Locale

/*
 * "Offline Star Chart" — a downloadable-feel seasonal constellation guide that is FULLY offline:
 * no network, no big dataset, no audio files. A handful of well-known constellations are hardcoded
 * as tiny arrays of normalized (0..1) star positions plus connect-the-dots line pairs, drawn on a
 * Compose Canvas as glowing stars on a night sky. A Spring/Summer/Fall/Winter selector filters
 * which are shown; tapping one shows the short story behind it, and a Play button speaks that story
 * through the phone's built-in [TextToSpeech] (same on-device engine BeeboSchool's LessonTts falls
 * back to) — so it works with the phone in airplane mode at a dark campsite.
 */

enum class Season(val label: String) { SPRING("Spring"), SUMMER("Summer"), FALL("Fall"), WINTER("Winter") }

/** A star at a normalized position; (0,0) is top-left of the sky box, (1,1) bottom-right. */
data class Star(val x: Float, val y: Float)

/** One constellation: its stars, the index pairs to connect, its best season, and its story. */
data class Constellation(
    val name: String,
    val season: Season,
    val stars: List<Star>,
    val lines: List<Pair<Int, Int>>,
    val story: String,
)

private val CONSTELLATIONS: List<Constellation> = listOf(
    Constellation(
        name = "Big Dipper (Ursa Major)",
        season = Season.SPRING,
        stars = listOf(
            Star(0.15f, 0.30f), Star(0.30f, 0.35f), Star(0.45f, 0.40f),
            Star(0.60f, 0.50f), Star(0.72f, 0.45f), Star(0.75f, 0.62f), Star(0.60f, 0.65f),
        ),
        lines = listOf(0 to 1, 1 to 2, 2 to 3, 3 to 4, 4 to 5, 5 to 6, 6 to 3),
        story = "The Big Dipper is part of Ursa Major, the Great Bear, and is one of the easiest " +
            "shapes to find. The two stars at the end of its bowl are called the Pointers, because " +
            "a line drawn through them leads straight to Polaris, the North Star. For centuries " +
            "travelers and sailors used it to find their way north in the dark.",
    ),
    Constellation(
        name = "Leo",
        season = Season.SPRING,
        stars = listOf(
            Star(0.30f, 0.65f), Star(0.28f, 0.50f), Star(0.33f, 0.38f),
            Star(0.42f, 0.30f), Star(0.75f, 0.45f), Star(0.60f, 0.60f),
        ),
        lines = listOf(0 to 1, 1 to 2, 2 to 3, 0 to 5, 5 to 4, 4 to 3),
        story = "Leo the Lion really does look like a crouching cat. The curve of stars at his " +
            "front, shaped like a backwards question mark, is called the Sickle and forms the " +
            "lion's mane. His brightest star, Regulus, sits at the bottom of that mane — its name " +
            "means the little king. In Greek myth Leo is the mighty lion faced by the hero Heracles.",
    ),
    Constellation(
        name = "Cygnus",
        season = Season.SUMMER,
        stars = listOf(
            Star(0.50f, 0.15f), Star(0.50f, 0.40f), Star(0.50f, 0.70f),
            Star(0.25f, 0.42f), Star(0.75f, 0.38f),
        ),
        lines = listOf(0 to 1, 1 to 2, 3 to 1, 1 to 4),
        story = "Cygnus the Swan flies along the glowing band of the Milky Way on summer nights. " +
            "Its bright stars form a cross so clear it is also called the Northern Cross. The star " +
            "at the swan's tail, Deneb, is one of the most distant stars you can see with your eyes " +
            "alone, shining across roughly two thousand light-years of space.",
    ),
    Constellation(
        name = "Scorpius",
        season = Season.SUMMER,
        stars = listOf(
            Star(0.20f, 0.20f), Star(0.30f, 0.30f), Star(0.38f, 0.42f), Star(0.45f, 0.55f),
            Star(0.55f, 0.68f), Star(0.65f, 0.75f), Star(0.78f, 0.68f),
        ),
        lines = listOf(0 to 1, 1 to 2, 2 to 3, 3 to 4, 4 to 5, 5 to 6),
        story = "Scorpius is one of the few constellations that truly looks like its name — a " +
            "scorpion with a curling tail and a raised stinger. Its heart is Antares, a huge red " +
            "supergiant star whose name means the rival of Mars, because it glows the same fiery " +
            "orange-red. In myth this is the scorpion that stung the hunter Orion.",
    ),
    Constellation(
        name = "Cassiopeia",
        season = Season.FALL,
        stars = listOf(
            Star(0.10f, 0.40f), Star(0.30f, 0.55f), Star(0.50f, 0.35f),
            Star(0.70f, 0.58f), Star(0.90f, 0.42f),
        ),
        lines = listOf(0 to 1, 1 to 2, 2 to 3, 3 to 4),
        story = "Cassiopeia is easy to spot as a big letter W (or M) of five bright stars. She was " +
            "a vain queen in Greek myth, placed in the sky on her throne. She circles the North " +
            "Star all night without ever setting, so on autumn evenings you can find her high " +
            "overhead — and use her to point toward Polaris when the Big Dipper is low.",
    ),
    Constellation(
        name = "Pegasus",
        season = Season.FALL,
        stars = listOf(
            Star(0.30f, 0.25f), Star(0.70f, 0.25f), Star(0.70f, 0.65f), Star(0.30f, 0.65f),
            Star(0.15f, 0.80f), Star(0.10f, 0.55f),
        ),
        lines = listOf(0 to 1, 1 to 2, 2 to 3, 3 to 0, 3 to 5, 5 to 4),
        story = "Four stars of nearly equal brightness form the Great Square of Pegasus, the body " +
            "of the winged horse of Greek myth. It is a signpost of autumn skies. From one corner " +
            "a line of stars stretches out as the horse's neck and head, and another leads away " +
            "toward the neighboring princess Andromeda.",
    ),
    Constellation(
        name = "Orion",
        season = Season.WINTER,
        stars = listOf(
            Star(0.35f, 0.25f), Star(0.62f, 0.22f), Star(0.42f, 0.48f), Star(0.50f, 0.50f),
            Star(0.58f, 0.52f), Star(0.40f, 0.78f), Star(0.66f, 0.80f),
        ),
        lines = listOf(0 to 1, 0 to 2, 1 to 4, 2 to 3, 3 to 4, 2 to 5, 4 to 6),
        story = "Orion the Hunter is the showpiece of winter skies. Three bright stars in a short, " +
            "straight row make his famous Belt — no other pattern looks quite like it. The reddish " +
            "star at his shoulder is Betelgeuse, and blue-white Rigel marks his foot. Hanging from " +
            "the belt is his sword, where you can find the glowing Orion Nebula, a nursery of " +
            "brand-new stars.",
    ),
    Constellation(
        name = "Taurus",
        season = Season.WINTER,
        stars = listOf(
            Star(0.30f, 0.30f), Star(0.45f, 0.45f), Star(0.55f, 0.55f),
            Star(0.65f, 0.45f), Star(0.80f, 0.30f), Star(0.45f, 0.68f),
        ),
        lines = listOf(0 to 1, 1 to 2, 2 to 3, 3 to 4, 2 to 5),
        story = "Taurus the Bull charges out of the winter sky with a V-shaped face and long horns. " +
            "The V is a real cluster of stars called the Hyades, and the bull's eye is Aldebaran, a " +
            "bright orange giant. Ride up along the bull's shoulder and you reach the Pleiades, the " +
            "Seven Sisters — a tiny, sparkling knot of stars worth a long look.",
    ),
    Constellation(
        name = "Gemini",
        season = Season.WINTER,
        stars = listOf(
            Star(0.35f, 0.20f), Star(0.60f, 0.22f), Star(0.32f, 0.45f),
            Star(0.58f, 0.47f), Star(0.30f, 0.72f), Star(0.56f, 0.74f),
        ),
        lines = listOf(0 to 2, 2 to 4, 1 to 3, 3 to 5, 0 to 1, 2 to 3),
        story = "Gemini is the Twins, two stick figures standing side by side. Their heads are the " +
            "bright stars Castor and Pollux, named after twin brothers from Greek myth who were so " +
            "close they were placed together in the sky forever. Look for them high on winter " +
            "evenings, up and to the left of Orion.",
    ),
)

/**
 * A tiny on-device speaker for the constellation stories — the same built-in [TextToSpeech] engine
 * that BeeboSchool's LessonTts falls back to, minus the home-server voice fetch (the star chart is
 * deliberately offline). Created on enter, released on leave; a missing engine degrades to silence.
 */
private class StarTts(context: Context) {
    private var engine: TextToSpeech? = null
    @Volatile private var ready = false
    @Volatile private var released = false
    @Volatile private var pending: String? = null

    init {
        engine = runCatching {
            TextToSpeech(context.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    ready = true
                    runCatching {
                        engine?.language = Locale.US
                        engine?.setSpeechRate(0.95f)
                    }
                    val queued = pending
                    pending = null
                    if (queued != null) speak(queued)
                }
            }
        }.getOrNull()
    }

    fun speak(text: String) {
        if (released) return
        val t = text.trim()
        if (t.isEmpty()) return
        val e = engine ?: return
        if (!ready) { pending = t; return }
        runCatching { e.speak(t, TextToSpeech.QUEUE_FLUSH, null, "starchart") }
    }

    fun stop() {
        pending = null
        runCatching { engine?.stop() }
    }

    fun release() {
        released = true
        pending = null
        val e = engine
        engine = null
        ready = false
        runCatching { e?.stop() }
        runCatching { e?.shutdown() }
    }
}

@Composable
private fun rememberStarTts(): StarTts {
    val context = LocalContext.current
    val tts = remember { StarTts(context) }
    DisposableEffect(tts) { onDispose { tts.release() } }
    return tts
}

@Composable
fun StarChartScreen(modifier: Modifier = Modifier) {
    val tts = rememberStarTts()

    var season by remember { mutableStateOf(Season.WINTER) }
    val inSeason = remember(season) { CONSTELLATIONS.filter { it.season == season } }
    var selected by remember { mutableStateOf(inSeason.firstOrNull()) }
    var speaking by remember { mutableStateOf(false) }

    // Keep the selection valid whenever the season changes.
    if (selected == null || selected?.season != season) {
        selected = inSeason.firstOrNull()
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Star Chart", style = MaterialTheme.typography.titleLarge)
        Text(
            "Works with no signal — great at a dark campsite. Pick a season, then a constellation " +
                "to see its shape and hear its story.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Season selector.
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Season.entries.forEach { s ->
                FilterChip(
                    selected = s == season,
                    onClick = {
                        season = s
                        tts.stop(); speaking = false
                    },
                    label = { Text(s.label) },
                )
            }
        }

        // Constellation picker for this season.
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            inSeason.forEach { c ->
                FilterChip(
                    selected = c.name == selected?.name,
                    onClick = {
                        selected = c
                        tts.stop(); speaking = false
                    },
                    label = { Text(c.name.substringBefore(" (")) },
                )
            }
        }

        val current = selected
        if (current != null) {
            // The night-sky canvas.
            Card(Modifier.fillMaxWidth()) {
                Canvas(
                    Modifier
                        .fillMaxWidth()
                        .aspectRatio(1.3f)
                        .clip(RoundedCornerShape(12.dp)),
                ) {
                    // Deep night gradient background.
                    drawRect(
                        brush = Brush.verticalGradient(
                            0f to Color(0xFF0B1026),
                            1f to Color(0xFF05070F),
                        ),
                    )
                    val pad = size.minDimension * 0.10f
                    val w = size.width - pad * 2
                    val h = size.height - pad * 2
                    fun pt(s: Star) = Offset(pad + s.x * w, pad + s.y * h)

                    // Connect-the-dots lines first, so stars sit on top.
                    current.lines.forEach { (a, b) ->
                        if (a in current.stars.indices && b in current.stars.indices) {
                            drawLine(
                                color = Color(0xFF9FB4FF).copy(alpha = 0.45f),
                                start = pt(current.stars[a]),
                                end = pt(current.stars[b]),
                                strokeWidth = 3f,
                            )
                        }
                    }

                    // Glowing stars: a soft halo, a brighter core, a white center.
                    current.stars.forEach { s ->
                        val c = pt(s)
                        drawCircle(Color(0xFFBFD0FF).copy(alpha = 0.12f), radius = 16f, center = c)
                        drawCircle(Color(0xFFDDE6FF).copy(alpha = 0.40f), radius = 8f, center = c)
                        drawCircle(Color.White, radius = 3.5f, center = c)
                    }
                }
            }

            Text(current.name, style = MaterialTheme.typography.titleMedium)

            // Story + Play/Stop.
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(current.story, style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = {
                        if (speaking) {
                            tts.stop(); speaking = false
                        } else {
                            tts.speak(current.story); speaking = true
                        }
                    }) {
                        Icon(
                            if (speaking) Icons.Filled.Stop else Icons.Filled.PlayArrow,
                            contentDescription = if (speaking) "Stop" else "Play",
                        )
                        Text(if (speaking) "  Stop" else "  Play the story")
                    }
                }
            }
        }
    }
}
