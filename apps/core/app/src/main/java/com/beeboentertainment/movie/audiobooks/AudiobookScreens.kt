package com.beeboentertainment.movie.audiobooks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Forward30
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.audio.AudioKind
import com.beeboentertainment.movie.audio.AudioPrefs
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.music.MusicPlayer
import com.beeboentertainment.movie.server.CoverImage
import com.beeboentertainment.movie.server.CoverUrls
import com.beeboentertainment.movie.server.SafeText
import com.beeboentertainment.movie.server.rememberServerLoad
import com.beeboentertainment.movie.ui.EmptyBox
import com.beeboentertainment.movie.ui.ErrorBox
import com.beeboentertainment.movie.ui.LoadingBox
import com.beeboentertainment.movie.ui.tv.DpadTextField
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val COVER = "/api/audiobooks/cover/"

@Composable
private fun BookCover(cover: String?, modifier: Modifier = Modifier, corner: Int = 8) =
    CoverImage(CoverUrls.server(cover, COVER), Icons.Filled.MenuBook, modifier, corner = corner)

private enum class Shelf(val label: String) { BOOKS("Books"), SERIES("Series"), UNFINISHED("In progress") }

/**
 * Audiobooks: continue listening and "up next in your series" on top, then all books, series, or
 * what you have started. A search box finds books by title, author or narrator. Tap a book for its
 * page (chapters, bookmarks, play).
 */
@Composable
fun AudiobooksScreen(onOpenBook: (String) -> Unit, onOpenSeries: (String) -> Unit, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) {
        MusicPlayer.connect(context)
        AudiobookPlayer.flushPending(context)
    }
    val client = remember { AudiobookClient.get() }
    var reload by remember { mutableIntStateOf(0) }
    var shelfName by rememberSaveable { mutableStateOf(Shelf.BOOKS.name) }
    val shelf = Shelf.valueOf(shelfName)
    var query by rememberSaveable { mutableStateOf("") }
    var debounced by remember { mutableStateOf("") }
    LaunchedEffect(query) { delay(300); debounced = query.trim() }
    val searching = debounced.length >= 2

    val cont = rememberServerLoad("continue", onUnauthorized, reload) { client.continueListening() }
    val books = rememberServerLoad(Pair("books", shelf), onUnauthorized, reload) {
        client.books(status = if (shelf == Shelf.UNFINISHED) "in_progress" else null).items
    }
    val series = rememberServerLoad("series", onUnauthorized, reload) { client.series().items }
    val found = rememberServerLoad(Pair("search", debounced), onUnauthorized, 0) { if (searching) client.search(debounced) else null }

    Column(Modifier.fillMaxSize()) {
        DpadTextField(Modifier.fillMaxWidth().padding(horizontal = 10.dp)) { tv ->
            OutlinedTextField(
                value = query,
                onValueChange = { query = it.take(100) },
                label = { Text("Search books, authors and narrators") },
                singleLine = true,
                modifier = tv.fillMaxWidth().padding(vertical = 4.dp)
            )
        }
        if (searching) {
            val r = found.value
            when {
                found.error != null && r == null -> ErrorBox(found.error)
                r == null -> LoadingBox()
                r.books.isEmpty() && r.series.isEmpty() -> EmptyBox("Nothing matches \"${SafeText.clean(debounced, 60)}\".")
                else -> BookGrid(r.books, r.series, onOpenBook, onOpenSeries)
            }
            return@Column
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Shelf.values().forEach { s -> FilterChip(selected = s == shelf, onClick = { shelfName = s.name }, label = { Text(s.label) }) }
        }
        when {
            shelf == Shelf.SERIES -> when {
                series.error != null && series.value == null -> ErrorBox(series.error, onRetry = { reload++ })
                series.value == null -> LoadingBox()
                series.value.isEmpty() -> EmptyBox("No series yet. Books in folders named Author / Series / 01 - Title are grouped automatically.")
                else -> BookGrid(emptyList(), series.value, onOpenBook, onOpenSeries)
            }
            books.error != null && books.value == null -> ErrorBox(books.error, onRetry = { reload++ })
            books.value == null -> LoadingBox()
            books.value.isEmpty() && shelf == Shelf.UNFINISHED -> EmptyBox("Nothing in progress. Start a book and it will wait for you here.")
            books.value.isEmpty() -> EmptyBox("No audiobooks yet. On your Beebo computer, open Settings and choose your Audiobooks folder.")
            else -> BookGrid(
                books.value, emptyList(), onOpenBook, onOpenSeries,
                header = if (shelf == Shelf.BOOKS) ({ ContinueShelves(cont.value, onOpenBook) }) else null
            )
        }
    }
}

