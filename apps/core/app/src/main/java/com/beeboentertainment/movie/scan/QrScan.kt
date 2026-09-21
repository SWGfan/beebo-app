package com.beeboentertainment.movie.scan

/**
 * Scanning the QR code Beebo shows on the computer. The two builds scan differently, behind this one
 * shape (each build has its own rememberQrScanner):
 *
 *  - Google Play build: Google's code scanner screen (play-services-code-scanner). It runs in Google
 *    Play services, so this app asks for no camera permission at all. It needs Google Play services
 *    on the phone; without them the result is [QrScanResult.Unavailable] and the screen falls back
 *    to the camera app and paste.
 *  - Website build: CameraX with the ZXing decoder the app already carries, and a CAMERA permission
 *    that only the website build declares. No Google services needed.
 *
 * Nothing scanned is stored or sent anywhere. The text goes to PairLinks.parse, which only pre-fills
 * the sign-in screen.
 */
sealed interface QrScanResult {
    data class Text(val value: String) : QrScanResult
    data object Cancelled : QrScanResult
    /** Scanning cannot run here (no Google Play services, no camera, permission refused). [message] is for the person. */
    data class Unavailable(val message: String) : QrScanResult
}

class QrScanner(val start: () -> Unit)

object QrScanMessages {
    const val FALLBACK = "Scanning is not available on this phone right now. Open your phone’s camera app and point it at the code, " +
        "or copy the link on the computer and tap Paste."
    const val NO_CAMERA_PERMISSION = "Beebo was not allowed to use the camera. Open your phone’s camera app and point it at the code, " +
        "or allow the camera for Beebo in Settings."
}
