package com.beeboentertainment.movie.campsite

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

/** The host uses the same local sharing page as guests, with the system picker for chosen files. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun CampsiteSlidesScreen(onOpenCampsite: () -> Unit) {
    val campsite by CampsiteHost.state.collectAsState()
    val context = LocalContext.current
    var chooser by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        chooser?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        chooser = null
    }
    if (!campsite.running) {
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Shared photos & videos", style = MaterialTheme.typography.headlineSmall)
            Text("Start Campsite Mode and connect your guests to the same Wi-Fi. Then anyone can take a turn presenting photos and videos from their phone.")
            Button(onClick = onOpenCampsite) { Text("Open Campsite Mode") }
        }
        return
    }
    val address = "http://127.0.0.1:${campsite.port}"
    val web = remember(address) { WebView(context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.mediaPlaybackRequiresUserGesture = true
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return true
                return uri.scheme != "http" || uri.host != "127.0.0.1" || uri.port != campsite.port
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean {
                chooser?.onReceiveValue(null); chooser = callback
                return try {
                    val intent = params?.createIntent() ?: throw IllegalStateException("File selection unavailable")
                    picker.launch(intent); true
                } catch (_: Exception) {
                    chooser?.onReceiveValue(null); chooser = null
                    error = "Could not open your file picker. Please try again."; true
                }
            }
        }
        loadUrl("$address/join?name=Host&next=slides")
    } }
    DisposableEffect(web) { onDispose { chooser?.onReceiveValue(null); chooser = null; web.stopLoading(); web.destroy() } }
    Column(Modifier.fillMaxSize()) {
        error?.let { Text(it, Modifier.padding(12.dp), color = MaterialTheme.colorScheme.error) }
        AndroidView(factory = { web }, modifier = Modifier.weight(1f).fillMaxWidth())
    }
}