@Composable
private fun ContinueShelves(data: ContinueResponse?, onOpenBook: (String) -> Unit) {
    if (data == null) return
    if (data.items.isNotEmpty()) {
        Text("Continue listening", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 6.dp, top = 8.dp, bottom = 4.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(horizontal = 6.dp)) {
            items(data.items, key = { it.book.id }) { item ->
                Column(Modifier.width(120.dp).clip(RoundedCornerShape(8.dp)).clickable { onOpenBook(item.book.id) }.padding(2.dp)) {
                    BookCover(item.book.cover, Modifier.fillMaxWidth().aspectRatio(1f))
                    LinearProgressIndicator(progress = { item.progress.fraction.toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
                    Text(SafeText.clean(item.book.title, 80), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(AudiobookLogic.formatLeft(item.progress.remaining) + " left", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
    if (data.nextUp.isNotEmpty()) {
        Text("Next in your series", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 6.dp, top = 12.dp, bottom = 4.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(horizontal = 6.dp)) {
            items(data.nextUp, key = { it.book.id }) { n ->
                Column(Modifier.width(120.dp).clip(RoundedCornerShape(8.dp)).clickable { onOpenBook(n.book.id) }.padding(2.dp)) {
                    BookCover(n.book.cover, Modifier.fillMaxWidth().aspectRatio(1f))
                    Text(SafeText.clean(n.book.title, 80), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(SafeText.clean(n.series.name, 60), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
    Text("All books", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 6.dp, top = 12.dp))
}

@Composable
private fun BookGrid(
    books: List<BookBrief>,
    series: List<SeriesBrief>,
    onOpenBook: (String) -> Unit,
    onOpenSeries: (String) -> Unit,
    header: (@Composable () -> Unit)? = null,
) {
    LazyVerticalGrid(columns = GridCells.Adaptive(minSize = 120.dp), contentPadding = PaddingValues(8.dp), modifier = Modifier.fillMaxSize()) {
        if (header != null) item(span = { GridItemSpan(maxLineSpan) }) { Column { header() } }
        if (series.isNotEmpty()) {
            if (books.isNotEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { Text("Series", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(6.dp)) }
            items(series, key = { "s" + it.id }) { s ->
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { onOpenSeries(s.id) }.padding(4.dp)) {
                    BookCover(s.cover, Modifier.fillMaxWidth().aspectRatio(1f))
                    Text(SafeText.clean(s.name, 80), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
                    Text("${s.bookCount} ${if (s.bookCount == 1) "book" else "books"} · ${SafeText.clean(s.author, 40)}", maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        if (books.isNotEmpty() && series.isNotEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { Text("Books", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(6.dp)) }
        items(books, key = { "b" + it.id }) { b -> BookTile(b) { onOpenBook(b.id) } }
    }
}

@Composable
private fun BookTile(b: BookBrief, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(4.dp)) {
        BookCover(b.cover, Modifier.fillMaxWidth().aspectRatio(1f))
        val fraction = b.progress?.fraction?.toFloat() ?: 0f
        if (fraction > 0f && b.status != "finished") LinearProgressIndicator(progress = { fraction.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
        Text(SafeText.clean(b.title, 90), maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
        Text(SafeText.clean(b.author, 60), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(AudiobookLogic.statusLine(b), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/* ================================== Series ================================== */

@Composable
fun AudiobookSeriesScreen(seriesId: String, onOpenBook: (String) -> Unit, onUnauthorized: () -> Unit) {
    val client = remember { AudiobookClient.get() }
    var reload by remember { mutableIntStateOf(0) }
    val loaded = rememberServerLoad(seriesId, onUnauthorized, reload) { client.seriesDetail(seriesId) }
    val r = loaded.value
    when {
        loaded.error != null && r == null -> ErrorBox(loaded.error, onRetry = { reload++ })
        r == null -> LoadingBox()
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 12.dp)) {
            item {
                Column(Modifier.padding(14.dp)) {
                    Text(SafeText.clean(r.series.name, 100), style = MaterialTheme.typography.titleLarge)
                    Text(SafeText.clean(r.series.author, 60), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("${r.series.bookCount} ${if (r.series.bookCount == 1) "book" else "books"} · ${AudiobookLogic.formatLeft(r.series.duration)}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            items(r.books, key = { it.id }) { b ->
                Row(Modifier.fillMaxWidth().clickable { onOpenBook(b.id) }.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    BookCover(b.cover, Modifier.size(56.dp), corner = 4)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(SafeText.clean(b.title, 90), maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = if (b.next) FontWeight.Bold else FontWeight.Normal)
                        Text(
                            listOfNotNull(b.seriesIndex?.let { "Book " + (if (it == kotlin.math.floor(it)) it.toInt().toString() else it.toString()) }, AudiobookLogic.statusLine(b), if (b.next) "Up next" else null).joinToString(" · "),
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

/* =================================== Book =================================== */

@Composable
fun AudiobookScreen(bookId: String, onOpenListen: () -> Unit, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    val client = remember { AudiobookClient.get() }
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    var message by remember { mutableStateOf<String?>(null) }
    val loaded = rememberServerLoad(bookId, onUnauthorized, reload) { client.book(bookId) }
    val r = loaded.value

    when {
        loaded.error != null && r == null -> ErrorBox(loaded.error, onRetry = { reload++ })
        r == null -> LoadingBox()
        else -> {
            val book = r.book
            val chapters = remember(book) { AudiobookLogic.chapters(book.chapters) }
            val resume = remember(r) { AudiobookLogic.resolveResume(r.progress, AudiobookPlayer.localPosition(book.id), book.duration) }
            val speed = AudiobookLogic.clampSpeed(resume.speed ?: r.speed)
            val started = resume.positionSec > 1.0
            fun play(from: Double) {
                if (AudiobookPlayer.start(context, r, from, speed)) onOpenListen()
                else message = "This book has no file the app can play. It may need a rescan on your computer."
            }
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
                item {
                    Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.Bottom) {
                        BookCover(book.cover, Modifier.size(140.dp))
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(SafeText.clean(book.title, 120), style = MaterialTheme.typography.titleLarge, maxLines = 4, overflow = TextOverflow.Ellipsis)
                            Text(SafeText.clean(book.author, 80), color = MaterialTheme.colorScheme.primary)
                            book.narrator?.let { Text("Read by " + SafeText.clean(it, 80), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            AudiobookLogic.seriesPlace(book.series, book.seriesIndex)?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            Text(
                                listOfNotNull(book.year?.toString(), SafeText.clean(book.genre, 40).ifBlank { null }, AudiobookLogic.formatLeft(book.duration)).joinToString(" · "),
                                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Button(onClick = { play(resume.positionSec) }, enabled = !book.unreadable) {
                            Icon(Icons.Filled.PlayArrow, contentDescription = null); Spacer(Modifier.width(4.dp))
                            Text(if (started) "Resume " + AudiobookLogic.formatClock(resume.positionSec) else "Play")
                        }
                        if (started) OutlinedButton(onClick = { play(0.0) }) { Text("From the start") }
                    }
                    val p = r.progress
                    if (p != null && p.fraction > 0.0) {
                        LinearProgressIndicator(progress = { p.fraction.toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().padding(12.dp))
                        Text(
                            if (p.finished) "Finished" else AudiobookLogic.formatLeft(p.remaining) + " left",
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp)
                        )
                    }
                    if (resume.source == AudiobookLogic.ResumeSource.THIS_DEVICE) {
                        Text("Your place on this phone is newer than what your computer has; it will be sent when it can be reached.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp))
                    }
                    message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp)) }
                    val desc = SafeText.paragraphs(book.description, 3000)
                    if (desc.isNotBlank()) {
                        Text(desc, fontSize = 14.sp, modifier = Modifier.padding(12.dp), maxLines = 12, overflow = TextOverflow.Ellipsis)
                    }
                    if (r.nextInSeries != null) {
                        val next = r.nextInSeries
                        Text("Next in the series", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 12.dp, top = 8.dp))
                        Text(SafeText.clean(next.title, 100), color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(horizontal = 12.dp))
                    }
                    Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = {
                            scope.launch {
                                try { client.markFinished(book.id, r.progress?.finished != true); reload++ } catch (e: UnauthorizedException) { onUnauthorized() } catch (e: Exception) { message = e.message }
                            }
                        }) { Text(if (r.progress?.finished == true) "Mark as not started" else "Mark as finished") }
                    }
                    if (chapters.isNotEmpty()) Text("Chapters", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 4.dp))
                }
                itemsIndexed(chapters) { i, c ->
                    Row(Modifier.fillMaxWidth().clickable { play(c.start) }.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("${i + 1}", modifier = Modifier.width(32.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                        Text(c.title, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(AudiobookLogic.formatClock(c.start), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (r.bookmarks.isNotEmpty()) {
                    item { Text("Bookmarks", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 12.dp, top = 12.dp, bottom = 4.dp)) }
                    items(r.bookmarks, key = { it.id }) { b ->
                        Row(Modifier.fillMaxWidth().clickable { play(b.at) }.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Bookmark, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(10.dp))
                            Text(AudiobookLogic.formatClock(b.at) + if (b.note.isNotBlank()) "  " + SafeText.clean(b.note, 120) else "", modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
}

/* ================================== Listening ================================== */

/**
 * The full-screen audiobook player: chapter, whole-book seek bar, back 15 / play / forward 30,
 * previous and next chapter, speed 0.5x to 3x (the pitch stays), sleep timer, bookmark. It keeps
 * playing with the screen off and through the lock screen (the shared audio service).
 */
@Composable
fun AudiobookListenScreen(onOpenBook: (String) -> Unit, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(Unit) { MusicPlayer.connect(context) }
    val state by MusicPlayer.state.collectAsState()
    val session by AudiobookPlayer.session.collectAsState()
    val sleep by AudiobookPlayer.sleep.collectAsState()
    val unsaved by AudiobookPlayer.unsaved.collectAsState()
    val scope = rememberCoroutineScope()
    var showSpeed by remember { mutableStateOf(false) }
    var showSleep by remember { mutableStateOf(false) }
    var showChapters by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val client = remember { AudiobookClient.get() }

    // The service kept playing after the app was reopened: rebuild the session from the server.
    val playingId = if (state.kind == AudioKind.AUDIOBOOK) state.itemId else null
    LaunchedEffect(playingId, session?.book?.id) {
        val id = playingId ?: return@LaunchedEffect
        if (session?.book?.id != id) {
            try { AudiobookPlayer.attach(context, client.book(id)) } catch (e: UnauthorizedException) { onUnauthorized() } catch (_: Exception) { }
        }
    }

    if (state.kind != AudioKind.AUDIOBOOK || !state.hasSong) {
        EmptyBox("No audiobook is playing. Open Audiobooks and pick a book.")
        return
    }
    val s = session
    val meta = state.current?.mediaMetadata
    val extras = state.current?.mediaMetadata?.extras
    // Whole-book seconds: where this file starts in the book plus how far into it we are.
    val position = (extras?.getDouble(com.beeboentertainment.movie.audio.AudioExtras.PART_START_SEC) ?: 0.0) + state.positionMs / 1000.0
    val total = s?.book?.duration ?: (extras?.getDouble(com.beeboentertainment.movie.audio.AudioExtras.TOTAL_DURATION_SEC) ?: 0.0)
    val chapters = s?.chapters ?: emptyList()
    val chapterIndex = AudiobookLogic.chapterIndexAt(chapters, position)
    val chapterTitle = chapters.getOrNull(chapterIndex)?.title
    var dragging by remember { mutableStateOf<Float?>(null) }
    val shownPosition = dragging?.let { it * total } ?: position

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            val art = meta?.artworkUri?.toString()
            CoverImage(art, Icons.Filled.MenuBook, Modifier.fillMaxWidth(0.8f).aspectRatio(1f), corner = 12)
        }
        Text(meta?.title?.toString().orEmpty(), style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
        Text(
            chapterTitle ?: meta?.artist?.toString().orEmpty(),
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.clip(RoundedCornerShape(4.dp)).clickable(enabled = s != null) { s?.book?.id?.let(onOpenBook) }
        )
        Slider(
            value = if (total > 0) (shownPosition / total).toFloat().coerceIn(0f, 1f) else 0f,
            onValueChange = { if (total > 0) dragging = it },
            onValueChangeFinished = { dragging?.let { MusicPlayer.seekToBook(it * total) }; dragging = null },
            enabled = total > 0,
            modifier = Modifier.fillMaxWidth()
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(AudiobookLogic.formatClock(shownPosition), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("-" + AudiobookLogic.formatClock((total - shownPosition).coerceAtLeast(0.0)), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { AudiobookPlayer.previousChapter() }, enabled = chapters.isNotEmpty()) { Icon(Icons.Filled.SkipPrevious, contentDescription = "Previous chapter", modifier = Modifier.size(32.dp)) }
            IconButton(onClick = { AudiobookPlayer.skipBack(context) }) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.Replay, contentDescription = "Back ${AudioPrefs.skipBackSeconds(context)} seconds", modifier = Modifier.size(32.dp))
                }
            }
            IconButton(onClick = { if (state.isPlaying) MusicPlayer.pause() else MusicPlayer.play() }) {
                Icon(if (state.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, contentDescription = if (state.isPlaying) "Pause" else "Play", modifier = Modifier.size(52.dp), tint = MaterialTheme.colorScheme.primary)
            }
            IconButton(onClick = { AudiobookPlayer.skipForward(context) }) { Icon(Icons.Filled.Forward30, contentDescription = "Forward ${AudioPrefs.skipForwardSeconds(context)} seconds", modifier = Modifier.size(32.dp)) }
            IconButton(onClick = { AudiobookPlayer.nextChapter() }, enabled = chapters.isNotEmpty()) { Icon(Icons.Filled.SkipNext, contentDescription = "Next chapter", modifier = Modifier.size(32.dp)) }
        }
        Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { showSpeed = true }) {
                Icon(Icons.Filled.Speed, contentDescription = null); Spacer(Modifier.width(4.dp)); Text(AudiobookLogic.speedLabel(state.speed.toDouble()))
            }
            TextButton(onClick = { showSleep = true }) {
                Icon(Icons.Filled.Bedtime, contentDescription = null, tint = if (sleep != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(4.dp))
                Text(AudiobookLogic.sleepLabel(sleep, System.currentTimeMillis(), position) ?: "Sleep")
            }
            TextButton(onClick = {
                scope.launch {
                    note = try { if (AudiobookPlayer.addBookmark("") != null) "Bookmark saved" else "Couldn't save the bookmark" } catch (e: UnauthorizedException) { onUnauthorized(); null } catch (e: Exception) { e.message ?: "Couldn't save the bookmark" }
                }
            }) { Icon(Icons.Filled.Bookmark, contentDescription = null); Spacer(Modifier.width(4.dp)); Text("Bookmark") }
            if (chapters.isNotEmpty()) TextButton(onClick = { showChapters = true }) { Text("Chapters") }
        }
        note?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (unsaved) Text("Your place isn't saved to your computer yet. It will be sent when it can be reached.", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        state.errorText?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        LaunchedEffect(note) { if (note != null) { delay(2500); note = null } }
    }

    if (showSpeed) SpeedDialog(state.speed.toDouble(), onPick = { AudiobookPlayer.setSpeed(it) }, onDismiss = { showSpeed = false })
    if (showSleep) SleepDialog(
        active = sleep != null, hasChapters = chapters.isNotEmpty(),
        onMinutes = { AudiobookPlayer.sleepInMinutes(it); showSleep = false },
        onChapter = { if (!AudiobookPlayer.sleepAtChapterEnd()) note = "This book has no chapters to stop at."; showSleep = false },
        onOff = { AudiobookPlayer.cancelSleep(); showSleep = false },
        onDismiss = { showSleep = false }
    )
    if (showChapters) AlertDialog(
        onDismissRequest = { showChapters = false },
        confirmButton = { TextButton(onClick = { showChapters = false }) { Text("Close") } },
        title = { Text("Chapters") },
        text = {
            LazyColumn {
                itemsIndexed(chapters) { i, c ->
                    Row(Modifier.fillMaxWidth().clickable { AudiobookPlayer.seekToChapter(i); showChapters = false }.padding(vertical = 8.dp)) {
                        Text(c.title, modifier = Modifier.weight(1f), fontWeight = if (i == chapterIndex) FontWeight.Bold else FontWeight.Normal, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(AudiobookLogic.formatClock(c.start), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    )
}

@Composable
private fun SpeedDialog(current: Double, onPick: (Double) -> Unit, onDismiss: () -> Unit) {
    var value by remember { mutableStateOf(AudiobookLogic.clampSpeed(current).toFloat()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
        title = { Text("Speed") },
        text = {
            Column {
                Text(AudiobookLogic.speedLabel(value.toDouble()), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
                Slider(
                    value = value, valueRange = 0.5f..3f, steps = 49,
                    onValueChange = { value = it },
                    onValueChangeFinished = { onPick(AudiobookLogic.clampSpeed(value.toDouble())) }
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    listOf(0.75, 1.0, 1.25, 1.5, 2.0).forEach { p ->
                        TextButton(onClick = { value = p.toFloat(); onPick(p) }) { Text(AudiobookLogic.speedLabel(p)) }
                    }
                }
                Text("The voice keeps its pitch at every speed.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    )
}

@Composable
private fun SleepDialog(active: Boolean, hasChapters: Boolean, onMinutes: (Int) -> Unit, onChapter: () -> Unit, onOff: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        title = { Text("Sleep timer") },
        text = {
            Column {
                AudiobookLogic.SLEEP_MINUTES.forEach { m -> Text("$m minutes", modifier = Modifier.fillMaxWidth().clickable { onMinutes(m) }.padding(vertical = 10.dp)) }
                if (hasChapters) Text("End of chapter", modifier = Modifier.fillMaxWidth().clickable(onClick = onChapter).padding(vertical = 10.dp))
                if (active) Text("Turn off", modifier = Modifier.fillMaxWidth().clickable(onClick = onOff).padding(vertical = 10.dp), color = MaterialTheme.colorScheme.primary)
                Text("The sound fades out over the last 10 seconds.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    )
}
