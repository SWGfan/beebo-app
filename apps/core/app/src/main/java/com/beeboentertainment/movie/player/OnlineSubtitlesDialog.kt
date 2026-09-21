package com.beeboentertainment.movie.player

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.text.InputType
import android.widget.EditText
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.util.UnstableApi
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.LanguageCodes
import com.beeboentertainment.movie.core.OnlineSubtitleText
import com.beeboentertainment.movie.data.OnlineDownloadRequest
import com.beeboentertainment.movie.data.OnlineSubtitle
import kotlinx.coroutines.launch

/**
 * "Search online…" for subtitles. The computer does the searching with the owner's own
 * OpenSubtitles account and saves the chosen file next to the video, so every device gets it.
 */
@UnstableApi
object OnlineSubtitlesDialog {

    fun show(activity: AppCompatActivity, choices: PlaybackChoicesController, kind: String, id: String, configured: Boolean, isTv: Boolean) {
        if (!configured) {
            showSetupHelp(activity, isTv)
            return
        }
        val session = BeeboApp.instance.session
        val lang = LanguageCodes.twoLetter(session.subtitleLanguage).ifBlank { "en" }
        search(activity, choices, kind, id, lang, isTv)
    }

    private fun showSetupHelp(activity: AppCompatActivity, isTv: Boolean) {
        val b = AlertDialog.Builder(activity)
            .setTitle("Subtitle search isn't set up")
            .setMessage(OnlineSubtitleText.SETUP_HELP)
            .setPositiveButton("OK", null)
        if (!isTv) b.setNeutralButton("Open opensubtitles.com") { _, _ ->
            runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(OnlineSubtitleText.SIGN_UP_URL))) }
        }
        b.show()
    }

    private fun search(activity: AppCompatActivity, choices: PlaybackChoicesController, kind: String, id: String, lang: String, isTv: Boolean) {
        val progress = AlertDialog.Builder(activity)
            .setTitle("Searching online…")
            .setMessage("Looking for ${OnlineSubtitleText.languageWord(lang)} subtitles.")
            .setNegativeButton("Cancel", null)
            .show()
        val job = activity.lifecycleScope.launch {
            val r = runCatching { choices.api.searchOnline(kind, id, lang) }
            progress.dismiss()
            val body = r.getOrNull()
            when {
                body == null -> message(activity, "Search failed", r.exceptionOrNull()?.message ?: "Couldn't reach your computer.")
                body.error == "not_configured" -> showSetupHelp(activity, isTv)
                !body.ok -> message(activity, "Search failed", body.message ?: "OpenSubtitles didn't answer.")
                else -> results(activity, choices, kind, id, body.language, body.results, isTv)
            }
        }
        progress.setOnCancelListener { job.cancel() }
    }

    private fun results(activity: AppCompatActivity, choices: PlaybackChoicesController, kind: String, id: String, lang: String, results: List<OnlineSubtitle>, isTv: Boolean) {
        val b = AlertDialog.Builder(activity)
            .setTitle("${OnlineSubtitleText.languageWord(lang)} subtitles found")
            .setNegativeButton("Close", null)
            .setNeutralButton("Other language") { _, _ -> askLanguage(activity, choices, kind, id, lang, isTv) }
        if (results.isEmpty()) {
            b.setMessage("Nothing found for this video. Try another language.")
        } else {
            val shown = results.take(25)
            b.setItems(shown.map { OnlineSubtitleText.rowLabel(it) }.toTypedArray()) { _, which -> download(activity, choices, kind, id, shown[which]) }
        }
        b.show()
    }

    private fun askLanguage(activity: AppCompatActivity, choices: PlaybackChoicesController, kind: String, id: String, current: String, isTv: Boolean) {
        val input = EditText(activity).apply {
            setText(current)
            inputType = InputType.TYPE_CLASS_TEXT
            hint = "Two letters, like en, es or fr"
        }
        AlertDialog.Builder(activity)
            .setTitle("Subtitle language")
            .setView(input)
            .setPositiveButton("Search") { _, _ ->
                val l = LanguageCodes.twoLetter(input.text.toString()).ifBlank { "en" }
                search(activity, choices, kind, id, l, isTv)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun download(activity: AppCompatActivity, choices: PlaybackChoicesController, kind: String, id: String, pick: OnlineSubtitle) {
        val progress = AlertDialog.Builder(activity).setTitle("Downloading…").setMessage(pick.release.ifBlank { pick.fileName }).show()
        activity.lifecycleScope.launch {
            val r = runCatching {
                choices.api.downloadOnline(OnlineDownloadRequest(kind, id, pick.fileId, pick.language, pick.hearingImpaired, pick.forced))
            }
            progress.dismiss()
            val body = r.getOrNull()
            if (body == null || !body.ok) {
                message(activity, "Download failed", body?.message ?: r.exceptionOrNull()?.message ?: "Couldn't download the subtitles.")
                return@launch
            }
            android.widget.Toast.makeText(activity, OnlineSubtitleText.savedMessage(body.remaining), android.widget.Toast.LENGTH_LONG).show()
            if (body.key.isNotBlank()) choices.onSubtitleDownloaded(body.key)
        }
    }

    private fun message(activity: AppCompatActivity, title: String, text: String) {
        AlertDialog.Builder(activity).setTitle(title).setMessage(text).setPositiveButton("OK", null).show()
    }
}
