package com.beeboentertainment.movie.campsite

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Original artwork bundled with Beebo. Decoding never blocks the game or needs a network. */
private val gameArtCache = object : LruCache<String, ImageBitmap>(12 * 1024 * 1024) {
    override fun sizeOf(key: String, value: ImageBitmap): Int = value.width * value.height * 4
}

@Composable
internal fun GameArtImage(asset: String, modifier: Modifier = Modifier) {
    val assets = LocalContext.current.applicationContext.assets
    val bitmap by produceState(gameArtCache.get(asset), asset) {
        value = gameArtCache.get(asset) ?: withContext(Dispatchers.IO) {
            runCatching {
                assets.open("game-art/$asset").use { BitmapFactory.decodeStream(it)?.asImageBitmap() }
                    ?.also { gameArtCache.put(asset, it) }
            }.getOrNull()
        }
    }
    bitmap?.let { Image(it, contentDescription = null, modifier = modifier, contentScale = ContentScale.FillBounds) }
}

@Composable
internal fun GameArtwork(gameId: String, modifier: Modifier = Modifier) {
    Box(modifier.clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceVariant)) {
        GameArtImage("$gameId.png", Modifier.matchParentSize())
    }
}

@Composable
internal fun SoloArtworkBanner(gameId: String) {
    val text = when (gameId) {
        "five-letters" -> "Every letter is a clue"
        "sudoku" -> "Find your focus"
        "minesweeper" -> "Step carefully"
        "solitaire" -> "A moment for yourself"
        else -> return
    }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GameArtwork(gameId, Modifier.width(102.dp).height(56.dp))
        Spacer(Modifier.width(12.dp))
        Text(text, modifier = Modifier.weight(1f).padding(end = 10.dp), fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
