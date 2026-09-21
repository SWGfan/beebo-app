package com.beeboentertainment.movie.account

import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.CatalogCache
import com.beeboentertainment.movie.data.ContinueCache
import com.beeboentertainment.movie.data.ShelfCache
import com.beeboentertainment.movie.rtc.RemoteAccess
import com.beeboentertainment.movie.rtc.RemoteSignIn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** The network half of [AccountDeletion]: sends the request, then signs this phone out of that account. */
object AccountDeleter {

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    /** beebo.tv and the hub: plain HTTPS, never through the home tunnel. */
    private val direct: OkHttpClient by lazy {
        com.beeboentertainment.movie.core.CleartextPolicy.install(OkHttpClient.Builder())
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    fun accountsOnThisPhone(): List<AccountDeletion.Account> {
        val s = BeeboApp.instance.session
        return AccountDeletion.accountsOn(
            homeToken = s.token,
            homeUserName = s.userName,
            isAdmin = s.isAdmin,
            remote = RemoteSignIn.fromJson(s.remoteSignIn),
            hubToken = s.hubToken,
        )
    }

    suspend fun delete(account: AccountDeletion.Account, password: String): AccountDeletion.Outcome = withContext(Dispatchers.IO) {
        val s = BeeboApp.instance.session
        val request = when (account.kind) {
            AccountDeletion.Kind.HOME_MEMBER -> {
                val url = UrlUtils.endpoint(s.baseUrl, AccountDeletion.HOME_DELETE_PATH)
                val token = s.token
                if (url == null || token.isNullOrBlank()) return@withContext AccountDeletion.Outcome.NotDeleted("You're signed out of this account. Sign in again, then delete it.")
                Request.Builder().url(url).header("Authorization", "Bearer $token")
                    .post(AccountDeletion.homeBody(password).toRequestBody(jsonType)).build()
            }
            AccountDeletion.Kind.BEEBO_ACCOUNT -> {
                val email = account.who ?: RemoteSignIn.fromJson(s.remoteSignIn)?.id.orEmpty()
                Request.Builder().url(AccountDeletion.BEEBO_ACCOUNT_DELETE_URL)
                    .post(AccountDeletion.beeboAccountBody(email, password).toRequestBody(jsonType)).build()
            }
            AccountDeletion.Kind.HUB -> {
                val token = s.hubToken
                if (token.isNullOrBlank()) return@withContext AccountDeletion.Outcome.NotDeleted("You're signed out of this account. Sign in again, then delete it.")
                Request.Builder().url(AccountDeletion.HUB_ACCOUNT_DELETE_URL).header("Authorization", "Bearer $token")
                    .delete(AccountDeletion.hubBody(password).toRequestBody(jsonType)).build()
            }
        }
        val client = if (account.kind == AccountDeletion.Kind.HOME_MEMBER) BeeboApp.instance.api.okHttp else direct
        val outcome = try {
            client.newCall(request.newBuilder().header("Accept", "application/json").build()).execute().use { r ->
                AccountDeletion.outcome(account.kind, r.code, errorIn(r.body?.string()))
            }
        } catch (e: IOException) {
            AccountDeletion.Outcome.NotDeleted(AccountDeletion.OFFLINE)
        }
        if (outcome is AccountDeletion.Outcome.Deleted) signOutOf(account.kind)
        outcome
    }

    private fun errorIn(body: String?): String? = runCatching {
        ((Json.parseToJsonElement(body ?: return null) as? JsonObject)?.get("error") as? JsonPrimitive)?.content
    }.getOrNull()

    /** The account is gone: forget everything this phone kept for it. */
    private fun signOutOf(kind: AccountDeletion.Kind) {
        val app = BeeboApp.instance
        val s = app.session
        when (kind) {
            // Away from home the saved sign-in is this same person (or the deleted owner): forget it too.
            AccountDeletion.Kind.HOME_MEMBER, AccountDeletion.Kind.BEEBO_ACCOUNT -> {
                RemoteAccess.signOut()
                s.logout()
                CatalogCache.clear()
                ContinueCache.clear(s.plain)
                ShelfCache.clear()
            }
            AccountDeletion.Kind.HUB -> s.logoutHub()
        }
    }
}
