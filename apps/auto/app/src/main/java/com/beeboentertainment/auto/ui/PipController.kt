package com.beeboentertainment.auto.ui

import android.app.Activity
import android.app.PendingIntent
import android.app.RemoteAction
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Rect
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Log
import android.util.Rational
import androidx.annotation.RequiresApi

/**
 * Android system Picture-in-Picture (PIP): pop the playing video out of the app
 * into a small floating system window so the film keeps playing while the user
 * does something else on the phone.
 *
 * PIP is the "leave the app entirely" mode. It is **not** the in-app
 * [com.beeboentertainment.auto.party.VideoWindow], which is a draggable frame that only
 * ever lives inside this app's own screen. Both can coexist:
 *
 *  - `VideoWindow`  — an in-app, movable/resizable overlay drawn by Compose. Only
 *    visible while the app is on screen.
 *  - PIP (this file) — a genuine OS-level floating window that survives pressing
 *    Home and floats over other apps. Entered here; the system owns the surface.
 *
 * Either way the underlying Media3 `Player` never stops, so `PartyController`
 * keeps emitting/applying sync beats the whole time — going into PIP does not
 * touch the watch-party at all.
 *
 * Everything here is guarded twice over:
 *  - a feature check ([isPipSupported]) — some devices simply have no PIP, and
 *    `enterPictureInPictureMode` throws `IllegalStateException` on them;
 *  - an API-level check — `PictureInPictureParams` / `enterPictureInPictureMode`
 *    need API 26 (`minSdk` here is 24), and `setAutoEnterEnabled` /
 *    `setSourceRectHint` need API 31.
 *
 * TODO(device): PIP surface handoff is the part that only real hardware settles.
 * Verify the ExoPlayer/PlayerView surface stays attached across the enter/exit
 * transition (some OEMs briefly detach the SurfaceView and the picture blanks);
 * verify [buildParams]'s source-rect hint actually matches the on-screen video
 * bounds so the shrink animation flows from the right place; and verify that
 * updating actions via [applyParams] refreshes the PIP window's buttons live.
 */
object PipController {

    private const val TAG = "PipController"

    /** 16:9, the aspect the passenger stage and most content use. */
    val DEFAULT_ASPECT: Rational = Rational(16, 9)

    /** True if this device advertises the PIP system feature at all. */
    fun isPipSupported(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            context.packageManager
                .hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    /**
     * Build the params that describe the PIP window.
     *
     * @param aspect the window's aspect ratio (defaults to 16:9). The system
     *   clamps extreme ratios; keep it between roughly 1:2.39 and 2.39:1.
     * @param sourceRectHint the video's current on-screen bounds, so the system
     *   animates the shrink from there. Only applied on API 31+.
     * @param actions PIP window buttons (e.g. play/pause). Only applied on 26+
     *   and capped by the system (usually 3). Build them with [playPauseAction].
     * @param autoEnter on API 31+, ask the system to auto-enter PIP when the user
     *   leaves the app (Home/recents) without needing `onUserLeaveHint`.
     *
     * Guarded to API 26; returns null below that so callers can no-op cleanly.
     */
    @RequiresApi(Build.VERSION_CODES.O)
    fun buildParams(
        aspect: Rational = DEFAULT_ASPECT,
        sourceRectHint: Rect? = null,
        actions: List<RemoteAction> = emptyList(),
        autoEnter: Boolean = true,
    ): android.app.PictureInPictureParams {
        val b = android.app.PictureInPictureParams.Builder()
            .setAspectRatio(aspect)
        if (actions.isNotEmpty()) b.setActions(actions)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // API 31+ only: auto-enter on Home, and animate from the video's rect.
            b.setAutoEnterEnabled(autoEnter)
            sourceRectHint?.let { b.setSourceRectHint(it) }
        }
        return b.build()
    }

    /**
     * Enter PIP now. Safe on every API level: it no-ops with a logged reason when
     * PIP is unsupported or the API is too old, so callers never have to guard.
     *
     * @return true if the app actually asked to enter PIP.
     */
    fun enter(
        activity: Activity,
        aspect: Rational = DEFAULT_ASPECT,
        sourceRectHint: Rect? = null,
        actions: List<RemoteAction> = emptyList(),
    ): Boolean {
        if (!isPipSupported(activity)) {
            Log.i(TAG, "enter(): PIP not supported on this device; ignoring")
            return false
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            Log.i(TAG, "enter(): PIP needs API 26 (have ${Build.VERSION.SDK_INT})")
            return false
        }
        return runCatching {
            activity.enterPictureInPictureMode(
                buildParams(aspect, sourceRectHint, actions),
            )
        }.onFailure {
            // Devices that report the feature can still refuse (e.g. PIP disabled
            // in system settings); enterPictureInPictureMode throws rather than
            // returns false, so swallow it.
            Log.w(TAG, "enter(): system refused PIP: ${it.message}")
        }.isSuccess
    }

    /**
     * Push updated params to the system **without** entering PIP. This is how
     * API 31+ auto-enter is armed (and how PIP action buttons are refreshed while
     * already in PIP — e.g. flipping a Play button to Pause). No-ops below API 26.
     *
     * Call this whenever "video is playing" changes so auto-enter tracks it: arm
     * it (autoEnter = true) while a film is playing, disarm it when stopped, so
     * pressing Home during a menu doesn't shrink an idle app.
     */
    fun applyParams(
        activity: Activity,
        aspect: Rational = DEFAULT_ASPECT,
        sourceRectHint: Rect? = null,
        actions: List<RemoteAction> = emptyList(),
        autoEnter: Boolean = true,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (!isPipSupported(activity)) return
        runCatching {
            activity.setPictureInPictureParams(
                buildParams(aspect, sourceRectHint, actions, autoEnter),
            )
        }.onFailure { Log.w(TAG, "applyParams(): ${it.message}") }
    }

    /**
     * Build one PIP action button (API 26+). The [intent] should reach a
     * component that drives the player — typically a broadcast to a small
     * `BroadcastReceiver` that calls `player.play()` / `player.pause()`.
     *
     * TODO(device): wire the receiver and swap the icon/title between Play and
     * Pause as playback state changes, re-pushing via [applyParams]; verify the
     * button updates live in the floating window on the target OS.
     */
    @RequiresApi(Build.VERSION_CODES.O)
    fun playPauseAction(
        context: Context,
        iconResId: Int,
        title: CharSequence,
        intent: PendingIntent,
    ): RemoteAction =
        RemoteAction(
            Icon.createWithResource(context, iconResId),
            title,
            title,
            intent,
        )
}
