import XCTest
@testable import BeeboKit

final class ModelsDecodingTests: XCTestCase {
    func testMovieSummaryDecodes() {
        let movie = decode(MovieSummary.self, Fixtures.movieOne)
        XCTAssertEqual(movie.id, "QWxpZW4")
        XCTAssertEqual(movie.title, "Alien")
        XCTAssertEqual(movie.year, 1979)
        XCTAssertEqual(movie.tmdbId, 348)
        XCTAssertEqual(movie.voteAverage ?? 0, 8.1, accuracy: 0.001)
        XCTAssertEqual(movie.genres.first?.name, "Horror")
        XCTAssertEqual(movie.collection?.name, "Alien Collection")
        XCTAssertEqual(movie.poster, "/media/poster/348.jpg")
        XCTAssertTrue(movie.backdrop?.hasPrefix("https://image.tmdb.org") ?? false)
        XCTAssertEqual(movie.ref, MediaRef(kind: .movie, id: "QWxpZW4", title: "Alien", poster: "/media/poster/348.jpg", backdrop: movie.backdrop))
    }

    func testMovieSummaryToleratesMissingAndWrongTypes() {
        let movie = decode(MovieSummary.self, "{\"id\":\"x\",\"title\":5,\"year\":\"soon\",\"genres\":\"none\"}")
        XCTAssertEqual(movie.id, "x")
        XCTAssertEqual(movie.title, "")
        XCTAssertNil(movie.year)
        XCTAssertTrue(movie.genres.isEmpty)
        XCTAssertFalse(movie.isNew)
    }

    func testShowSummary() {
        let show = decode(ShowSummary.self, "{\"id\":\"severance\",\"title\":\"Severance\",\"year\":2022,\"episodeCount\":9,\"isNew\":true,\"poster\":null}")
        XCTAssertEqual(show.id, "severance")
        XCTAssertEqual(show.episodeCount, 9)
        XCTAssertTrue(show.isNew)
        XCTAssertNil(show.poster)
        XCTAssertEqual(show.ref.kind, .tv)
    }

    func testContinueEntryFraction() {
        let entry = decode(ContinueEntry.self, "{\"id\":\"a\",\"kind\":\"tv\",\"title\":\"Show \\u2014 S1E2\",\"positionSeconds\":600,\"durationSeconds\":2400,\"percent\":25,\"watched\":false,\"upNext\":false,\"updatedAt\":1789978679182}")
        XCTAssertEqual(entry.kind, .tv)
        XCTAssertEqual(entry.fraction, 0.25, accuracy: 0.0001)
        XCTAssertEqual(entry.updatedAt ?? 0, 1789978679182, accuracy: 1)
    }

    func testContinueEntryFractionFallsBackToPercent() {
        let entry = decode(ContinueEntry.self, "{\"id\":\"a\",\"percent\":40}")
        XCTAssertEqual(entry.kind, .movie)
        XCTAssertEqual(entry.fraction, 0.4, accuracy: 0.0001)
    }

    func testUnknownKindFallsBackToMovie() {
        XCTAssertEqual(decode(ContinueEntry.self, "{\"id\":\"a\",\"kind\":\"podcast\"}").kind, .movie)
    }

    func testLossyArraySkipsGarbage() {
        let envelope: PageEnvelope<MovieSummary> = decode(PageEnvelope<MovieSummary>.self, "{\"total\":3,\"items\":[{\"id\":\"a\"},7,{\"id\":\"b\"},\"x\"]}")
        XCTAssertEqual(envelope.items.map(\.id), ["a", "b"])
        XCTAssertEqual(envelope.total, 3)
    }

