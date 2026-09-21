package com.beeboentertainment.movie.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Search
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.beeboentertainment.movie.core.TitleRequestLogic

/**
 * A visible ring on whatever currently has focus. A phone never shows it (touch doesn't move
 * focus); on a TV remote it is the only way to see where the D-pad is. Put it BEFORE the
 * clickable/focusable modifier it should follow.
 */
@Composable
fun Modifier.dpadFocusRing(shape: Shape = RoundedCornerShape(8.dp)): Modifier {
    var focused by remember { mutableStateOf(false) }
    val ring = MaterialTheme.colorScheme.primary
    return this
        .onFocusChanged { focused = it.isFocused || it.hasFocus }
        .border(width = if (focused) 3.dp else 0.dp, color = if (focused) ring else Color.Transparent, shape = shape)
}

/**
 * A poster tile for the Collections screens. Unlike PosterCard it can be dimmed (a film you
 * don't own) and carries one short badge under the title ("Requested", "Not in library").
 */
@Composable
fun CollectionTile(
    title: String,
    subtitle: String?,
    posterUrl: String?,
    badge: String? = null,
    dimmed: Boolean = false,
    /** ▶ trailer button (bottom-right of the poster), the same one PosterCard carries. */
    onTrailer: (() -> Unit)? = null,
    /** 🔍 look it up on the owner's search site (bottom-left), for films not in the library. */
    onSearch: (() -> Unit)? = null,
    onClick: () -> Unit
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(4.dp)
            .dpadFocusRing()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(2.dp)
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(2f / 3f)
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
        ) {
            if (posterUrl != null) {
                AsyncImage(
                    model = posterUrl,
                    contentDescription = title,
                    modifier = Modifier
                        .fillMaxSize()
                        .alpha(if (dimmed) 0.4f else 1f)
                )
            } else {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Movie, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (onSearch != null) {
                Box(
                    Modifier
                        .align(Alignment.BottomStart)
                        .padding(4.dp)
                        .clip(RoundedCornerShape(50))
                        .background(Color(0xAA000000))
                ) {
                    androidx.compose.material3.IconButton(onClick = onSearch, modifier = Modifier.size(40.dp)) {
                        Icon(
                            Icons.Filled.Search,
                            contentDescription = "Look this up",
                            tint = Color.White,
                            modifier = Modifier.size(17.dp)
                        )
                    }
                }
            }
            if (onTrailer != null) {
                // The YouTube play button itself (its own red and white), no dark circle behind it.
                androidx.compose.material3.IconButton(
                    onClick = onTrailer,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(2.dp).size(30.dp)
                ) {
                    Icon(
                        androidx.compose.ui.res.painterResource(com.beeboentertainment.movie.R.drawable.ic_youtube),
                        contentDescription = "Watch the trailer on YouTube",
                        tint = Color.Unspecified,
                        modifier = Modifier.size(width = 26.dp, height = 19.dp)
                    )
                }
            }
            if (badge != null) {
                Surface(
                    modifier = Modifier.align(Alignment.TopEnd).padding(4.dp),
                    color = if (dimmed) Color(0xCC3A1F22) else MaterialTheme.colorScheme.primary,
                    shape = RoundedCornerShape(4.dp)
                ) {
                    Text(
                        badge.uppercase(),
                        modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                        fontSize = 9.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (dimmed) Color(0xFFFF9D9D) else MaterialTheme.colorScheme.onPrimary
                    )
                }
            }
        }
        Text(
            title,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 4.dp),
            color = if (dimmed) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onBackground
        )
        if (!subtitle.isNullOrBlank()) {
            Text(subtitle, maxLines = 1, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * "Request <title>" with an optional note. Shared by the Request a title screen and a
 * collection's not-owned films. [error] is shown inside the dialog so a refusal (already in the
 * library, too many requests) doesn't close it.
 */
@Composable
fun RequestNoteDialog(
    title: String,
    subtitle: String?,
    posterUrl: String?,
    busy: Boolean,
    error: String?,
    onSubmit: (note: String) -> Unit,
    onDismiss: () -> Unit
) {
    var note by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Request $title", fontWeight = FontWeight.Bold, fontSize = 18.sp) },
        text = {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .width(54.dp)
                            .height(81.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant),
                        contentAlignment = Alignment.Center
                    ) {
                        if (posterUrl != null) {
                            AsyncImage(model = posterUrl, contentDescription = title, modifier = Modifier.fillMaxSize())
                        } else {
                            Icon(Icons.Filled.Movie, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Spacer(Modifier.width(12.dp))
                    Text(
                        (subtitle?.let { "$it\n" } ?: "") + "The owner of this Beebo server sees your request, and it shows as added once it's in the library.",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = TitleRequestLogic.clampNote(it) },
                    label = { Text("Note (optional)") },
                    placeholder = { Text("e.g. the 2021 one, not the original") },
                    enabled = !busy,
                    minLines = 2,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth()
                )
                Text(
                    TitleRequestLogic.noteCounter(note),
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.align(Alignment.End)
                )
                if (!error.isNullOrBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text(error, fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = { onSubmit(note) }) { Text(if (busy) "Sending…" else "Send request") }
        },
        dismissButton = {
            TextButton(enabled = !busy, onClick = onDismiss) { Text("Cancel") }
        }
    )
}
