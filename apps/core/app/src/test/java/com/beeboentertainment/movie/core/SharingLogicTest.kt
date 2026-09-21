package com.beeboentertainment.movie.core

import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.LoginResponse
import com.beeboentertainment.movie.data.MeResponse
import com.beeboentertainment.movie.rtc.RemoteSignIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SharingLogicTest {

    @Test fun `limited profiles hide owner tools, settings, trailers, requests and search-online`() {
        val owner = ProfileLimits.of(isAdmin = true, restricted = false, guest = false)
        assertTrue(owner.showOwnerTools && owner.showSettings && owner.showTrailers && owner.showRequests && owner.showSearchOnline && owner.showRelay)
        for (limits in listOf(ProfileLimits.of(false, restricted = true, guest = false), ProfileLimits.of(true, restricted = false, guest = true))) {
            assertFalse(limits.showOwnerTools)
            assertFalse(limits.showSettings)
            assertFalse(limits.showTrailers)
            assertFalse(limits.showRequests)
            assertFalse(limits.showSearchOnline)
            assertFalse(limits.showRelay)
            assertFalse(limits.showSpaceSaver)
        }
        val member = ProfileLimits.of(isAdmin = false, restricted = false, guest = false)
        assertFalse(member.showOwnerTools)
        assertTrue(member.showTrailers)
    }

    @Test fun `the server's restricted and guest flags are read, and old servers read as neither`() {
        val me = ApiClient.JSON.decodeFromString(MeResponse.serializer(), """{"ok":true,"user":{"id":"k","name":"Sam","isAdmin":false,"restricted":true}}""")
        assertTrue(me.user!!.restricted)
        assertFalse(me.user!!.guest)
        val old = ApiClient.JSON.decodeFromString(MeResponse.serializer(), """{"ok":true,"user":{"id":"a","name":"A","isAdmin":true}}""")
        assertFalse(old.user!!.restricted)
        val guest = ApiClient.JSON.decodeFromString(LoginResponse.serializer(), """{"ok":true,"token":"sh1.x","user":{"id":"share:sh_1","name":"Jo","isAdmin":false,"guest":true},"share":{"id":"sh_1"}}""")
        assertTrue(guest.user!!.guest)
    }

    @Test fun `invite codes are normalised and checked`() {
        assertEquals("ABCD-EFGH", InviteCode.normalize("abcd efgh"))
        assertEquals("ABCD-EFGH", InviteCode.normalize("ABCD-EFGH"))
        assertNull(InviteCode.normalize("ABCD-EFG"))
        // 0 and O are never in a code.
        assertNull(InviteCode.normalize("ABCD-EFG0"))
    }

    @Test fun `shared library list keeps one entry per house and drops what the account no longer lists`() {
        var list = SharedLibraries.decode(null)
        assertTrue(list.isEmpty())
        list = SharedLibraries.upsert(list, SharedLibrary("nick", "Sam's library", "jo@example.com", "sh_1"))
        list = SharedLibraries.upsert(list, SharedLibrary("amy", "", "jo@example.com", "sh_2"))
        list = SharedLibraries.upsert(list, SharedLibrary("nick", "Sam's films", "jo@example.com", "sh_1"))
        assertEquals(listOf("nick", "amy"), list.map { it.name })
        assertEquals("Sam's films", list.first().title)
        assertEquals("amy.beebo.tv", list[1].title)
        val round = SharedLibraries.decode(SharedLibraries.encode(list))
        assertEquals(list, round)
        assertEquals(listOf("amy"), SharedLibraries.remove(list, "nick").map { it.name })
        val other = SharedLibraries.upsert(list, SharedLibrary("pat", "", "sam@example.com", "sh_3"))
        val fromServer = listOf(SharedLibrary("nick", "Nick", "jo@example.com", "sh_1"))
        assertEquals(listOf("nick", "pat"), SharedLibraries.replaceFromAccount(other, fromServer, "JO@example.com").map { it.name })
        // Junk house names are ignored.
        assertTrue(SharedLibraries.decode("""[{"name":"../x"}]""").isEmpty())
    }

    @Test fun `owner PIN and bedtime formats, and the summary line`() {
        assertTrue(OwnerPin.valid("4821"))
        assertFalse(OwnerPin.valid("12"))
        assertFalse(OwnerPin.valid("12ab"))
        assertTrue(ParentalSummary.validTime("21:00"))
        assertFalse(ParentalSummary.validTime("25:00"))
        assertEquals("Off", ParentalSummary.of(false, "G", null, false, false, null, null, null))
        assertEquals("Films up to PG, TV up to TV-PG, unrated hidden, daily limit 90 min, no watching 21:00-07:00",
            ParentalSummary.of(true, "PG", "TV-PG", true, false, 90, "21:00", "07:00"))
    }

    @Test fun `a guest sign-in round-trips and is never mistaken for an email home`() {
        val s = RemoteSignIn(RemoteSignIn.Kind.GUEST, "nick", "jo@example.com", "pw")
        val back = RemoteSignIn.fromJson(s.toJson())!!
        assertEquals(RemoteSignIn.Kind.GUEST, back.kind)
        assertFalse(back.homeIsEmail)
    }

    @Test fun `report reasons match the Worker's list`() {
        assertEquals(listOf("piracy", "unwanted", "abuse", "other"), ShareReportReason.entries.map { it.code })
    }
}