    func testEpisodesResponse() {
        let json = """
        {"ok":true,"show":{"key":"severance","name":"Severance","poster":"/media/poster-tv/1.jpg","overview":"Work.","tmdbId":95396},
         "seasons":[{"season":1,"episodes":[
           {"id":"e1","season":1,"episode":1,"title":"S1E1 \\u00b7 Good News","episodeName":"Good News","watched":true,"watchedPercent":100},
           {"id":"e2","season":1,"episode":2,"title":"Severance \\u2014 S1E2","watched":false,"watchedPercent":40}]},
          {"season":null,"episodes":[{"id":"u1","title":"Loose file"}]}]}
        """
        let response = decode(EpisodesResponse.self, json)
        XCTAssertEqual(response.show?.overview, "Work.")
        XCTAssertEqual(response.seasons.count, 2)
        XCTAssertEqual(response.seasons[0].displayName, "Season 1")
        XCTAssertEqual(response.seasons[1].displayName, "Unsorted")
        XCTAssertEqual(response.allEpisodes.count, 3)
        XCTAssertTrue(response.allEpisodes[0].isWatched)
        XCTAssertFalse(response.allEpisodes[1].isWatched)
    }

    func testEpisodeWatchedFallsBackToPercent() {
        XCTAssertTrue(decode(Episode.self, "{\"id\":\"a\",\"watchedPercent\":96}").isWatched)
        XCTAssertFalse(decode(Episode.self, "{\"id\":\"a\",\"watchedPercent\":50}").isWatched)
    }

    func testPlaybackInfo() {
        let info = decode(PlaybackInfo.self, Fixtures.playbackInfo)
        XCTAssertTrue(info.ok)
        XCTAssertEqual(info.durationSec, 7020.5, accuracy: 0.01)
        XCTAssertEqual(info.video?.codec, "hevc")
        XCTAssertEqual(info.qualities.count, 3)
        XCTAssertTrue(info.transcode.available)
        XCTAssertEqual(info.audio.map(\.streamIndex), [1, 2])
        XCTAssertEqual(info.subtitles.map(\.key), ["side:0", "emb:5"])
        XCTAssertTrue(info.subtitles[0].isText)
        XCTAssertTrue(info.subtitles[1].isPicture)
        XCTAssertFalse(info.subtitles[1].isText)
    }

    func testPlaybackInfoWithoutTranscodeBlockIsUnavailable() {
        let info = decode(PlaybackInfo.self, "{\"ok\":true,\"durationSec\":100}")
        XCTAssertFalse(info.transcode.available)
    }

    func testLoginFailureMessages() {
        XCTAssertEqual(decode(LoginResponse.self, "{\"ok\":false,\"error\":\"bad_credentials\"}").failureMessage, "Wrong username or password.")
        XCTAssertTrue(decode(LoginResponse.self, "{\"ok\":false,\"locked\":true,\"minutesRemaining\":1}").failureMessage.contains("1 minute."))
        XCTAssertTrue(decode(LoginResponse.self, "{\"ok\":false,\"locked\":true,\"minutesRemaining\":12}").failureMessage.contains("12 minutes"))
        XCTAssertEqual(decode(LoginResponse.self, "{\"ok\":false}").failureMessage, "Sign-in failed.")
    }

    func testPingRecognisesBothServerNames() {
        XCTAssertTrue(decode(PingResponse.self, "{\"ok\":true,\"app\":\"beeboentertainment\",\"apiVersion\":1}").isBeeboServer)
        XCTAssertTrue(decode(PingResponse.self, "{\"ok\":true,\"app\":\"movieapp\"}").isBeeboServer)
        XCTAssertFalse(decode(PingResponse.self, "{\"ok\":true,\"app\":\"plex\"}").isBeeboServer)
        XCTAssertFalse(decode(PingResponse.self, "{\"ok\":false,\"app\":\"beeboentertainment\"}").isBeeboServer)
    }
}

final class BeeboAPITests: XCTestCase {
    func testMoviesRequestUsesV1PagingAndBearer() async throws {
        let transport = MockTransport()
        transport.route("/api/v1/library/movies", body: Fixtures.moviePage(total: 130, offset: 60, ids: ["a", "b"]))
        let page = try await Fixtures.api(transport).movies(query: "the matrix", offset: 60, limit: 60)
        XCTAssertEqual(page.items.map(\.id), ["a", "b"])
        XCTAssertEqual(page.total, 130)
        XCTAssertEqual(page.offset, 60)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        let query = try XCTUnwrap(request.url?.absoluteString)
        XCTAssertTrue(query.contains("limit=60"), query)
        XCTAssertTrue(query.contains("offset=60"), query)
        XCTAssertTrue(query.contains("q=the%20matrix"), query)
        XCTAssertEqual(request.httpMethod, "GET")
    }

