package com.beeboentertainment.movie.scan

import android.Manifest
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Website build: CameraX plus the ZXing decoder already in the app. See QrScan.kt. */
@Composable
fun rememberQrScanner(onResult: (QrScanResult) -> Unit): QrScanner {
    val context = LocalContext.current
    val latest = rememberUpdatedState(onResult)
    var showing by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) showing = true else latest.value(QrScanResult.Unavailable(QrScanMessages.NO_CAMERA_PERMISSION))
    }
    if (showing) {
        CameraScanDialog(
            onText = { showing = false; latest.value(QrScanResult.Text(it)) },
            onCancel = { showing = false; latest.value(QrScanResult.Cancelled) },
            onError = { showing = false; latest.value(QrScanResult.Unavailable(QrScanMessages.FALLBACK)) },
        )
    }
    return remember(context) {
        QrScanner {
            val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
            if (granted) showing = true else permission.launch(Manifest.permission.CAMERA)
        }
    }
}

private fun Context.lifecycleOwner(): LifecycleOwner? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is LifecycleOwner) return c
        c = c.baseContext
    }
    return c as? LifecycleOwner
}

@Composable
private fun CameraScanDialog(onText: (String) -> Unit, onCancel: () -> Unit, onError: () -> Unit) {
    val context = LocalContext.current
    val owner = remember(context) { context.lifecycleOwner() }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val finished = remember { AtomicBoolean(false) }
    val main = remember { Handler(Looper.getMainLooper()) }
    val textCallback = rememberUpdatedState(onText)
    val errorCallback = rememberUpdatedState(onError)
    var provider by remember { mutableStateOf<ProcessCameraProvider?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            try { provider?.unbindAll() } catch (e: Exception) { /* already released */ }
            analysisExecutor.shutdown()
        }
    }

    Dialog(onDismissRequest = onCancel, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    val view = PreviewView(ctx)
                    val future = ProcessCameraProvider.getInstance(ctx)
                    future.addListener({
                        try {
                            val cameraProvider = future.get()
                            provider = cameraProvider
                            val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                            val analysis = ImageAnalysis.Builder()
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build()
                            analysis.setAnalyzer(analysisExecutor) { image ->
                                val text = decodeQr(image)
                                if (text != null && finished.compareAndSet(false, true)) main.post { textCallback.value(text) }
                            }
                            cameraProvider.unbindAll()
                            if (owner == null) throw IllegalStateException("no lifecycle")
                            cameraProvider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                        } catch (e: Exception) {
                            if (finished.compareAndSet(false, true)) main.post { errorCallback.value() }
                        }
                    }, ContextCompat.getMainExecutor(ctx))
                    view
                },
            )
            Column(
                Modifier.align(Alignment.BottomCenter).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Point the camera at the code on your computer’s screen.", color = Color.White)
                Button(onClick = onCancel, modifier = Modifier.padding(top = 12.dp)) { Text("Cancel") }
            }
        }
    }
}

/** One camera frame in, the QR text out (or null). Only the brightness plane is needed. */
private fun decodeQr(image: ImageProxy): String? {
    try {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val width = image.width
        val height = image.height
        val rowStride = plane.rowStride
        val data = ByteArray(width * height)
        for (row in 0 until height) {
            buffer.position(row * rowStride)
            buffer.get(data, row * width, width)
        }
        val source = PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false)
        val reader = QRCodeReader()
        return try {
            reader.decode(BinaryBitmap(HybridBinarizer(source)), mapOf(DecodeHintType.TRY_HARDER to true)).text
        } catch (e: com.google.zxing.ReaderException) {
            null
        } finally {
            reader.reset()
        }
    } catch (e: Exception) {
        return null
    } finally {
        image.close()
    }
}
