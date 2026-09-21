package com.beeboentertainment.movie.sharing

import com.beeboentertainment.movie.core.SharedLibraries
import com.beeboentertainment.movie.core.SharedLibrary
import com.beeboentertainment.movie.data.SessionStore
import com.beeboentertainment.movie.data.User
import com.beeboentertainment.movie.rtc.RemoteAccess
import com.beeboentertainment.movie.rtc.RemoteSignIn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Libraries shared with this person by other households, and moving between them and "My home".
 *
 * beebo.tv half (worker/shares.js): accept an invite code, list this account's shares, leave one,
 * report a problem. Everything is signed in with the person's OWN Beebo account (or the free guest
 * sign-in made at accept time) - never the other household's passwords.
 *
 * Opening a shared library is an ordinary away-from-home sign-in to that house (RemoteSignIn.Kind
 * .GUEST), so streams go over the same encrypted connection and the other house's computer applies
 * the share's limits. "My home" is kept (encrypted) while a shared library is open and restored
 * when the person comes back.
 */
object SharedLibrarySwitcher {

    const val SHARES_BASE = "https://login.beebo.tv/shares"

    private val json = Json { ignoreUnknownKeys = true }
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val http: OkHttpClient by lazy {
        com.beeboentertainment.movie.core.CleartextPolicy.install(OkHttpClient.Builder())
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }

    class ShareException(val code: String, message: String) : IOException(message)

    @Serializable
    private data class HomeSnapshot(
        val baseUrl: String? = null,
        val directBaseUrl: String? = null,
        val remoteSignIn: String? = null,
        val token: String? = null,
        val userId: String? = null,
        val userName: String? = null,
        val isAdmin: Boolean = false,
        val restricted: Boolean = false,
    )

    private fun post(path: String, body: JSONObject): JSONObject {
        val req = Request.Builder().url("$SHARES_BASE/$path").post(body.toString().toRequestBody(jsonType))
            .header("Accept", "application/json").build()
        http.newCall(req).execute().use { r ->
            val obj = runCatching { JSONObject(r.body?.string().orEmpty()) }.getOrDefault(JSONObject())
            if (r.isSuccessful && obj.optBoolean("ok")) return obj
            val code = obj.optString("error").ifBlank { "http_${r.code}" }
            throw ShareException(code, messageFor(code, obj.optString("message")))
        }
    }

    fun messageFor(code: String, serverMessage: String = ""): String = when (code) {
        "invalid_invite" -> "That code and sign-in don't match an invite. Check the code, and use the email address the invite was sent to."
        "account_needed" -> "There's no Beebo account for that email yet. Tick \"Make a free guest sign-in\" to make one."
        "too_short" -> "Use a password of at least 8 characters."
        "invalid_credentials" -> "Wrong email or password."
        "too_many_attempts" -> "Too many tries. Wait a little and try again."
        "password_reset_required" -> "Please set a new password for your Beebo account first."
        else -> serverMessage.ifBlank { "Beebo couldn't do that just now ($code)." }
    }

    fun libraries(session: SessionStore): List<SharedLibrary> = SharedLibraries.decode(session.sharedLibrariesJson)

    private fun guestSignIns(session: SessionStore): Map<String, String> =
        runCatching { json.decodeFromString(MapSerializer(String.serializer(), String.serializer()), session.guestSignInsJson ?: "{}") }.getOrDefault(emptyMap())

    private fun rememberGuest(session: SessionStore, name: String, signIn: RemoteSignIn?) {
        val m = guestSignIns(session).toMutableMap()
        if (signIn == null) m.remove(name) else m[name] = signIn.toJson()
        session.guestSignInsJson = json.encodeToString(MapSerializer(String.serializer(), String.serializer()), m)
    }

    fun savedGuestSignIn(session: SessionStore, name: String): RemoteSignIn? = RemoteSignIn.fromJson(guestSignIns(session)[name])

    /** Accept an invite. Adds the library to this phone's list and keeps the sign-in (encrypted). */
    suspend fun accept(session: SessionStore, code: String, email: String, password: String, createGuest: Boolean): SharedLibrary =
        withContext(Dispatchers.IO) {
            val out = post("accept", JSONObject().put("code", code).put("email", email.trim()).put("password", password).put("createGuest", createGuest))
            val lib = SharedLibrary(out.optString("name"), out.optString("ownerLabel"), email.trim().lowercase(), out.optString("shareId"))
            session.sharedLibrariesJson = SharedLibraries.encode(SharedLibraries.upsert(libraries(session), lib))
            rememberGuest(session, lib.name, RemoteSignIn(RemoteSignIn.Kind.GUEST, lib.name, lib.email, password))
            lib
        }

