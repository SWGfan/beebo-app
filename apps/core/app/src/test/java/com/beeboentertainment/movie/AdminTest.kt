package com.beeboentertainment.movie

import com.beeboentertainment.movie.core.AdminErrors
import com.beeboentertainment.movie.core.AdminGate
import com.beeboentertainment.movie.data.AdminConversionsResponse
import com.beeboentertainment.movie.data.AdminFlagsResponse
import com.beeboentertainment.movie.data.AdminHistoryClearRequest
import com.beeboentertainment.movie.data.AdminHistoryClearResponse
import com.beeboentertainment.movie.data.AdminHistoryResponse
import com.beeboentertainment.movie.data.AdminIdRequest
import com.beeboentertainment.movie.data.AdminMarkerClearRequest
import com.beeboentertainment.movie.data.AdminMarkersResponse
import com.beeboentertainment.movie.data.AdminMissingResponse
import com.beeboentertainment.movie.data.AdminRequestIdRequest
import com.beeboentertainment.movie.data.AdminRequestsResponse
import com.beeboentertainment.movie.data.AdminSetAdminRequest
import com.beeboentertainment.movie.data.AdminSettingsResponse
import com.beeboentertainment.movie.data.AdminSettingsUpdateRequest
import com.beeboentertainment.movie.data.AdminSummaryResponse
import com.beeboentertainment.movie.data.AdminUserActionResponse
import com.beeboentertainment.movie.data.AdminUserIdRequest
import com.beeboentertainment.movie.data.AdminUsersResponse
import com.beeboentertainment.movie.data.ApiClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The admin API: every GET shape, every POST body, the gate, and the error wording. */
class AdminTest {

    private val json = ApiClient.JSON

    /* ------------------------------ the gate -------------------------------- */

    @Test
    fun `only a signed-in admin sees the admin entry point`() {
        assertTrue(AdminGate.showAdminEntry(isSignedIn = true, isAdmin = true))
        assertFalse(AdminGate.showAdminEntry(isSignedIn = true, isAdmin = false))
        assertFalse(AdminGate.showAdminEntry(isSignedIn = false, isAdmin = true))
        assertFalse(AdminGate.showAdminEntry(isSignedIn = false, isAdmin = false))
    }

    @Test
    fun `opening an admin screen uses the same rule as showing the button`() {
        assertEquals(
            AdminGate.showAdminEntry(true, true),
            AdminGate.canOpenAdmin(true, true)
        )
        assertFalse(AdminGate.canOpenAdmin(true, false))
    }

    @Test
    fun `a failed admin check keeps the last known answer rather than flickering`() {
        // /api/me unreachable on resume -> null
        assertTrue(AdminGate.resolveIsAdmin(fresh = null, lastKnown = true))
        assertFalse(AdminGate.resolveIsAdmin(fresh = null, lastKnown = false))
        // a fresh answer always wins, including a demotion
        assertFalse(AdminGate.resolveIsAdmin(fresh = false, lastKnown = true))
        assertTrue(AdminGate.resolveIsAdmin(fresh = true, lastKnown = false))
    }

    /* ------------------------------- summary -------------------------------- */

    @Test
    fun `the summary badge counts parse`() {
        val body = """
        {"ok":true,
         "users":{"total":8,"pending":1,"revoked":1},
         "requests":{"pending":2},
         "flags":{"unresolved":2},
         "missing":{"unresolved":2},
         "conversions":{"queued":1,"converting":1,"done":4,"error":1},
         "library":{"movies":12,"shows":3,"episodes":41},
         "storage":{"convertedBytes":6291556,"originalBytes":4096},
         "https":{"active":true,"daysRemaining":29}}
        """.trimIndent()
        val r = json.decodeFromString(AdminSummaryResponse.serializer(), body)
        assertTrue(r.ok)
        assertEquals(8, r.users.total)
        assertEquals(1, r.users.pending)
        assertEquals(2, r.requests.pending)
        assertEquals(2, r.flags.unresolved)
        assertEquals(2, r.missing.unresolved)
        assertEquals(1, r.conversions.converting)
        assertEquals(41, r.library.episodes)
        assertEquals(6291556L, r.storage.convertedBytes)
        assertTrue(r.https.active)
        assertEquals(29, r.https.daysRemaining)
    }

    @Test
    fun `a missing certificate reports null days rather than zero`() {
        val r = json.decodeFromString(
            AdminSummaryResponse.serializer(),
            """{"ok":true,"https":{"active":false,"daysRemaining":null}}"""
        )
        assertFalse(r.https.active)
        assertNull(r.https.daysRemaining)
        // and the absent blocks fall back to zeroes rather than throwing
        assertEquals(0, r.users.total)
    }

