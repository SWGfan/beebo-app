package com.beeboentertainment.movie.spacesaver

import android.content.SharedPreferences
import com.beeboentertainment.movie.data.ApiClient
import kotlinx.serialization.builtins.ListSerializer

/**
 * Persistent state for Space Saver, kept in the plain (non-secret) SharedPreferences next to
 * resume positions and the download index:
 *   - the list of picked folders (tree Uri + display name), so they survive app restarts;
 *   - the "backed up" set, keyed by relPath+size, so progress survives restarts and re-scans.
 *
 * Nothing here is a credential, so the plain store is correct. All reads are defensive: a
 * corrupt or absent value decodes to empty rather than throwing.
 */
class SpaceSaverStore(private val prefs: SharedPreferences) {

    companion object {
        private const val K_FOLDERS = "space_saver_folders_v1"
        private const val K_FILES = "space_saver_files_v1"
        private const val K_BACKED_UP = "space_saver_backed_up_v1"
        private const val K_WIFI_ONLY = "space_saver_wifi_only_v1"
        private val FOLDERS = ListSerializer(PickedFolder.serializer())
        private val FILES = ListSerializer(PickedFile.serializer())
    }

    /* ------------------------------ wifi-only ------------------------------ */

    /**
     * Whether backups may only run on unmetered Wi-Fi. Default true (Wi-Fi only): on a fresh
     * install the safe choice is not to spend the user's mobile data plan. Read live by the
     * service on every network check, so flipping it takes effect for the current run too.
     */
    fun wifiOnly(): Boolean = prefs.getBoolean(K_WIFI_ONLY, true)

    fun setWifiOnly(value: Boolean) {
        prefs.edit().putBoolean(K_WIFI_ONLY, value).apply()
    }

    /* ------------------------------- folders ------------------------------- */

    fun folders(): List<PickedFolder> = runCatching {
        ApiClient.JSON.decodeFromString(FOLDERS, prefs.getString(K_FOLDERS, "[]") ?: "[]")
    }.getOrDefault(emptyList())

    private fun saveFolders(list: List<PickedFolder>) {
        prefs.edit().putString(K_FOLDERS, ApiClient.JSON.encodeToString(FOLDERS, list)).apply()
    }

    /** Add (or refresh) a folder, de-duplicating on its tree Uri. */
    fun addFolder(folder: PickedFolder) {
        saveFolders(folders().filter { it.uri != folder.uri } + folder)
    }

    fun removeFolder(uri: String) {
        saveFolders(folders().filter { it.uri != uri })
    }

    /* -------------------------------- files -------------------------------- */

    fun files(): List<PickedFile> = runCatching {
        ApiClient.JSON.decodeFromString(FILES, prefs.getString(K_FILES, "[]") ?: "[]")
    }.getOrDefault(emptyList())

    private fun saveFiles(list: List<PickedFile>) {
        prefs.edit().putString(K_FILES, ApiClient.JSON.encodeToString(FILES, list)).apply()
    }

    /** Add (or refresh) a single picked file, de-duplicating on its document Uri. */
    fun addFile(file: PickedFile) {
        saveFiles(files().filter { it.uri != file.uri } + file)
    }

    fun removeFile(uri: String) {
        saveFiles(files().filter { it.uri != uri })
    }

    /* ----------------------------- backed-up set ---------------------------- */

    /**
     * A defensive copy of the backed-up key set. The set returned by getStringSet must never be
     * mutated in place (Android's own docs), so callers get a fresh mutable copy.
     */
    fun backedUpKeys(): MutableSet<String> =
        (prefs.getStringSet(K_BACKED_UP, emptySet()) ?: emptySet()).toMutableSet()

    fun isBackedUp(relPath: String, size: Long): Boolean =
        backedUpKeys().contains(backupKey(relPath, size))

    fun markBackedUp(relPath: String, size: Long) {
        val s = backedUpKeys()
        if (s.add(backupKey(relPath, size))) {
            prefs.edit().putStringSet(K_BACKED_UP, s).apply()
        }
    }

    /** Remove a mark. Called when a file is deleted locally so re-scans re-evaluate it cleanly. */
    fun unmarkBackedUp(relPath: String, size: Long) {
        val s = backedUpKeys()
        if (s.remove(backupKey(relPath, size))) {
            prefs.edit().putStringSet(K_BACKED_UP, s).apply()
        }
    }

    /**
     * Replace the entire backed-up set with [keys]. Used to reconcile the local cache against the
     * server (the source of truth) after a /check: the caller passes exactly the keys the server
     * confirms it holds, so anything the server no longer has drops out of the cache in one write.
     * A defensive copy is stored so the caller's set can't later mutate what's persisted.
     */
    fun setBackedUp(keys: Set<String>) {
        prefs.edit().putStringSet(K_BACKED_UP, HashSet(keys)).apply()
    }
}
