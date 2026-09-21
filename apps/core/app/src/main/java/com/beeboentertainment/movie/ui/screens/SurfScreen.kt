package com.beeboentertainment.movie.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.SurfFilters
import com.beeboentertainment.movie.core.SurfPoolSize
import com.beeboentertainment.movie.data.DecadeBucket
import com.beeboentertainment.movie.data.Genre
import com.beeboentertainment.movie.data.SurfYearsResponse
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.data.YearBucket
import com.beeboentertainment.movie.player.PlayerActivity
import com.beeboentertainment.movie.ui.ErrorBox

/**
 * Surf chooser — "Not Sure What To Watch?".
 *
 * Three axes, mirroring the website and desktop app:
 *   1. kind   — Movies / TV Shows / Both (one mixed pool)
 *   2. genre  — chips from /api/surf/genres
 *   3. time   — decade chips from /api/surf/years, drilling into individual year chips
 *
 * Genre and year are independent: picking one preserves the other, and BOTH chip sets are
 * refreshed after every pick because the server cross-filters their counts (genre counts respect
 * the active year, year counts respect the active genre). That also means the count shown on a
 * chip is already the size of the combined pool — no extra round trip needed to size it.
 *
 * The player owns the actual surfing (Prev/Next, halfway start, N of M).
 */
