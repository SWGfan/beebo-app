package com.beeboentertainment.auto

import android.app.Application
import com.beeboentertainment.auto.remote.AutoRemote

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        // Before anything makes a request: Android Auto can start PlaybackService with no
        // Activity, and its first browse must already know how to reach name.beebo.tv.
        AutoRemote.init(this)
    }
}