    /* -------------------------------- users --------------------------------- */

    @Test
    fun `the users list parses, and carries no credentials`() {
        val body = """
        {"ok":true,"users":[
          {"id":"u1","name":"Nick","username":"nick","email":"sam@x.com","status":"approved",
           "isAdmin":true,"createdAt":1690000000000,"hasPassword":true,"hasCode":true,
           "lastSeenAt":1690000000000,"lastSeenIp":"1.2.3.4"},
          {"id":"u4","name":"Kid","username":"kid","email":"k@x.com","status":"pending_verification",
           "isAdmin":false,"createdAt":1,"hasPassword":false,"hasCode":false,
           "lastSeenAt":null,"lastSeenIp":null}]}
        """.trimIndent()
        val r = json.decodeFromString(AdminUsersResponse.serializer(), body)
        assertEquals(2, r.users.size)
        val nick = r.users[0]
        assertTrue(nick.isAdmin)
        assertTrue(nick.isApproved)
        assertEquals("Approved", nick.statusLabel)
        val kid = r.users[1]
        assertTrue(kid.isPending)
        assertEquals("Awaiting email confirmation", kid.statusLabel)
        assertNull(kid.lastSeenAt)
        // the API whitelists its fields — there is nowhere for a PIN or hash to land
        val fields = com.beeboentertainment.movie.data.AdminUser::class.java.declaredFields.map { it.name }
        assertFalse(fields.any { it.contains("code", true) && it != "hasCode" })
        assertFalse(fields.any { it.contains("password", true) && it != "hasPassword" })
        assertFalse(fields.any { it.contains("token", true) || it.contains("hash", true) })
    }

    @Test
    fun `a revoked user is recognised for the reactivate action`() {
        val r = json.decodeFromString(
            AdminUsersResponse.serializer(),
            """{"ok":true,"users":[{"id":"u5","name":"X","status":"revoked"}]}"""
        )
        assertTrue(r.users.single().isRevoked)
        assertEquals("Revoked", r.users.single().statusLabel)
    }

    @Test
    fun `an already-approved account answers unchanged`() {
        val r = json.decodeFromString(
            AdminUserActionResponse.serializer(),
            """{"ok":true,"unchanged":true,"user":{"id":"u4","name":"Kid","status":"approved"}}"""
        )
        assertTrue(r.ok)
        assertTrue(r.unchanged)
        assertNull(r.code)
    }

    @Test
    fun `regenerate-code returns the credential once`() {
        val r = json.decodeFromString(
            AdminUserActionResponse.serializer(),
            """{"ok":true,"code":"ABC123","user":{"id":"u8","name":"Kid","status":"approved"}}"""
        )
        assertEquals("ABC123", r.code)
        assertNotNull(r.user)
    }

    @Test
    fun `last_admin comes back as a 200 refusal, not an exception`() {
        val r = json.decodeFromString(
            AdminUserActionResponse.serializer(),
            """{"ok":false,"error":"last_admin"}"""
        )
        assertFalse(r.ok)
        assertEquals("last_admin", r.error)
        assertTrue(AdminErrors.message(r.error).contains("only admin left"))
    }

    /* ----------------------------- request bodies ---------------------------- */

    @Test
    fun `the user POST bodies are exactly what the API documents`() {
        assertEquals(
            """{"userId":"u4"}""",
            json.encodeToString(AdminUserIdRequest.serializer(), AdminUserIdRequest("u4"))
        )
        assertEquals(
            """{"userId":"u7","isAdmin":true}""",
            json.encodeToString(AdminSetAdminRequest.serializer(), AdminSetAdminRequest("u7", true))
        )
        assertEquals(
            """{"userId":"u7","isAdmin":false}""",
            json.encodeToString(AdminSetAdminRequest.serializer(), AdminSetAdminRequest("u7", false))
        )
        assertEquals(
            """{"requestId":"r1"}""",
            json.encodeToString(AdminRequestIdRequest.serializer(), AdminRequestIdRequest("r1"))
        )
        assertEquals(
            """{"id":"c1"}""",
            json.encodeToString(AdminIdRequest.serializer(), AdminIdRequest("c1"))
        )
        assertEquals(
            """{"scope":"show","key":"the-wire"}""",
            json.encodeToString(AdminMarkerClearRequest.serializer(), AdminMarkerClearRequest("show", "the-wire"))
        )
    }

