package com.beeboentertainment.movie.spacesaver.gallery

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import coil.ImageLoader
import com.beeboentertainment.movie.BeeboApp
import okhttp3.Interceptor
import okhttp3.OkHttpClient

/**
 * Builds a Coil [ImageLoader] that attaches `Authorization: Bearer <token>` to requests aimed at the
 * user's own server, and only those.
 *
 * Why a dedicated loader: Space Saver thumbnails and full-size photos are PRIVATE — the server
 * rejects an unauthenticated request. We must NOT put the token in the URL (it would leak into
 * disk/memory caches and logs), so instead a per-request OkHttp interceptor reads the current token
 * from the live session and stamps the header just before the request goes out. Reading the token
 * fresh each time (rather than baking it into the loader) means the loader keeps working across a
 * token refresh without being rebuilt.
 *
 * The header is only added when the request URL starts with the configured server base, so images
 * from anywhere else (should any ever appear) never receive the bearer token.
 */
object AuthedImageLoader {

    private val authInterceptor = Interceptor { chain ->
        val original = chain.request()
        val session = BeeboApp.instance.session
        val base = session.baseUrl
        val token = session.token
        val request =
            if (!base.isNullOrBlank() && !token.isNullOrBlank() &&
                original.url.toString().startsWith(base)
            ) {
                original.newBuilder()
                    .header("Authorization", "Bearer $token")
                    .build()
            } else {
                original
            }
        chain.proceed(request)
    }

    /**
     * Build a loader bound to [context]'s application context. Reuses the app's shared OkHttp
     * connection pool as its base so thumbnails share sockets with the rest of the app, then layers
     * the auth interceptor on top. Crossfade on for a gentle, polished grid.
     */
    fun build(context: Context): ImageLoader {
        val base = runCatching { BeeboApp.instance.api.okHttp }.getOrNull()
        val builder = base?.newBuilder() ?: com.beeboentertainment.movie.core.CleartextPolicy.install(OkHttpClient.Builder())
        val client = builder.addInterceptor(authInterceptor).build()
        return ImageLoader.Builder(context.applicationContext)
            .okHttpClient(client)
            .crossfade(true)
            .build()
    }
}

/**
 * Remember a single authed [ImageLoader] for the lifetime of the composition. One loader is shared
 * by the grid and the full-screen viewer so they hit the same memory/disk cache.
 */
@Composable
fun rememberAuthedImageLoader(): ImageLoader {
    val context = LocalContext.current
    return remember { AuthedImageLoader.build(context) }
}
