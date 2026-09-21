package com.beeboentertainment.movie.voice

import android.app.SearchManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.beeboentertainment.movie.core.VoiceSearch
import com.beeboentertainment.movie.player.PlayerActivity
import com.beeboentertainment.movie.ui.MainActivity
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The door Google Assistant, Google TV search, App Actions and the TV home screen's
 * "Continue watching" row come through. It has no screen of its own: it works out what was
 * asked for, starts the player (or opens the show), and finishes.
 *
 *  - android.media.action.MEDIA_PLAY_FROM_SEARCH  "Hey Google, play Heat on Beebo"
 *  - android.intent.action.SEARCH                  "Hey Google, search for Friends on Beebo"
 *  - android.intent.action.VIEW beebo://play/<kind>/<id>, beebo://open/show/<key>
 *        a Google TV search result or a Watch Next program
 *  - android.intent.action.VIEW beebo://feature?feature=continue watching   (App Actions)
 */
class VoiceSearchActivity : ComponentActivity() {

    companion object {
        const val SCHEME = "beebo"
        const val HOST_PLAY = "play"
        const val HOST_OPEN = "open"
        const val HOST_FEATURE = "feature"

        /** beebo://play/movie/<id>, beebo://play/tv/<episodeId>, beebo://open/show/<showKey> */
        fun deepLink(host: String, kind: String, id: String): Uri =
            Uri.Builder().scheme(SCHEME).authority(host).appendPath(kind).appendPath(id).build()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        val i = intent ?: return finish()
        lifecycleScope.launch {
            try {
                when (i.action) {
                    MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH -> playFromSearch(i)
                    Intent.ACTION_SEARCH -> searchFor(i)
                    Intent.ACTION_VIEW -> openLink(i.data)
                    else -> openApp()
                }
            } finally {
                finish()
            }
        }
    }

    private suspend fun playFromSearch(i: Intent) {
        val query = VoiceSearch.parse(
            raw = i.getStringExtra(SearchManager.QUERY),
            title = i.getStringExtra(MediaStore.EXTRA_MEDIA_TITLE),
            mediaFocus = i.getStringExtra(MediaStore.EXTRA_MEDIA_FOCUS)
        )
        val target = withTimeoutOrNull(15_000) { VoiceLibrary.resolve(query) }
        if (target == null) return notFound(query.title)
        play(target)
    }

    /**
     * "Hey Google, search for Friends on Beebo" (App Actions GET_THING, or the TV search box):
     * a show opens on its episode list, a film starts playing.
     */
    private suspend fun searchFor(i: Intent) {
        val query = VoiceSearch.parse(raw = i.getStringExtra(SearchManager.QUERY))
        val found = withTimeoutOrNull(15_000) { VoiceLibrary.match(query) } ?: return notFound(query.title)
        if (found.kind == VoiceSearch.Focus.SHOW) openShow(found.id)
        else openLink(deepLink(HOST_PLAY, "movie", found.id))
    }

    private suspend fun openLink(uri: Uri?) {
        if (uri == null || uri.scheme != SCHEME) return openApp()
        if (uri.host == HOST_FEATURE) {
            val feature = (uri.getQueryParameter("feature") ?: "").lowercase()
            if (feature.contains("continue") || feature.contains("resume")) {
                val t = withTimeoutOrNull(15_000) { VoiceLibrary.resolve(VoiceSearch.Query(title = "", resume = true)) }
                if (t != null) return play(t)
            }
            return openApp()
        }
        val kind = uri.pathSegments.getOrNull(0) ?: return openApp()
        val id = uri.pathSegments.getOrNull(1) ?: return openApp()
        if (uri.host == HOST_OPEN && kind == "show") return openShow(id)
        val target = withTimeoutOrNull(15_000) { VoiceLibrary.resolveId(kind, id) }
        if (target == null) {
            Toast.makeText(this, "That title isn't on your Beebo computer any more.", Toast.LENGTH_LONG).show()
            return openApp()
        }
        play(target)
    }

    private fun notFound(title: String) {
        val app = com.beeboentertainment.movie.BeeboApp.instance
        val msg = if (!app.session.isLoggedIn) "Sign in to Beebo first, then ask again."
        else "Beebo couldn't find ${title.ifBlank { "that" }} in your library."
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
        openApp()
    }

    private fun play(t: VoiceLibrary.PlayTarget) {
        val app = com.beeboentertainment.movie.BeeboApp.instance
        startActivity(
            PlayerActivity.intentFor(
                context = this,
                itemId = t.itemId,
                kind = t.kind,
                title = t.title,
                streamUrl = t.streamUrl,
                localPath = runCatching { app.downloads.localPath(t.itemId) }.getOrNull(),
                posterUrl = t.posterUrl,
                showKey = t.showKey
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    private fun openShow(showKey: String) {
        startActivity(
            Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_SHOW_KEY, showKey)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        )
    }

    private fun openApp() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
