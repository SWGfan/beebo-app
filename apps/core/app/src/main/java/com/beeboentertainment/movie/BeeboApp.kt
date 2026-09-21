package com.beeboentertainment.movie

import android.app.Application
import android.util.Log
import com.beeboentertainment.movie.core.ResumeStore
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.SessionStore
import com.beeboentertainment.movie.downloads.DownloadRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Manual dependency wiring. The app is small enough that a DI framework would be more
 * ceremony than help, so everything hangs off a single Application singleton.
 */
class BeeboApp : Application(), coil.ImageLoaderFactory {

    lateinit var session: SessionStore
        private set
    lateinit var api: ApiClient
        private set
    lateinit var downloads: DownloadRepository
        private set
    lateinit var resume: ResumeStore
        private set

    /** Long-lived scope for app-level background work (currently just the https upgrade probe). */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        instance = this
        // Only temporary private previews and unfinished encrypted uploads, never user backups.
        for (folder in listOf("vault-preview", "vault-upload")) {
            runCatching { java.io.File(cacheDir, folder).listFiles()?.filter { it.isFile }?.forEach { it.delete() } }
        }
        session = SessionStore(this)
        api = ApiClient(session)
        downloads = DownloadRepository(this, session.plain)
        // Queued downloads carry on after a restart, and wait for / resume on Wi-Fi.
        downloads.startAutoResume(scope)
        resume = ResumeStore(session.resumeKeyValueStore())
        // Away from home through name.beebo.tv: routes the shared OkHttp client's requests.
        com.beeboentertainment.movie.rtc.RemoteAccess.init(this, session, api.okHttp)
        Log.i(TAG, "Beebo Entertainment started; encrypted credential storage = ${session.usingEncryptedStorage}")
        maybeUpgradeToHttps()
        // Photo backup: make sure WorkManager's schedule matches the saved settings (off = nothing).
        runCatching { com.beeboentertainment.movie.photos.PhotoBackupScheduler.apply(this) }
        // NOTE: CastContext is initialised lazily by CastHelper the first time a screen asks for it.
        // Doing it here would crash on devices without Google Play services.
    }

    /**
     * Move an existing install from http:// to https:// now the server has a real certificate.
     *
     * PROBE FIRST, COMMIT SECOND. The saved address is only rewritten once a ping over https has
     * actually answered as a Beebo Entertainment server; a failure changes nothing, so someone running a
     * certificate-less server of their own keeps working exactly as before. Nothing is lost by
     * being cautious here, because plain HTTP still reaches the server — it just eats the 308
     * redirect on each request, which is precisely the cost this removes.
     *
     * Deliberately re-attempted on every launch rather than latched behind a "tried once" flag:
     * it is one cheap request, and it means an install self-heals the moment a certificate
     * appears, instead of staying on http forever because of one bad night.
     */
    private fun maybeUpgradeToHttps() {
        val current = session.baseUrl ?: return
        if (!UrlUtils.needsHttpsUpgrade(current)) return
        val upgraded = UrlUtils.upgradeToHttps(current) ?: return

        scope.launch {
            val reachable = runCatching { api.ping(upgraded).isBeeboServer }.getOrDefault(false)
            if (reachable) {
                session.baseUrl = upgraded
                Log.i(TAG, "Server address upgraded to https")
            } else {
                // Keep what was saved. http still works via the server's 308 redirect.
                Log.i(TAG, "https not answering at that address; keeping the saved http address")
            }
        }
    }

    /**
     * Posters and every other image load through the app's own OkHttp client, so they follow
     * the same route as the API: over the tunnel away from home, direct at home.
     */
    override fun newImageLoader(): coil.ImageLoader =
        coil.ImageLoader.Builder(this).okHttpClient(api.okHttp).build()

    companion object {
        private const val TAG = "BeeboApp"
        lateinit var instance: BeeboApp
            private set
    }
}
