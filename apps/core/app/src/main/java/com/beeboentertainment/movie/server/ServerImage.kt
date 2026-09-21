package com.beeboentertainment.movie.server

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils

/**
 * A picture with a placeholder. Pictures from this server load through the app's own client (over
 * the tunnel away from home). Pictures from outside (a podcast's artwork, a station's logo) are
 * third-party: only https ones are loaded, and only ever as a picture.
 */
@Composable
fun CoverImage(
    /** Already-validated absolute address, or null for the placeholder. */
    url: String?,
    placeholder: ImageVector,
    modifier: Modifier = Modifier,
    round: Boolean = false,
    corner: Int = 8,
) {
    Box(
        modifier
            .clip(if (round) CircleShape else RoundedCornerShape(corner.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center
    ) {
        if (url != null) {
            AsyncImage(model = url, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        } else {
            Icon(placeholder, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

object CoverUrls {
    /** A server picture path (must start with [prefix]) joined onto this server's address. */
    fun server(path: String?, prefix: String): String? =
        SafeText.serverPathOrNull(path, prefix)?.let { UrlUtils.join(BeeboApp.instance.session.baseUrl, it) }

    /** Third-party artwork: https only. */
    fun external(url: String?): String? = SafeText.httpsUrlOrNull(url)
}