    @Test
    fun `each history clear scope sends the field that scope needs`() {
        val one = json.encodeToString(
            AdminHistoryClearRequest.serializer(),
            AdminHistoryClearRequest("one", "u3", fileName = "A.mkv")
        )
        assertTrue(one.contains(""""scope":"one""""))
        assertTrue(one.contains(""""userId":"u3""""))
        assertTrue(one.contains(""""fileName":"A.mkv""""))
        assertFalse(one.contains("title"))

        val show = json.encodeToString(
            AdminHistoryClearRequest.serializer(),
            AdminHistoryClearRequest("show", "u3", title = "The Wire")
        )
        assertTrue(show.contains(""""title":"The Wire""""))
        assertFalse(show.contains("fileName"))

        // all needs neither
        assertEquals(
            """{"scope":"all","userId":"u3"}""",
            json.encodeToString(AdminHistoryClearRequest.serializer(), AdminHistoryClearRequest("all", "u3"))
        )
    }

    @Test
    fun `the settings body only ever names folder fields, and omits untouched ones`() {
        val body = json.encodeToString(
            AdminSettingsUpdateRequest.serializer(),
            AdminSettingsUpdateRequest(viewerAppDir = "/mnt/d/Viewer")
        )
        assertEquals("""{"viewerAppDir":"/mnt/d/Viewer"}""", body)
        // nothing that could carry a secret exists on the request at all
        val fields = AdminSettingsUpdateRequest::class.java.declaredFields.map { it.name }
        assertFalse(fields.any { it.contains("key", true) || it.contains("password", true) })
        // exactly the seven allowlisted folder fields, and nothing else that could carry a secret
        listOf(
            "moviesDir", "tvShowsDir", "newFilesDir",
            "viewerAppDir", "tmdbCacheDir", "extraMoviesDirs", "extraTvShowsDirs"
        ).forEach { assertTrue("missing $it", it in fields) }
        assertTrue(fields.none { it == "tmdbApiKey" || it == "emailAppPassword" })
    }

    /* -------------------------- the remaining GETs --------------------------- */

    @Test
    fun `access requests parse`() {
        val r = json.decodeFromString(
            AdminRequestsResponse.serializer(),
            """{"ok":true,"requests":[{"id":"r1","name":"Ann","email":"a@x.com",
                "message":"please","status":"pending","createdAt":1690000000000}]}"""
        )
        assertEquals("Ann", r.requests.single().name)
        assertEquals("pending", r.requests.single().status)
    }

    @Test
    fun `flags parse, with movies naming a fileName and tv a relPath`() {
        val r = json.decodeFromString(
            AdminFlagsResponse.serializer(),
            """{"ok":true,"flags":[
               {"id":"f1","kind":"movie","filePath":"/m/Heat.mkv","fileName":"Heat.mkv",
                "title":"Heat","flaggedBy":[{"userId":"u1","userName":"Nick","at":1}],
                "firstFlaggedAt":1,"resolved":false},
               {"id":"f2","kind":"tv","filePath":"/tv/W/S01E02.mkv","relPath":"W/S01E02.mkv",
                "title":"The Wire","flaggedBy":[],"firstFlaggedAt":2,"resolved":true}]}"""
        )
        assertEquals("Heat.mkv", r.flags[0].displayPath)
        assertEquals("W/S01E02.mkv", r.flags[1].displayPath)
        assertEquals("Nick", r.flags[0].flaggedBy.single().userName)
        assertTrue(r.flags[1].resolved)
    }

    @Test
    fun `missing-file requests parse for both kinds`() {
        val r = json.decodeFromString(
            AdminMissingResponse.serializer(),
            """{"ok":true,"missing":[
               {"id":"m1","kind":"tv","title":"W S1E2","showName":"W","season":1,"episode":2,
                "collectionName":null,"tmdbId":null,"year":null,
                "requestedBy":[{"userId":"u1","userName":"Nick","at":1}],
                "firstSeenAt":1,"resolved":false},
               {"id":"m2","kind":"movie","title":"Part III","showName":null,"season":null,
                "episode":null,"collectionName":"Godfather","tmdbId":242,"year":1990,
                "requestedBy":[],"firstSeenAt":2,"resolved":false}]}"""
        )
        assertEquals(1, r.missing[0].season)
        assertNull(r.missing[1].season)
        assertEquals("Godfather", r.missing[1].collectionName)
    }

    @Test
    fun `conversions parse with live progress and the right actions offered`() {
        val r = json.decodeFromString(
            AdminConversionsResponse.serializer(),
            """{"ok":true,"conversions":[
               {"id":"c1","originalPath":"/m/A.avi","outputPath":"/m/A.mp4","status":"converting",
                "kind":"movie","castAvailable":false,"queuedAt":1,"startedAt":2,"finishedAt":null,
                "originalBytes":100,"convertedBytes":null,"error":null,"progressPct":42,
                "originalDeleted":false},
               {"id":"c2","originalPath":"/m/B.avi","outputPath":"/m/B.mp4","status":"done",
                "kind":"movie","originalBytes":200,"convertedBytes":150,"progressPct":100,
                "originalDeleted":false},
               {"id":"c3","originalPath":"/m/C.avi","outputPath":null,"status":"error",
                "kind":"movie","originalBytes":300,"error":"ffmpeg blew up","progressPct":0}]}"""
        )
        val running = r.conversions[0]
        assertTrue(running.isRunning)
        assertEquals(42, running.progressPct)
        assertEquals("A.avi", running.fileName)

        val done = r.conversions[1]
        assertTrue(done.isDone)
        assertFalse(done.isRetryable)

        val failed = r.conversions[2]
        assertTrue(failed.isRetryable)
        assertEquals("ffmpeg blew up", failed.error)
        assertNull(failed.outputPath)
        assertEquals("Converting now", running.statusLabel)
    }

    @Test
    fun `desktop 0_1_37 plays-as-it-is statuses get plain-English labels`() {
        val r = json.decodeFromString(
            AdminConversionsResponse.serializer(),
            """{"ok":true,"conversions":[
               {"id":"n1","originalPath":"/m/D.mkv","status":"not-needed",
                "notNeededReason":"Already H.264 + AAC"},
               {"id":"n2","originalPath":"/m/E.avi","status":"dont-convert"},
               {"id":"n3","originalPath":"/m/F.avi","status":"some-future-state"}]}"""
        )
        assertEquals("Plays as it is", r.conversions[0].statusLabel)
        assertEquals("Already H.264 + AAC", r.conversions[0].notNeededReason)
        assertFalse(r.conversions[0].isRetryable)
        assertEquals("Not converting (your choice)", r.conversions[1].statusLabel)
        assertEquals("some-future-state", r.conversions[2].statusLabel)
    }

    @Test
    fun `a guardrail refusal arrives as 200 with the list intact`() {
        val r = json.decodeFromString(
            AdminConversionsResponse.serializer(),
            """{"ok":false,"error":"converted_file_too_small","conversions":[
               {"id":"c1","originalPath":"/m/A.avi","status":"done"}]}"""
        )
        assertFalse(r.ok)
        assertEquals("converted_file_too_small", r.error)
        assertEquals(1, r.conversions.size)   // the list still comes back
    }

    @Test
    fun `markers parse, including a row with only one value set`() {
        val r = json.decodeFromString(
            AdminMarkersResponse.serializer(),
            """{"ok":true,"markers":[
               {"id":"pm1","scope":"show","key":"the-wire","introEndSeconds":30,
                "creditsStartSeconds":1500,"setBy":{"userId":"u1","userName":"Nick","at":1},
                "setAt":1,"updatedAt":2},
               {"id":"pm2","scope":"movie","key":"Heat.mkv","introEndSeconds":null,
                "creditsStartSeconds":6000,"setBy":null,"setAt":1,"updatedAt":1}]}"""
        )
        assertEquals("show", r.markers[0].scope)
        assertEquals(30.0, r.markers[0].introEndSeconds!!, 0.001)
        assertNull(r.markers[1].introEndSeconds)
        assertNull(r.markers[1].setBy)
    }

    @Test
    fun `everyone's history parses, and a clear reports how many rows went`() {
        val r = json.decodeFromString(
            AdminHistoryResponse.serializer(),
            """{"ok":true,"items":[{"sessionId":"s1","userId":"u3","userName":"Kid","kind":"movie",
               "fileName":"A.mkv","title":"A","startedAt":1,"lastUpdate":2,
               "currentTime":60,"duration":600}]}"""
        )
        assertEquals("Kid", r.items.single().userName)
        assertEquals(60.0, r.items.single().currentTime, 0.001)

        val cleared = json.decodeFromString(
            AdminHistoryClearResponse.serializer(),
            """{"ok":true,"removed":3}"""
        )
        assertEquals(3, cleared.removed)
    }

    @Test
    fun `settings parse, with secrets as booleans only and the settable list honoured`() {
        val body = """
        {"ok":true,"settings":{
          "folders":{"moviesDir":"/m","tvShowsDir":"/tv","newFilesDir":"/n",
                     "viewerAppDir":"/v","tmdbCacheDir":"/c",
                     "extraMoviesDirs":["/m2"],"extraTvShowsDirs":[]},
          "domain":"example-house.duckdns.org","port":47811,
          "secrets":{"tmdbApiKeyConfigured":true,"emailPasswordConfigured":false,
                     "emailConfigured":true,"duckdnsTokenConfigured":true},
          "https":{"active":true,"reason":"certificate installed","daysRemaining":68},
          "conversion":{"configurable":false,"videoCodec":"libx264","preset":"veryfast","crf":20,
                        "audioCodec":"aac","audioBitrate":"192k",
                        "minConvertedBytesBeforeOriginalDeletable":1048576},
          "login":{"lockoutThreshold":5,"lockoutDurationMinutes":5,"alertThreshold":30},
          "settableFields":["moviesDir","tvShowsDir"]}}
        """.trimIndent()
        val r = json.decodeFromString(AdminSettingsResponse.serializer(), body)
        val s = r.settings
        assertEquals("example-house.duckdns.org", s.domain)
        assertEquals(47811, s.port)
        assertTrue(s.secrets.tmdbApiKeyConfigured)
        assertFalse(s.secrets.emailPasswordConfigured)
        assertFalse(s.conversion.configurable)
        assertEquals(1048576L, s.conversion.minConvertedBytesBeforeOriginalDeletable)
        assertEquals(5, s.login.lockoutThreshold)
        // the UI makes exactly these editable, and nothing else
        assertEquals(listOf("moviesDir", "tvShowsDir"), s.settableFields)
        assertEquals(listOf("/m2"), s.folders.extraMoviesDirs)
    }

    @Test
    fun `a settings refusal names the offending field`() {
        val r = json.decodeFromString(
            AdminSettingsResponse.serializer(),
            """{"ok":false,"error":"not_remotely_settable","field":"tmdbApiKey"}"""
        )
        assertFalse(r.ok)
        assertEquals("tmdbApiKey", r.field)
        val message = AdminErrors.message(r.error, r.field)
        assertTrue(message.contains("TMDB API key"))
        assertTrue(message.contains("desktop app"))
    }

    @Test
    fun `a successful save reports what changed`() {
        val r = json.decodeFromString(
            AdminSettingsResponse.serializer(),
            """{"ok":true,"changed":["viewerAppDir"],"settings":{"domain":"x","port":1}}"""
        )
        assertTrue(r.ok)
        assertEquals(listOf("viewerAppDir"), r.changed)
    }

    /* ----------------------------- error wording ----------------------------- */

    @Test
    fun `https_required explains the certificate rather than looking like an outage`() {
        val m = AdminErrors.message("https_required")
        assertTrue(m.contains("secure connection"))
        assertTrue(m.contains("certificate"))
        assertTrue(AdminErrors.isHttpsProblem("https_required"))
        assertFalse(AdminErrors.isHttpsProblem("admin_only"))
    }

    @Test
    fun `admin_only is not treated as a dead session`() {
        assertTrue(AdminErrors.message("admin_only").contains("isn't an admin"))
        assertFalse(AdminErrors.isSessionProblem("admin_only"))
        assertTrue(AdminErrors.isSessionProblem("unauthorized"))
    }

    @Test
    fun `every conversion guardrail has its own readable explanation`() {
        val codes = listOf(
            "not_deletable", "converted_file_missing", "converted_file_too_small",
            "no_output_path", "invalid_path", "outside_managed_folders"
        )
        val messages = codes.map { AdminErrors.message(it) }
        // each one says something specific, and none falls through to the raw code
        messages.forEach { assertFalse(it.startsWith("The server said:")) }
        assertEquals(messages.size, messages.toSet().size)
        assertTrue(AdminErrors.message("converted_file_too_small").contains("1 MB"))
        assertTrue(AdminErrors.message("invalid_path").contains("same file"))
        assertTrue(AdminErrors.message("outside_managed_folders").contains("won't be touched"))
    }

    @Test
    fun `the settings refusals name the folder in plain words`() {
        assertTrue(AdminErrors.message("not_a_directory", "moviesDir").contains("Movies folder"))
        assertTrue(AdminErrors.message("bad_value", "extraMoviesDirs").contains("extra Movies folders"))
        assertTrue(AdminErrors.message("not_settable", "somethingElse").contains("somethingElse"))
        assertEquals("The TMDB API key", AdminErrors.friendlyField("tmdbApiKey"))
        assertEquals("That setting", AdminErrors.friendlyField(null))
    }

    @Test
    fun `an unrecognised code is still shown rather than swallowed`() {
        assertEquals("The server said: some_new_thing", AdminErrors.message("some_new_thing"))
        assertTrue(AdminErrors.message(null).contains("didn't say why"))
        assertTrue(AdminErrors.message("").contains("didn't say why"))
    }
}
