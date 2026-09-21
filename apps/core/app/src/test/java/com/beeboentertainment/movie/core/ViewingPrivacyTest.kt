package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.AdultProfileResponse
import com.beeboentertainment.movie.data.AdminParentalResponse
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.ViewingPrivacyResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewingPrivacyTest {
    @Test fun `only an acknowledged matching preference is shown as saved`() {
        val enabled = ViewingPrivacyResponse(ok = true, adult = true, eligible = true, hasPassword = true, enabled = true, token = "rotated-token")
        assertTrue(ViewingPrivacyPresentation.saved(200, enabled, true))
        assertFalse(ViewingPrivacyPresentation.saved(403, enabled, true))
        assertFalse(ViewingPrivacyPresentation.saved(200, enabled.copy(ok = false), true))
        assertFalse(ViewingPrivacyPresentation.saved(200, enabled.copy(enabled = false), true))
        assertFalse(ViewingPrivacyPresentation.saved(404, ViewingPrivacyResponse(), false))
        assertTrue(ViewingPrivacyPresentation.saved(200, enabled.copy(enabled = false, token = null), false))
    }

    @Test fun `old server cannot silently enable privacy or label existing profiles adult`() {
        val old = ApiClient.JSON.decodeFromString(ViewingPrivacyResponse.serializer(), """{"ok":false,"error":"not_found"}""")
        assertFalse(old.eligible)
        assertFalse(old.enabled)
        assertFalse(old.adult)
        assertFalse(old.hasPassword)
        assertTrue(ViewingPrivacyPresentation.error(404, old).contains("Update the Beebo desktop"))
        val family = ApiClient.JSON.decodeFromString(AdminParentalResponse.serializer(), """{"ok":true,"users":[{"id":"child","name":"Child","policy":{"enabled":true}}]}""")
        assertFalse(family.users.single().adult)
        assertFalse(family.users.single().viewingHistoryPrivate)
    }

    @Test fun `new server preserves private profile markers and rotated session`() {
        val status = ApiClient.JSON.decodeFromString(ViewingPrivacyResponse.serializer(), """{"ok":true,"adult":true,"enabled":true,"eligible":true,"hasPassword":true,"token":"fresh-token","user":{"id":"adult","name":"Alex","adult":true,"viewingHistoryPrivate":true},"future":true}""")
        assertEquals("fresh-token", status.token)
        assertEquals("adult", status.user?.id)
        assertTrue(status.user!!.viewingHistoryPrivate)
        assertTrue(status.enabled)
        val family = ApiClient.JSON.decodeFromString(AdminParentalResponse.serializer(), """{"ok":true,"users":[{"id":"adult","adult":true,"viewingHistoryPrivate":true}]}""")
        assertTrue(family.users.single().adult)
        assertTrue(family.users.single().viewingHistoryPrivate)
        val refusal = ApiClient.JSON.decodeFromString(AdultProfileResponse.serializer(), """{"ok":false,"error":"privacy_enabled","message":"This person controls their privacy."}""")
        assertFalse(refusal.ok)
        assertEquals("privacy_enabled", refusal.error)
    }

    @Test fun `password and private profile refusals tell the user what to do`() {
        assertTrue(ViewingPrivacyPresentation.error(401, ViewingPrivacyResponse(error = "wrong_password")).contains("password is not right"))
        assertTrue(ViewingPrivacyPresentation.error(429, ViewingPrivacyResponse()).contains("Too many attempts"))
        val blocked = AdminErrors.message("private_profile_sign_in")
        assertTrue(blocked.contains("Sign out"))
        assertTrue(blocked.contains("sign in directly"))
        assertFalse(AdminErrors.isSessionProblem("private_profile_sign_in"))
        assertTrue(ViewingPrivacyPresentation.error(403, ViewingPrivacyResponse(message = "Adult status is required.")).contains("Adult status"))
    }
}
