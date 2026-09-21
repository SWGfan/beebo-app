package com.beeboentertainment.movie.stories

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImagePainter
import coil.compose.SubcomposeAsyncImage
import coil.compose.SubcomposeAsyncImageContent
import coil.request.ImageRequest
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.spacesaver.gallery.rememberAuthedImageLoader

/** The shape every page illustration is drawn at, so the placeholder reserves the right space. */
private const val SCENE_ASPECT = 1086f / 1448f

/**
 * The picture for one story page.
 *
 * The artwork lives on the home computer rather than inside this APK. Twelve full-page
 * illustrations would more than double the app download, and the pictures are identical for every
 * reader, so they ship once with the Windows app and are fetched over the connection the app
 * already holds. [rememberAuthedImageLoader] stamps the bearer token on the way out - the story
 * routes sit behind the sign-in gate like the rest of the api - and Coil caches each picture on
 * disk, so a page the child flips back to does not cost a second download.
 *
 * Only a book that sets hasScenes asks at all. The other books on the shelf still carry early
 * placeholder drawings in the repository, but they are neither flagged nor packaged, so they make
 * no request and show no gap. See desktop/apps/desktop/storybooks/README.md.
 *
 * Reading never depends on any of this. No book art, no computer address, no session, a computer
 * that is switched off, or a page nobody drew - every one of those renders nothing at all and the
 * text below carries the story exactly as it does offline today.
 */
@Composable
internal fun StoryScene(slug: String?, book: StoryBook, page: StoryPage, names: Map<String, String>) {
    if (!book.hasScenes || slug.isNullOrBlank()) return
    val base = BeeboApp.instance.session.baseUrl ?: return
    val url = UrlUtils.endpoint(base, "/api/storybook-scene/$slug/page_${page.id}.png") ?: return
    val context = LocalContext.current
    val loader = rememberAuthedImageLoader()
    SubcomposeAsyncImage(
        model = ImageRequest.Builder(context).data(url).crossfade(true).build(),
        imageLoader = loader,
        contentDescription = page.alt.takeIf { it.isNotBlank() }?.let { book.personalize(it, names) },
        contentScale = ContentScale.Fit,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)),
    ) {
        when (painter.state) {
            is AsyncImagePainter.State.Success -> SubcomposeAsyncImageContent()
            // Hold the picture's space while it arrives, so the words do not jump under a finger.
            is AsyncImagePainter.State.Loading -> Box(
                Modifier.fillMaxWidth().aspectRatio(SCENE_ASPECT)
                    .background(MaterialTheme.colorScheme.surfaceVariant)
            )
            // Nothing to show, and nothing to apologise for. The story simply reads on.
            else -> Unit
        }
    }
}