    func testEmptySearchOmitsQuery() async throws {
        let transport = MockTransport()
        transport.route("/api/v1/library/tvshows", body: "{\"ok\":true,\"total\":0,\"limit\":60,\"offset\":0,\"items\":[]}")
        _ = try await Fixtures.api(transport).shows(query: "   ")
        XCTAssertFalse(try XCTUnwrap(transport.requests.first?.url?.absoluteString).contains("q="))
    }

    func testItemsWithoutAnIdAreDropped() async throws {
        let transport = MockTransport()
        transport.route("/api/v1/library/movies", body: "{\"total\":2,\"items\":[{\"title\":\"no id\"},{\"id\":\"ok\",\"title\":\"ok\"}]}")
        let page = try await Fixtures.api(transport).movies()
        XCTAssertEqual(page.items.map(\.id), ["ok"])
    }

    func testMissingTokenFailsBeforeAnyRequest() async {
        let transport = MockTransport()
        do {
            _ = try await Fixtures.api(transport, token: nil).movies()
            XCTFail("expected unauthorized")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testStatusMapping() async {
        let transport = MockTransport()
        transport.route("/api/v1/continue", status: 401, body: "{}")
        transport.route("/api/v1/library/movies", status: 403, body: "{\"error\":\"history_private\"}")
        transport.route("/api/v1/library/tvshows", status: 404, body: "{}")
        transport.route("/api/v1/library/recently-added", status: 500, body: "oops")
        let api = Fixtures.api(transport)
        do { _ = try await api.continueWatching(); XCTFail() } catch { XCTAssertEqual(error as? APIError, .unauthorized) }
        do { _ = try await api.movies(); XCTFail() } catch { XCTAssertEqual(error as? APIError, .forbidden("history_private")) }
        do { _ = try await api.shows(); XCTFail() } catch { XCTAssertEqual(error as? APIError, .notFound) }
        do { _ = try await api.recentlyAdded(); XCTFail() } catch { XCTAssertEqual(error as? APIError, .server(500)) }
    }

    func testNetworkFailureIsClassified() async {
        let transport = MockTransport()
        do {
            _ = try await Fixtures.api(transport).ping()
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual(error as? APIError, .network(.cannotConnect))
        }
    }

    func testLoginSuccessAndBadCredentials() async throws {
        let transport = MockTransport()
        transport.route("/api/login", method: "POST", body: "{\"ok\":true,\"token\":\"u1.123.sig\",\"user\":{\"id\":\"u1\",\"name\":\"Nick\",\"isAdmin\":true}}")
        let ok = try await Fixtures.api(transport, token: nil).login(username: "nick", password: "pw")
        XCTAssertTrue(ok.ok)
        XCTAssertEqual(ok.token, "u1.123.sig")
        XCTAssertEqual(ok.user?.name, "Nick")
        let body = transport.jsonBody(of: try XCTUnwrap(transport.requests.first))
        XCTAssertEqual(body["username"] as? String, "nick")
        XCTAssertNil(transport.requests.first?.value(forHTTPHeaderField: "Authorization"))

        transport.route("/api/login", method: "POST", status: 401, body: "{\"ok\":false,\"error\":\"bad_credentials\"}")
        let bad = try await Fixtures.api(transport, token: nil).login(username: "nick", password: "x")
        XCTAssertFalse(bad.ok)
        XCTAssertEqual(bad.failureMessage, "Wrong username or password.")

        transport.route("/api/login", method: "POST", status: 401, body: "<html>nope</html>")
        let html = try await Fixtures.api(transport, token: nil).login(username: "nick", password: "x")
        XCTAssertFalse(html.ok)
    }

    func testEpisodesEncodesShowKey() async throws {
        let transport = MockTransport()
        transport.route("/api/tvshows/the show/episodes", body: "{\"ok\":true,\"seasons\":[]}")
        _ = try await Fixtures.api(transport).episodes(showKey: "the show")
        XCTAssertEqual(transport.requests.first?.url?.absoluteString, "http://192.168.1.20:47811/api/tvshows/the%20show/episodes")
    }

    func testPlaybackStartSendsAudioAndBurnedSubtitle() async throws {
        let transport = MockTransport()
        transport.route("/api/playback/start", method: "POST", body: Fixtures.startOK)
        _ = try await Fixtures.api(transport).playbackStart(kind: .tv, id: "e1", quality: "720p", audioStreamIndex: 2, burnSubtitleStreamIndex: 5)
        let body = transport.jsonBody(of: try XCTUnwrap(transport.requests.first))
        XCTAssertEqual(body["kind"] as? String, "tv")
        XCTAssertEqual(body["id"] as? String, "e1")
        XCTAssertEqual(body["quality"] as? String, "720p")
        XCTAssertEqual(body["audio"] as? Int, 2)
        XCTAssertEqual(body["burnSubtitle"] as? Int, 5)
    }

    func testPlaybackStartRefusalCarriesServerMessage() async {
        let transport = MockTransport()
        transport.route("/api/playback/start", method: "POST", status: 503, body: "{\"ok\":false,\"error\":\"busy\",\"message\":\"Busy converting.\"}")
        do {
            _ = try await Fixtures.api(transport).playbackStart(kind: .movie, id: "m", quality: "1080p")
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(code: "busy", message: "Busy converting."))
        }
    }

    func testPlaybackStartRefusalWithoutBodyUsesFriendlyText() async {
        let transport = MockTransport()
        transport.route("/api/playback/start", method: "POST", status: 409, body: "{\"ok\":false,\"error\":\"no_encoder\"}")
        do {
            _ = try await Fixtures.api(transport).playbackStart(kind: .movie, id: "m", quality: "1080p")
            XCTFail("expected refusal")
        } catch let error as APIError {
            guard case .refused(let code, let message) = error else { return XCTFail("wrong error \(error)") }
            XCTAssertEqual(code, "no_encoder")
            XCTAssertTrue(message.contains("encoder"), message)
        } catch {
            XCTFail("wrong error \(error)")
        }
    }

    func testProgressBody() async throws {
        let transport = MockTransport()
        transport.route("/api/progress", method: "POST", body: "{\"ok\":true}")
        try await Fixtures.api(transport).reportProgress(sessionId: "s1", currentTime: 61.5, duration: 7000)
        let body = transport.jsonBody(of: try XCTUnwrap(transport.requests.first))
        XCTAssertEqual(body["sessionId"] as? String, "s1")
        XCTAssertEqual(body["currentTime"] as? Double, 61.5)
        XCTAssertEqual(body["duration"] as? Double, 7000)
    }

    func testAbsoluteURLForPosters() {
        let api = Fixtures.api(MockTransport())
        XCTAssertEqual(api.absoluteURL("/media/poster/1.jpg")?.absoluteString, "http://192.168.1.20:47811/media/poster/1.jpg")
        XCTAssertNil(api.absoluteURL(nil))
    }

    func testNetworkFailureClassification() {
        XCTAssertEqual(NetworkFailure.classify(URLError(.timedOut)), .timedOut)
        XCTAssertEqual(NetworkFailure.classify(URLError(.notConnectedToInternet)), .offline)
        XCTAssertEqual(NetworkFailure.classify(URLError(.cannotFindHost)), .cannotFindHost)
        XCTAssertEqual(NetworkFailure.classify(URLError(.secureConnectionFailed)), .secureConnectionFailed)
        XCTAssertEqual(NetworkFailure.classify(URLError(.appTransportSecurityRequiresSecureConnection)), .blockedByTransportSecurity)
    }

    func testEveryErrorHasAMessage() {
        let errors: [APIError] = [.invalidAddress, .unauthorized, .forbidden("x"), .notFound, .server(500),
                                  .refused(code: "c", message: "m"), .network(.timedOut), .badResponse]
        for error in errors {
            XCTAssertFalse(error.userMessage.isEmpty)
            XCTAssertEqual(error.errorDescription, error.userMessage)
        }
    }
}
