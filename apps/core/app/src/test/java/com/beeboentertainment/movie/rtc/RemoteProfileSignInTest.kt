package com.beeboentertainment.movie.rtc

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.LoginRequest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteProfileSignInTest {
    private val member = RemoteSignIn(RemoteSignIn.Kind.MEMBER, "sample", " Alex ", "private-\"password")
    private val accepted = """{"ok":true,"token":"profile-session","user":{"id":"alex-id","name":"Alex","adult":true,"viewingHistoryPrivate":true}}"""
    private val needsPassword = """{"ok":false,"error":"private_profile_sign_in"}"""

    private fun response(request: Request, code: Int, body: String): Response = Response.Builder()
        .request(request).code(code).message("test").protocol(Protocol.HTTP_1_1)
        .body(body.toResponseBody("application/json".toMediaType())).build()

    @Test fun `private member authenticates own password on home server through supplied tunnel`() {
        val requests = mutableListOf<Request>()
        val result = RemoteProfileSignIn.authenticate("sample", member) { request ->
            requests += request
            if (requests.size == 1) response(request, 403, needsPassword) else response(request, 200, accepted)
        }
        assertTrue(result is RemoteProfileSignIn.Result.SignedIn)
        assertEquals(listOf("/api/remote-session", "/api/login"), requests.map { it.url.encodedPath })
        assertTrue(requests.all { it.url.scheme == "https" && it.url.host == "sample.beebo.tv" && it.method == "POST" })
        val payload = Buffer().also { requests[1].body!!.writeTo(it) }.readUtf8()
        val credentials = ApiClient.JSON.decodeFromString(LoginRequest.serializer(), payload)
        assertEquals("Alex", credentials.username)
        assertEquals(member.secret, credentials.password)
        assertEquals("profile-session", (result as RemoteProfileSignIn.Result.SignedIn).login.token)
        assertTrue(result.login.user!!.viewingHistoryPrivate)
    }

    @Test fun `regular automatic session still needs only one request`() {
        var calls = 0
        val result = RemoteProfileSignIn.authenticate("sample", member) { request ->
            calls++
            response(request, 200, accepted)
        }
        assertEquals(1, calls)
        assertTrue(result is RemoteProfileSignIn.Result.SignedIn)
    }

    @Test fun `owner guest and household credentials are never forwarded as private profile passwords`() {
        listOf(RemoteSignIn.Kind.OWNER, RemoteSignIn.Kind.GUEST, RemoteSignIn.Kind.HOUSEHOLD).forEach { kind ->
            var calls = 0
            val result = RemoteProfileSignIn.authenticate("sample", member.copy(kind = kind)) { request ->
                calls++
                response(request, 403, needsPassword)
            }
            assertEquals(1, calls)
            assertTrue(result is RemoteProfileSignIn.Result.Refused)
            assertTrue((result as RemoteProfileSignIn.Result.Refused).message.contains("own Beebo profile username and password"))
            assertFalse(result.message.contains("needs an update"))
        }
    }

    @Test fun `only explicit private profile refusal permits password fallback`() {
        listOf(404 to needsPassword, 500 to needsPassword, 403 to """{"ok":false,"error":"no_remote_access"}""").forEach { (code, body) ->
            var calls = 0
            val result = RemoteProfileSignIn.authenticate("sample", member) { request -> calls++; response(request, code, body) }
            assertEquals(1, calls)
            assertTrue(result is RemoteProfileSignIn.Result.Refused)
        }
    }

    @Test fun `incorrect password and lockouts cannot grant a local session`() {
        listOf(
            401 to """{"ok":false,"error":"bad_credentials"}""",
            401 to """{"ok":false,"locked":true,"minutesRemaining":15}""",
            429 to """{"ok":false,"error":"locked"}""",
        ).forEach { (code, body) ->
            var calls = 0
            val result = RemoteProfileSignIn.authenticate("sample", member) { request ->
                calls++
                if (calls == 1) response(request, 403, needsPassword) else response(request, code, body)
            }
            assertEquals(2, calls)
            assertTrue(result is RemoteProfileSignIn.Result.Refused)
            val message = (result as RemoteProfileSignIn.Result.Refused).message
            assertTrue(message.contains("password") || message.contains("attempts"))
        }
    }

    @Test fun `login redirects are not followed and malformed successes are refused`() {
        listOf(307 to "", 200 to "not JSON", 200 to """{"ok":true,"token":"missing-user"}""").forEach { (code, body) ->
            var calls = 0
            val result = RemoteProfileSignIn.authenticate("sample", member) { request ->
                calls++
                if (calls == 1) response(request, 403, needsPassword)
                else response(request, code, body).newBuilder().header("Location", "https://another.example/login").build()
            }
            assertEquals(2, calls)
            assertTrue(result is RemoteProfileSignIn.Result.Refused)
        }
    }
}
