package com.beeboentertainment.movie.movienight

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.server.ServerException
import kotlinx.coroutines.CancellationException

/**
 * Movie Night on the phone and the TV (docs/MOVIE-NIGHT.md, movienight/MovieNight.kt): asks the computer whether it is
 * available, starts a room as the signed-in person, and shows the computer's own shared-screen page in a web view that can
 * only visit that computer. Phones join by scanning the code on the page, on the home Wi-Fi, with no account.
 *
 * Back leaves Movie Night (the room ends by itself ten minutes after the last screen leaves). No Google Play services are
 * involved: the web view is the system's (Chromium on Android TV, the Amazon web view on Fire OS).
 * UNVERIFIED on a real TV: the page's own remote handling inside this web view, focus and the Back key have not been tried.
 */
@Composable
fun MovieNightScreen(onUnauthorized: () -> Unit) {
    var attempt by remember { mutableIntStateOf(0) }
    var url by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    val base = BeeboApp.instance.session.baseUrl

    LaunchedEffect(attempt) {
        url = null
        problem = null
        try {
            val client = MovieNightClient.get()
            val status = client.status()
            if (!status.available) {
                problem = status.message.ifBlank { "Movie Night is switched off on your Beebo computer (Settings, Movie Night)." }
                return@LaunchedEffect
            }
            val opened = MovieNight.tvUrl(base, client.createRoom())
            if (opened == null) problem = "The computer sent something this app didn't understand. Update Beebo on the computer and this app."
            else url = opened
        } catch (e: CancellationException) {
            throw e
        } catch (_: UnauthorizedException) {
            onUnauthorized()
        } catch (e: ServerException) {
            problem = MovieNight.explain(e.status, e.code, e.message)
        } catch (_: Exception) {
            problem = "Could not start Movie Night."
        }
    }

    val shown = url
    when {
        shown != null -> MovieNightWebView(shown, base)
        else -> Column(
            Modifier.fillMaxSize().padding(32.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text("Movie Night", style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(12.dp))
            Text(problem ?: "Starting Movie Night…", style = MaterialTheme.typography.bodyLarge)
            if (problem != null) {
                Spacer(Modifier.height(16.dp))
                Text(
                    "Or open " + (base?.let { MovieNight.browserPage(it) } ?: "your computer's address plus /tv") +
                        " in a browser on another screen on your home Wi-Fi.",
                    style = MaterialTheme.typography.bodyMedium
                )
                Spacer(Modifier.height(16.dp))
                Button(onClick = { attempt++ }) { Text("Try again") }
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun MovieNightWebView(url: String, base: String?) {
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true        // the games are a page of script
                settings.domStorageEnabled = true        // it keeps the room ticket in sessionStorage
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.setSupportMultipleWindows(false)
                settings.mediaPlaybackRequiresUserGesture = false
                settings.cacheMode = WebSettings.LOAD_NO_CACHE
                isFocusable = true
                isFocusableInTouchMode = true
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        !MovieNight.allowsNavigation(base, request.url?.toString())

                    override fun onPageStarted(view: WebView, pageUrl: String?, favicon: Bitmap?) {
                        // a page that somehow started elsewhere is never left on screen
                        if (!MovieNight.allowsNavigation(base, pageUrl)) view.stopLoading()
                    }
                }
                loadUrl(url)
                requestFocus()
            }
        },
        onRelease = { view ->
            view.stopLoading()
            view.destroy()
        }
    )
}
