package com.beeboentertainment.movie.scan

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/** Google Play build: Google's code scanner screen. No camera permission, see QrScan.kt. */
@Composable
fun rememberQrScanner(onResult: (QrScanResult) -> Unit): QrScanner {
    val context = LocalContext.current
    val latest = rememberUpdatedState(onResult)
    return remember(context) {
        QrScanner {
            val options = GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build()
            try {
                GmsBarcodeScanning.getClient(context, options).startScan()
                    .addOnSuccessListener { code -> latest.value(QrScanResult.Text(code.rawValue.orEmpty())) }
                    .addOnCanceledListener { latest.value(QrScanResult.Cancelled) }
                    .addOnFailureListener { latest.value(QrScanResult.Unavailable(QrScanMessages.FALLBACK)) }
            } catch (e: Exception) {
                latest.value(QrScanResult.Unavailable(QrScanMessages.FALLBACK))
            }
        }
    }
}
