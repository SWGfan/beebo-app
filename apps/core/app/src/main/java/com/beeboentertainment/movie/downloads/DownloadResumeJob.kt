package com.beeboentertainment.movie.downloads

import android.app.job.JobParameters
import android.app.job.JobService
import com.beeboentertainment.movie.BeeboApp

/**
 * Wakes the app when downloads that were waiting can run again: scheduled with an UNMETERED
 * network requirement while rows wait for Wi-Fi (ANY while they wait for a network at all).
 * The system runs it even if the app's process has since died.
 */
class DownloadResumeJob : JobService() {
    override fun onStartJob(params: JobParameters?): Boolean {
        runCatching { BeeboApp.instance.downloads.kick(fromBackground = true) }
        return false
    }

    override fun onStopJob(params: JobParameters?): Boolean = false
}
