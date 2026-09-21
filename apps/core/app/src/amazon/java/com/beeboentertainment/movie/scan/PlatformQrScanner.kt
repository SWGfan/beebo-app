package com.beeboentertainment.movie.scan

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState

/**
 * Amazon Appstore build: no in-app QR scanner. Google's code scanner needs Google Play services,
 * which Fire OS does not have (the play build's scanner, src/play), and the website build's
 * CameraX scanner would add a CAMERA permission and ~1.5 MB for a device family with no camera
 * (Fire TV) or a poor one. The sign-in screen already hides the button on a TV and signs in there
 * with the on-screen pairing code. On a Fire tablet the button is shown, and tapping it gives the
 * ordinary "use the camera app or Paste" message (QrScanMessages.FALLBACK).
 *
 * Same signature as the web and play copies; see QrScan.kt and docs/FIRE-TV.md.
 */
@Composable
fun rememberQrScanner(onResult: (QrScanResult) -> Unit): QrScanner {
    val latest = rememberUpdatedState(onResult)
    return remember { QrScanner { latest.value(QrScanResult.Unavailable(QrScanMessages.FALLBACK)) } }
}
