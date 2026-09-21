package com.beeboentertainment.movie.photos

import android.content.Context
import android.content.SharedPreferences
import com.beeboentertainment.movie.data.ApiClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import java.io.File

/**
 * Photo backup's saved state. Settings and the status line live in SharedPreferences (small, read
 * by the screen); the per-file records live in a JSON file because a camera roll can hold tens of
 * thousands of entries:
 *  - done:     MediaCandidate.key -> SHA-256 of what the PC confirmed it holds;
 *  - hashes:   MediaCandidate.key -> SHA-256 already computed (so a big video is hashed once);
 *  - attempts: MediaCandidate.key -> failed attempts, to stop retrying a broken file forever.
 * None of it is a secret. Every read is defensive: a corrupt value reads as empty.
 */
class PhotoBackupStore private constructor(private val prefs: SharedPreferences, private val recordsFile: File) {

    @Serializable
    data class Records(
        val done: Map<String, String> = emptyMap(),
        val hashes: Map<String, String> = emptyMap(),
        val attempts: Map<String, Int> = emptyMap(),
    )

    private val _settings = MutableStateFlow(readSettings())
    val settings: StateFlow<BackupSettings> = _settings.asStateFlow()
    private val _state = MutableStateFlow(readState())
    val state: StateFlow<BackupState> = _state.asStateFlow()

    private fun readSettings(): BackupSettings = runCatching {
        ApiClient.JSON.decodeFromString(BackupSettings.serializer(), prefs.getString(K_SETTINGS, null) ?: "{}")
    }.getOrDefault(BackupSettings())

    private fun readState(): BackupState = runCatching {
        ApiClient.JSON.decodeFromString(BackupState.serializer(), prefs.getString(K_STATE, null) ?: "{}")
    }.getOrDefault(BackupState())

    @Synchronized
    fun updateSettings(change: (BackupSettings) -> BackupSettings): BackupSettings {
        val next = change(_settings.value)
        prefs.edit().putString(K_SETTINGS, ApiClient.JSON.encodeToString(BackupSettings.serializer(), next)).apply()
        _settings.value = next
        return next
    }

    @Synchronized
    fun updateState(change: (BackupState) -> BackupState): BackupState {
        val next = change(_state.value)
        prefs.edit().putString(K_STATE, ApiClient.JSON.encodeToString(BackupState.serializer(), next)).apply()
        _state.value = next
        return next
    }

    /** Re-read after another process (the WorkManager process is the same one, but be safe). */
    fun refresh() {
        _settings.value = readSettings()
        _state.value = readState()
    }

    private var records: Records? = null

    @Synchronized
    fun records(): Records {
        records?.let { return it }
        val r = runCatching {
            if (recordsFile.isFile) ApiClient.JSON.decodeFromString(Records.serializer(), recordsFile.readText()) else Records()
        }.getOrDefault(Records())
        records = r
        return r
    }

    private var unsaved = 0

    /** Change the records in memory; they reach disk every few changes and on [flush]. */
    @Synchronized
    fun editRecords(change: (Records) -> Records) {
        records = change(records())
        if (++unsaved >= 20) flush()
    }

    @Synchronized
    fun flush() {
        val r = records ?: return
        if (unsaved == 0) return
        unsaved = 0
        runCatching {
            val tmp = File(recordsFile.parentFile, recordsFile.name + ".tmp")
            tmp.writeText(ApiClient.JSON.encodeToString(Records.serializer(), r))
            if (!tmp.renameTo(recordsFile)) { recordsFile.delete(); tmp.renameTo(recordsFile) }
        }
    }

    fun markDone(key: String, sha256: String) = editRecords {
        it.copy(done = it.done + (key to sha256), attempts = it.attempts - key)
    }

    fun rememberHash(key: String, sha256: String) = editRecords { it.copy(hashes = it.hashes + (key to sha256)) }

    fun countFailure(key: String) = editRecords { it.copy(attempts = it.attempts + (key to ((it.attempts[key] ?: 0) + 1))) }

    /** Drop records for files no longer on the phone, so the file does not grow forever. */
    fun forgetMissing(presentKeys: Set<String>) = editRecords { r ->
        Records(
            done = r.done.filterKeys { it in presentKeys },
            hashes = r.hashes.filterKeys { it in presentKeys },
            attempts = r.attempts.filterKeys { it in presentKeys },
        )
    }

    /** "Try failed files again": clears attempt counters only. Never touches the done list. */
    fun clearFailures() = editRecords { it.copy(attempts = emptyMap()) }

    companion object {
        private const val PREFS = "photo_backup"
        private const val K_SETTINGS = "settings_v1"
        private const val K_STATE = "state_v1"

        @Volatile private var instance: PhotoBackupStore? = null

        fun get(context: Context): PhotoBackupStore = instance ?: synchronized(this) {
            instance ?: PhotoBackupStore(
                context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE),
                File(context.applicationContext.filesDir, "photo-backup-records.json"),
            ).also { instance = it }
        }
    }
}
