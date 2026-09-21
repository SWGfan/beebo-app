package com.beeboentertainment.movie.spacesaver.gallery

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.coroutines.CancellationException
import com.beeboentertainment.movie.BeeboApp
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.ImageLoader
import coil.compose.AsyncImagePainter
import coil.compose.SubcomposeAsyncImage
import coil.compose.SubcomposeAsyncImageContent
import coil.request.ImageRequest

/**
 * The Space Saver gallery: browse the photos & videos backed up to the home PC, folder by folder,
 * and tap one to open a full-screen, swipeable viewer for showing friends.
 *
 * Navigation is a simple `dir` back-stack held in composition. The Back control (and the system
 * back button) pops one level; at the root it calls [onExit]. Only thumbnails are ever loaded into
 * the grid — never full files — so a folder of 4K videos costs the same as a folder of icons.
 *
 * @param onExit invoked when the user backs out of the root folder.
 */
@Composable
fun SpaceSaverGalleryScreen(onExit: () -> Unit) {
    var computer by remember { mutableStateOf(false) }
    val client = remember(computer) { SpaceSaverGalleryClient(computer = computer) }
    val scope = rememberCoroutineScope()
    var searchText by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    var loadingMore by remember { mutableStateOf(false) }
    var moreJob by remember { mutableStateOf<Job?>(null) }
    var moreError by remember { mutableStateOf<String?>(null) }
    val imageLoader = rememberAuthedImageLoader()

    // The path stack. "" is the root; each browse-in pushes the folder's rel path.
    val dirStack = remember(computer) { mutableStateListOf("") }
    val currentDir = dirStack.last()
    val latestDir by rememberUpdatedState(currentDir)

    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var unauthorized by remember { mutableStateOf(false) }
    var response by remember { mutableStateOf<LibraryResponse?>(null) }

    // Bumped by "Try again" to force a reload of the same directory (whose value is unchanged).
    var reloadTick by remember { mutableStateOf(0) }

    // Which item (index into the current folder's media items) the viewer is showing, or null.
    var viewerIndex by remember { mutableStateOf<Int?>(null) }

    // How the photos/videos in the current folder are ordered. Remembered across folders so a chosen
    // order sticks as you browse. Newest-first matches what the server already returns.
    var sortMode by remember { mutableStateOf(GallerySort.NEWEST) }

    // Load whenever the current directory changes (or a retry is requested). Keyed on currentDir so
    // a browse-in / back cancels any in-flight load and starts the right one.
    LaunchedEffect(computer, currentDir, query, reloadTick) {
        moreJob?.cancel()
        moreJob = null
        loadingMore = false
        loading = true
        response = null
        moreError = null
        error = null
        unauthorized = false
        try {
            response = client.library(currentDir, query)
        } catch (e: GalleryException) {
            error = e.message ?: "Something went wrong"
            unauthorized = e.unauthorized
            response = null
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            error = "Something went wrong loading your library"
            response = null
        } finally {
            loading = false
        }
    }

    fun goBack() {
        if (viewerIndex != null) {
            viewerIndex = null
        } else if (query.isNotEmpty()) {
            query = ""; searchText = ""
        } else if (dirStack.size > 1) {
            dirStack.removeAt(dirStack.size - 1)
        } else {
            onExit()
        }
    }

    BackHandler(enabled = true) { goBack() }

    // Full-screen viewer takes over entirely when open. Ordered per the chosen sort — the grid and
    // the viewer both read this same list, so tapping a tile always opens the right item.
    val mediaItems = remember(response, sortMode) {
        val raw = response?.items.orEmpty()
        when (sortMode) {
            GallerySort.NEWEST -> raw.sortedByDescending { it.mtime }
            GallerySort.OLDEST -> raw.sortedBy { it.mtime }
            GallerySort.NAME -> raw.sortedBy { it.name.lowercase() }
        }
    }
    val openIndex = viewerIndex
    if (openIndex != null && openIndex in mediaItems.indices) {
        SpaceSaverViewerScreen(
            items = mediaItems,
            startIndex = openIndex,
            client = client,
            imageLoader = imageLoader,
            onClose = { viewerIndex = null }
        )
        return
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            GalleryTopBar(
                title = if (currentDir.isBlank()) (if (computer) "Computer drives" else "My backups") else titleForDir(currentDir),
                onBack = { goBack() }
            )

            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !computer, enabled = !loadingMore, onClick = { computer = false; query = ""; searchText = "" }, label = { Text("My backups") })
                if (BeeboApp.instance.session.isAdmin) {
                    FilterChip(selected = computer, enabled = !loadingMore, onClick = { computer = true; query = ""; searchText = "" }, label = { Text("Browse computer") })
                }
            }
            if (computer) {
                Text("Browse drives or search photo and video filenames, including subfolders. Your computer must be on and reachable.",
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(value = searchText, onValueChange = { searchText = it.take(120) },
                        label = { Text(if (currentDir.isBlank()) "Search all drives" else "Search this folder") },
                        singleLine = true, modifier = Modifier.weight(1f))
                    TextButton(onClick = { query = searchText.trim(); reloadTick++ }, enabled = !loadingMore) { Text("Search") }
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { query = ""; searchText = ""; dirStack.clear(); dirStack.add("") }, enabled = !loadingMore) { Text("All drives") }
                    TextButton(onClick = { query = ""; searchText = ""; reloadTick++ }, enabled = !loadingMore) { Text(if (query.isEmpty()) "Refresh" else "Clear search") }
                }
                if (currentDir.isNotEmpty()) Text(currentDir, style = MaterialTheme.typography.bodySmall,
                    maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp))
            }
            when {
                loading -> CenteredState {
                    CircularProgressIndicator()
                }

                error != null -> ErrorState(
                    message = error!!,
                    unauthorized = unauthorized,
                    onRetry = { reloadTick++ }
                )

                response?.isEmpty == true && response?.nextCursor == null -> EmptyState(computer, query.isNotEmpty(), response?.notice.orEmpty())

                else -> {
                    val folders = response?.folders.orEmpty()
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(minSize = 112.dp),
                        contentPadding = PaddingValues(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxSize()
                    ) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            Column {
                                response?.notice?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                                moreError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                                if (response?.nextCursor != null) {
                                    Button(enabled = !loadingMore, onClick = {
                                        val old = response ?: return@Button
                                        val next = old.nextCursor ?: return@Button
                                        val requestedClient = client
                                        val requestedDir = currentDir
                                        val requestedQuery = query
                                        loadingMore = true; moreError = null
                                        moreJob = scope.launch {
                                            try {
                                                val page = requestedClient.library(requestedDir, requestedQuery, next)
                                                if (computer == requestedClient.computer && latestDir == requestedDir && query == requestedQuery) {
                                                    response = page.copy(folders = (old.folders + page.folders).distinctBy { it.rel }, items = (old.items + page.items).distinctBy { it.rel })
                                                }
                                            } catch (e: CancellationException) { throw e
                                            } catch (e: Exception) {
                                                if (computer == requestedClient.computer && latestDir == requestedDir && query == requestedQuery) moreError = e.message
                                            } finally { loadingMore = false }
                                        }
                                    }) { Text(if (loadingMore) "Searching…" else if (query.isNotEmpty()) "Search further (${response?.scanned} checked)" else "Load more") }
                                }
                            }
                        }
                        if (mediaItems.isNotEmpty()) {
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                SortBar(sortMode = sortMode, onChange = { sortMode = it })
                            }
                        }
                        if (folders.isNotEmpty()) {
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                SectionHeader("Folders")
                            }
                            items(folders, key = { "folder:" + it.rel }) { folder ->
                                FolderTile(folder = folder, onOpen = {
                                    if (folder.rel.isNotBlank() && !loadingMore) { query = ""; searchText = ""; dirStack.add(folder.rel) }
                                })
                            }
                        }
                        if (mediaItems.isNotEmpty()) {
                            if (folders.isNotEmpty()) {
                                item(span = { GridItemSpan(maxLineSpan) }) {
                                    SectionHeader("Photos & Videos")
                                }
                            }
                            items(mediaItems.size, key = { "item:" + mediaItems[it].rel }) { index ->
                                MediaTile(
                                    item = mediaItems[index],
                                    thumbUrl = client.thumbUrl(mediaItems[index].rel),
                                    imageLoader = imageLoader,
                                    onOpen = { if (!loadingMore) viewerIndex = index }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun titleForDir(dir: String): String =
    if (dir.isBlank()) "Photos & Videos" else dir.substringAfterLast('/').ifBlank { dir }

/** How the current folder's photos & videos are ordered. */
private enum class GallerySort { NEWEST, OLDEST, NAME }

@Composable
private fun SortBar(sortMode: GallerySort, onChange: (GallerySort) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            "Sort",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        FilterChip(
            selected = sortMode == GallerySort.NEWEST,
            onClick = { onChange(GallerySort.NEWEST) },
            label = { Text("Newest") }
        )
        FilterChip(
            selected = sortMode == GallerySort.OLDEST,
            onClick = { onChange(GallerySort.OLDEST) },
            label = { Text("Oldest") }
        )
        FilterChip(
            selected = sortMode == GallerySort.NAME,
            onClick = { onChange(GallerySort.NAME) },
            label = { Text("Name") }
        )
    }
}

@Composable
private fun GalleryTopBar(title: String, onBack: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconButton(onClick = onBack) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back"
            )
        }
        Text(
            text = title,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(start = 4.dp)
                .weight(1f)
        )
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp)
    )
}

