package com.beeboentertainment.movie.account

import com.beeboentertainment.movie.account.AccountDeletion.Kind
import com.beeboentertainment.movie.account.AccountDeletion.Outcome
import com.beeboentertainment.movie.rtc.RemoteSignIn
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountDeletionTest {

    private val member = RemoteSignIn(RemoteSignIn.Kind.MEMBER, "thesmiths", "robin", "pw")
    private val owner = RemoteSignIn(RemoteSignIn.Kind.OWNER, "thesmiths", "Owner@Example.com", "pw")
    private val household = RemoteSignIn(RemoteSignIn.Kind.HOUSEHOLD, "thesmiths", "", "pass")

    @Test
    fun `nothing signed in lists nothing`() {
        assertEquals(emptyList<AccountDeletion.Account>(), AccountDeletion.accountsOn(null, null, false, null, null))
        assertEquals(emptyList<AccountDeletion.Account>(), AccountDeletion.accountsOn("", "x", false, household, " "))
    }

    @Test
    fun `a household member sees only their home account`() {
        val list = AccountDeletion.accountsOn("tok", "Robin", false, member, null)
        assertEquals(listOf(Kind.HOME_MEMBER), list.map { it.kind })
        assertEquals("Robin", list[0].who)
        val text = list[0].explanation
        assertTrue(text.contains("does NOT delete the owner's movies and shows"))
        assertTrue(text.contains("watch history"))
        assertFalse(text.contains("only admin"))
    }

    @Test
    fun `the owner sees the home account, the Beebo account and the hub account`() {
        val list = AccountDeletion.accountsOn("tok", "Owner", true, owner, "hubjwt")
        assertEquals(listOf(Kind.HOME_MEMBER, Kind.BEEBO_ACCOUNT, Kind.HUB), list.map { it.kind })
        assertEquals("Owner@Example.com", list[1].who)
        assertTrue(list[0].explanation.contains("only admin"))
        assertTrue(list[1].explanation.contains("subscription"))
        assertTrue(list[2].explanation.contains("hub account"))
    }

    @Test
    fun `request bodies carry the password, and the Beebo account's email normalised`() {
        val home = Json.parseToJsonElement(AccountDeletion.homeBody("p\"w")).jsonObject
        assertEquals("p\"w", home["password"]!!.jsonPrimitive.content)
        val beebo = Json.parseToJsonElement(AccountDeletion.beeboAccountBody(" Owner@Example.com ", "secret")).jsonObject
        assertEquals("owner@example.com", beebo["email"]!!.jsonPrimitive.content)
        assertEquals("secret", beebo["password"]!!.jsonPrimitive.content)
        assertEquals("pw", Json.parseToJsonElement(AccountDeletion.hubBody("pw")).jsonObject["password"]!!.jsonPrimitive.content)
    }

    @Test
    fun `endpoints are Beebo's own hosts, never a personal workers dev address`() {
        assertEquals("https://login.beebo.tv/account/delete", AccountDeletion.BEEBO_ACCOUNT_DELETE_URL)
        assertEquals("https://hub.beebotv.com/api/v1/account", AccountDeletion.HUB_ACCOUNT_DELETE_URL)
        assertEquals("/api/me/delete", AccountDeletion.HOME_DELETE_PATH)
        assertFalse(AccountDeletion.WEB_PAGE_TEXT.startsWith("http"))
    }

    @Test
    fun `answers mean what they say`() {
        assertEquals(Outcome.Deleted, AccountDeletion.outcome(Kind.HUB, 200, null))
        assertEquals(Outcome.Deleted, AccountDeletion.outcome(Kind.HOME_MEMBER, 200, null))
        fun msg(kind: Kind, code: Int, err: String?) = (AccountDeletion.outcome(kind, code, err) as Outcome.NotDeleted).message
        assertTrue(msg(Kind.HOME_MEMBER, 401, "bad_credentials").contains("password"))
        assertTrue(msg(Kind.BEEBO_ACCOUNT, 401, "invalid_credentials").contains("Beebo account"))
        assertTrue(msg(Kind.HUB, 401, "Not signed in.").contains("expired"))
        assertTrue(msg(Kind.HOME_MEMBER, 409, "last_admin").contains("only admin"))
        assertTrue(msg(Kind.HOME_MEMBER, 429, "locked").contains("Too many"))
        assertTrue(msg(Kind.HOME_MEMBER, 404, null).contains("too old"))
        assertTrue(msg(Kind.HUB, 502, "Stripe down").contains("Stripe down"))
        assertTrue(msg(Kind.HUB, 500, null).contains("Nothing was deleted"))
    }
}