@Composable
fun SurfScreen(onUnauthorized: () -> Unit) {
    val app = BeeboApp.instance
    val context = LocalContext.current

    var filters by remember { mutableStateOf(SurfFilters()) }

    var genres by remember { mutableStateOf<List<Genre>>(emptyList()) }
    var kindTotal by remember { mutableStateOf(0) }
    var years by remember { mutableStateOf(SurfYearsResponse()) }

    var loadingGenres by remember { mutableStateOf(true) }
    var loadingYears by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    // Genre buckets depend on kind + the active year/decade.
    LaunchedEffect(filters.kind, filters.requestYear, filters.requestDecade, reloadKey) {
        loadingGenres = true
        error = null
        try {
            val r = app.api.surfGenres(filters.kind, filters.requestYear, filters.requestDecade)
            genres = r.genres
            kindTotal = r.total
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            error = e.message ?: "Couldn't load surf categories."
        } finally {
            loadingGenres = false
        }
    }

    // Year buckets depend on kind + the active genre.
    LaunchedEffect(filters.kind, filters.genreId, reloadKey) {
        loadingYears = true
        try {
            years = app.api.surfYears(filters.kind, filters.genreParam)
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            // A years failure shouldn't block surfing by genre alone.
            years = SurfYearsResponse()
        } finally {
            loadingYears = false
        }
    }

    val poolSize = SurfPoolSize.estimate(
        filters = filters,
        genreCounts = genres.map { it.id to it.count },
        decadeCounts = years.decades.map { it.decade to it.count },
        yearCounts = years.years.map { it.year to it.count },
        total = kindTotal
    )

    fun startSurfing() {
        if (poolSize <= 0) return
        context.startActivity(
            PlayerActivity.surfIntent(
                context,
                kind = filters.kind,
                genre = filters.genreParam,
                genreName = filters.genreName,
                year = filters.requestYear,
                decade = filters.requestDecade,
                // seed 0 => let the server pick a fresh shuffle each time they surf
                seed = 0L,
                index = 0,
                total = poolSize
            )
        )
    }

    if (error != null && genres.isEmpty()) {
        ErrorBox(error!!, onRetry = { reloadKey++ })
        return
    }

    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {

            item {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text("Not sure what to watch?", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text(
                        "Drops you into the middle of something random.",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            /* ---------------------------- step 1: kind ---------------------------- */
            item {
                SectionHeader("What are you in the mood for?")
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    SurfFilters.KINDS.forEach { k ->
                        FilterChip(
                            selected = filters.kind == k,
                            onClick = { filters = filters.withKind(k) },
                            label = {
                                Text("${SurfFilters.kindEmoji(k)} ${SurfFilters.kindLabel(k)}")
                            }
                        )
                    }
                }
                Spacer(Modifier.height(4.dp))
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
            }

            /* --------------------------- step 2a: genre --------------------------- */
            item {
                SectionHeader("Category")
                if (loadingGenres && genres.isEmpty()) {
                    InlineSpinner()
                } else {
                    LazyRow(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp)
                    ) {
                        item {
                            FilterChip(
                                selected = filters.genreId == null,
                                onClick = { filters = filters.clearGenre() },
                                label = { Text("🎲 Any category") }
                            )
                        }
                        items(genres, key = { it.id }) { g ->
                            FilterChip(
                                selected = filters.genreId == g.id,
                                onClick = {
                                    // preserves the year selection by construction
                                    filters = if (filters.genreId == g.id) filters.clearGenre()
                                    else filters.withGenre(g.id, g.name)
                                },
                                enabled = g.count > 0 || filters.genreId == g.id,
                                label = { Text("${g.name} (${g.count})") }
                            )
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
            }

            /* ---------------------------- step 2b: year --------------------------- */
            item {
                SectionHeader("Year")
                if (loadingYears && years.decades.isEmpty()) {
                    InlineSpinner()
                } else {
                    DecadeRow(
                        decades = years.decades,
                        selected = filters.decade,
                        onAny = { filters = filters.clearTime() },
                        onPick = { d ->
                            filters = if (filters.decade == d) filters.clearTime()
                            else filters.withDecade(d)
                        }
                    )
                    // Once a decade is chosen, offer the individual years inside it.
                    val decade = filters.decade
                    if (decade != null) {
                        val inDecade = years.years.filter {
                            SurfFilters.yearInDecade(it.year, decade)
                        }
                        if (inDecade.isNotEmpty()) {
                            Spacer(Modifier.height(6.dp))
                            YearRow(
                                yearsInDecade = inDecade,
                                selected = filters.year,
                                decadeLabel = SurfFilters.decadeLabel(decade),
                                onWholeDecade = { filters = filters.withDecade(decade) },
                                onPick = { y ->
                                    filters = if (filters.year == y) filters.withDecade(decade)
                                    else filters.withYear(y)
                                }
                            )
                        }
                    }
                    if (years.unknownCount > 0 && filters.hasTimeFilter) {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "${years.unknownCount} title${if (years.unknownCount == 1) "" else "s"} " +
                                "with no known year are left out while a year filter is on.",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 12.dp)
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
            }
        }

        /* ------------------------- selection + start action ------------------------ */
        Surface(tonalElevation = 3.dp, shadowElevation = 8.dp) {
            Column(Modifier.fillMaxWidth().padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            filters.summary(),
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Medium
                        )
                        Text(
                            if (poolSize > 0) "$poolSize to surf" else "Nothing matches that combination",
                            fontSize = 12.sp,
                            color = if (poolSize > 0) MaterialTheme.colorScheme.onSurfaceVariant
                            else MaterialTheme.colorScheme.error
                        )
                    }
                    if (filters.hasAnyFilter) {
                        TextButton(onClick = { filters = filters.clearAll() }) {
                            Icon(Icons.Filled.Clear, contentDescription = null, Modifier.size(16.dp))
                            Spacer(Modifier.size(4.dp))
                            Text("Clear")
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = { startSurfing() },
                    enabled = poolSize > 0,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(if (poolSize > 0) "Start surfing ($poolSize)" else "Nothing to surf")
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 12.dp, bottom = 6.dp)
    )
}

@Composable
private fun InlineSpinner() {
    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
    }
}

@Composable
private fun DecadeRow(
    decades: List<DecadeBucket>,
    selected: Int?,
    onAny: () -> Unit,
    onPick: (Int) -> Unit
) {
    LazyRow(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp)
    ) {
        item {
            FilterChip(
                selected = selected == null,
                onClick = onAny,
                label = { Text("📅 Any year") }
            )
        }
        items(decades, key = { it.decade }) { d ->
            FilterChip(
                selected = selected == d.decade,
                onClick = { onPick(d.decade) },
                label = { Text("${d.displayLabel} (${d.count})") }
            )
        }
    }
}

@Composable
private fun YearRow(
    yearsInDecade: List<YearBucket>,
    selected: Int?,
    decadeLabel: String,
    onWholeDecade: () -> Unit,
    onPick: (Int) -> Unit
) {
    LazyRow(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp)
    ) {
        item {
            AssistChip(
                onClick = onWholeDecade,
                label = { Text(if (selected == null) "All of $decadeLabel ✓" else "All of $decadeLabel") }
            )
        }
        items(yearsInDecade, key = { it.year }) { y ->
            FilterChip(
                selected = selected == y.year,
                onClick = { onPick(y.year) },
                label = { Text("${y.year} (${y.count})") }
            )
        }
    }
}