    /** The shares beebo.tv lists for this account (e.g. on a new phone). */
    suspend fun refresh(session: SessionStore, email: String, password: String): List<SharedLibrary> = withContext(Dispatchers.IO) {
        val out = post("mine", JSONObject().put("email", email.trim()).put("password", password))
        val arr = out.optJSONArray("shares")
        val list = (0 until (arr?.length() ?: 0)).map { i ->
            val o = arr!!.getJSONObject(i)
            SharedLibrary(o.optString("name"), o.optString("ownerLabel"), email.trim().lowercase(), o.optString("shareId"))
        }.filter { it.name.isNotBlank() }
        list.forEach { rememberGuest(session, it.name, RemoteSignIn(RemoteSignIn.Kind.GUEST, it.name, it.email, password)) }
        val merged = SharedLibraries.replaceFromAccount(libraries(session), list, email)
        session.sharedLibrariesJson = SharedLibraries.encode(merged)
        merged
    }

    suspend fun leave(session: SessionStore, lib: SharedLibrary, password: String) = withContext(Dispatchers.IO) {
        post("leave", JSONObject().put("email", lib.email).put("password", password).put("shareId", lib.shareId))
        forget(session, lib.name)
    }

    fun forget(session: SessionStore, name: String) {
        session.sharedLibrariesJson = SharedLibraries.encode(SharedLibraries.remove(libraries(session), name))
        rememberGuest(session, name, null)
    }

    suspend fun report(reason: String, details: String, name: String?, email: String?) = withContext(Dispatchers.IO) {
        val body = JSONObject().put("reason", reason).put("details", details.take(2000))
        if (!name.isNullOrBlank()) body.put("name", name)
        if (!email.isNullOrBlank()) body.put("email", email)
        post("report", body)
    }

    /** Is a shared library open right now (rather than this person's own home)? */
    fun inSharedLibrary(session: SessionStore): Boolean = session.isGuest

    /**
     * Open a shared library: keep "My home" (only when leaving it, not when hopping between
     * shared libraries), then sign in to that house as a guest.
     */
    suspend fun open(session: SessionStore, lib: SharedLibrary, password: String?): RemoteAccess.SignInResult {
        val signIn = if (!password.isNullOrEmpty()) RemoteSignIn(RemoteSignIn.Kind.GUEST, lib.name, lib.email, password)
        else savedGuestSignIn(session, lib.name) ?: return RemoteAccess.SignInResult.Refused("Enter your password for ${lib.email}.")
        if (!session.isGuest && session.isLoggedIn) {
            session.homeSnapshotJson = json.encodeToString(HomeSnapshot.serializer(), HomeSnapshot(
                baseUrl = session.baseUrl, directBaseUrl = session.directBaseUrl, remoteSignIn = session.remoteSignIn,
                token = session.token, userId = session.userId, userName = session.userName,
                isAdmin = session.isAdmin, restricted = session.isRestricted,
            ))
        }
        // The other house is only ever reached through beebo.tv: never this person's own
        // computer's home address (the snapshot above keeps that for the way back).
        session.directBaseUrl = null
        session.baseUrl = "https://${lib.name}.beebo.tv"
        val result = RemoteAccess.signIn(signIn)
        if (result is RemoteAccess.SignInResult.SignedIn) {
            rememberGuest(session, lib.name, signIn)
            session.isGuest = true
        }
        return result
    }

    /** Back to "My home". Returns false when there is nothing saved to go back to (sign in again). */
    suspend fun backToMyHome(session: SessionStore): Boolean {
        val snap = runCatching { json.decodeFromString(HomeSnapshot.serializer(), session.homeSnapshotJson ?: "") }.getOrNull()
        if (snap == null || snap.baseUrl.isNullOrBlank()) {
            RemoteAccess.signOut()
            session.logout()
            return false
        }
        val saved = RemoteSignIn.fromJson(snap.remoteSignIn)
        if (saved != null && com.beeboentertainment.movie.core.UrlUtils.beeboTvName(snap.baseUrl) != null) {
            val r = RemoteAccess.signIn(saved)
            if (r is RemoteAccess.SignInResult.Refused) return false
        } else {
            RemoteAccess.signOut()
            session.baseUrl = snap.baseUrl
            snap.directBaseUrl?.let { session.directBaseUrl = it }
            snap.remoteSignIn?.let { session.remoteSignIn = it }
            RemoteAccess.onBaseUrlChanged(snap.baseUrl)
            if (!snap.token.isNullOrBlank()) {
                session.saveLogin(snap.token, User(snap.userId.orEmpty(), snap.userName.orEmpty(), snap.isAdmin, snap.restricted))
            }
        }
        session.isGuest = false
        session.homeSnapshotJson = null
        return true
    }
}
