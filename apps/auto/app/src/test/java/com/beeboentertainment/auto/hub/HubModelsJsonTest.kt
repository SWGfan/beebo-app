package com.beeboentertainment.auto.hub

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decoding tests for the hub `/api/v1/…` wire models and the status->message
 * mapping HubClient shows the user.
 *
 * The Json instance is configured exactly as HubClient configures its own — if
 * these drift, the tests stop proving anything about production.
 */
class HubModelsJsonTest {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    // ------------------------------------------------------------------- auth

    @Test
    fun authResponseDecodesWithAccount() {
        val payload = """
            {
              "token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2N0LTEifQ.9d2c",
              "account": { "id": "acct-1", "email": "sam@example.com", "tier": "free" }
            }
        """.trimIndent()

        val r = json.decodeFromString<HubAuthResponse>(payload)

        assertEquals("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2N0LTEifQ.9d2c", r.token)
        assertEquals("acct-1", r.account!!.id)
        assertEquals("sam@example.com", r.account!!.email)
        assertEquals("free", r.account!!.tier)
    }

    /** The hub can add fields (ignoreUnknownKeys) and omit optional ones. */
    @Test
    fun authResponseIgnoresUnknownAndToleratesMissingAccount() {
        val r = json.decodeFromString<HubAuthResponse>(
            """{"token":"t","issuedAt":1690000000000,"account":{"id":"a","email":"e","tier":"pro","extra":true}}"""
        )
        assertEquals("t", r.token)
        assertEquals("pro", r.account!!.tier)

        val bare = json.decodeFromString<HubAuthResponse>("""{"token":"t2"}""")
        assertEquals("t2", bare.token)
        assertNull(bare.account)
    }

    // --------------------------------------------------------------------- pc

    @Test
    fun pcResponseOnlineDirectDecodes() {
        val payload = """
            {
              "online": true,
              "lastSeen": 1690000000000,
              "baseUrl": "https://home-pc.example.com:47811",
              "connectVia": "direct",
              "subscription": { "active": true, "tier": "free" }
            }
        """.trimIndent()

        val r = json.decodeFromString<HubPcResponse>(payload)

        assertTrue(r.online)
        assertEquals(1690000000000L, r.lastSeen)
        assertEquals("https://home-pc.example.com:47811", r.baseUrl)
        assertEquals("direct", r.connectVia)
        assertTrue(r.subscription.active)
        assertEquals("free", r.subscription.tier)
    }

    @Test
    fun pcResponseOfflineDecodesWithNullBaseUrl() {
        val payload = """
            {
              "online": false,
              "lastSeen": 1689999999999,
              "baseUrl": null,
              "connectVia": "direct",
              "subscription": { "active": true, "tier": "free" }
            }
        """.trimIndent()

        val r = json.decodeFromString<HubPcResponse>(payload)

        assertFalse(r.online)
        assertNull(r.baseUrl)
        assertEquals(1689999999999L, r.lastSeen)
    }

    /** A Stage-2 PC advertises the relay; parsing must not choke on it. */
    @Test
    fun pcResponseSignalDecodes() {
        val r = json.decodeFromString<HubPcResponse>(
            """{"online":true,"lastSeen":1,"baseUrl":null,"connectVia":"signal","subscription":{"active":true,"tier":"pro"}}"""
        )
        assertEquals("signal", r.connectVia)
        assertTrue(r.online)
        assertNull(r.baseUrl)
    }

    @Test
    fun errorResponseDecodes() {
        val r = json.decodeFromString<HubErrorResponse>("""{"error":"email_taken"}""")
        assertEquals("email_taken", r.error)
    }

    // ------------------------------------------------------- exception mapping

    @Test
    fun messageForGivesCuratedTextOnKnownStatuses() {
        assertTrue(HubClient.messageFor(401, null).contains("Sign in again"))
        assertTrue(HubClient.messageFor(404, null).contains("No home PC"))
        assertTrue(HubClient.messageFor(409, null).contains("already registered"))
        // 402 prefers the server's own message when it sent one.
        assertEquals("Renew to keep streaming.", HubClient.messageFor(402, "Renew to keep streaming."))
        assertTrue(HubClient.messageFor(402, null).contains("subscription"))
        // Unknown status falls back to the server message, then to a generic line.
        assertEquals("boom", HubClient.messageFor(500, "boom"))
        assertTrue(HubClient.messageFor(500, null).contains("HTTP 500"))
    }

    @Test
    fun hubExceptionCarriesCodeAndMessage() {
        val e = HubException(409, "That email is already registered. Sign in instead.")
        assertEquals(409, e.code)
        assertEquals("That email is already registered. Sign in instead.", e.message)
    }
}