@Composable
private fun FolderTile(folder: GalleryFolder, onOpen: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onOpen)
            .padding(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Icon(
            imageVector = Icons.Filled.Folder,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(44.dp)
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = folder.name.ifBlank { folder.rel.substringAfterLast('/') },
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth()
        )
        Text(
            text = countLabel(folder.itemCount),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1
        )
    }
}

private fun countLabel(n: Int): String = when {
    n < 0 -> "Open folder"
    n == 1 -> "1 item"
    else -> "$n items"
}

@Composable
private fun MediaTile(
    item: GalleryItem,
    thumbUrl: String,
    imageLoader: ImageLoader,
    onOpen: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onOpen)
    ) {
        val context = androidx.compose.ui.platform.LocalContext.current
        SubcomposeAsyncImage(
            model = ImageRequest.Builder(context)
                .data(thumbUrl.ifBlank { null })
                .crossfade(true)
                .build(),
            imageLoader = imageLoader,
            contentDescription = item.name,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize()
        ) {
            when (painter.state) {
                is AsyncImagePainter.State.Loading ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
                    }
                is AsyncImagePainter.State.Error ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Icon(
                            imageVector = Icons.Filled.BrokenImage,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(28.dp)
                        )
                    }
                else -> SubcomposeAsyncImageContent()
            }
        }
        if (item.isVideo) {
            Icon(
                imageVector = Icons.Filled.PlayCircle,
                contentDescription = "Video",
                tint = Color.White,
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(40.dp)
            )
        }
    }
}

@Composable
private fun CenteredState(content: @Composable () -> Unit) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) { content() }
}

@Composable
private fun EmptyState(computer: Boolean = false, searching: Boolean = false, notice: String = "") {
    CenteredState {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp)
        ) {
            Icon(
                imageVector = Icons.Filled.PhotoLibrary,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(64.dp)
            )
            Spacer(Modifier.height(16.dp))
            Text(
                text = if (computer) (if (searching) "No matching photos or videos" else "No photos or videos here") else "No backups yet",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = if (computer) "Try another folder or filename. $notice" else "Back up photos from the Space Saver screen first, then they'll appear here to browse and show friends.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun ErrorState(message: String, unauthorized: Boolean, onRetry: () -> Unit) {
    CenteredState {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp)
        ) {
            Icon(
                imageVector = Icons.Filled.BrokenImage,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(56.dp)
            )
            Spacer(Modifier.height(16.dp))
            Text(
                text = if (unauthorized) "Please sign in again" else "Couldn't load your library",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(20.dp))
            Button(onClick = onRetry) { Text("Try again") }
        }
    }
}
