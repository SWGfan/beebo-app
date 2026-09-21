import XCTest
@testable import BeeboKit

final class PlaybackPlannerTests: XCTestCase {
    private var info: PlaybackInfo { decode(PlaybackInfo.self, Fixtures.playbackInfo) }

    private func infoWith(qualities: [(String, Bool)], transcode: Bool = true) -> PlaybackInfo {
        let list = qualities.map { "{\"id\":\"\($0.0)\",\"label\":\"\($0.0)\",\"height\":1,\"upscale\":\($0.1)}" }.joined(separator: ",")
        return decode(PlaybackInfo.self, "{\"ok\":true,\"qualities\":[\(list)],\"transcode\":{\"available\":\(transcode)}}")
    }

    func testAutoPicksHighestNonUpscale() {
        XCTAssertEqual(PlaybackPlanner.chooseQuality(info: info, preference: .auto), "1080p")
        let small = infoWith(qualities: [("1080p", true), ("720p", false), ("480p", false)])
        XCTAssertEqual(PlaybackPlanner.chooseQuality(info: small, preference: .auto), "720p")
    }

    func testExplicitPreferenceIsHonouredWhenOffered() {
        XCTAssertEqual(PlaybackPlanner.chooseQuality(info: info, preference: .p480), "480p")
        XCTAssertEqual(PlaybackPlanner.chooseQuality(info: info, preference: .p720), "720p")
    }

    func testPreferenceAboveSourceFallsToBestOffered() {
        let small = infoWith(qualities: [("1080p", true), ("720p", false), ("480p", false)])
        XCTAssertEqual(PlaybackPlanner.chooseQuality(info: small, preference: .p1080), "720p")
    }

    func testNoQualityListAssumesAll() {
        let bare = infoWith(qualities: [])
        XCTAssertEqual(PlaybackPlanner.chooseQuality(info: bare, preference: .auto), "1080p")
        XCTAssertEqual(PlaybackPlanner.chooseQuality(info: bare, preference: .p480), "480p")
    }

    func testAllUpscaleStillOffersSomething() {
        let tiny = infoWith(qualities: [("1080p", true), ("720p", true), ("480p", true)])
        XCTAssertEqual(PlaybackPlanner.chooseQuality(info: tiny, preference: .auto), "1080p")
    }

    func testNoTranscodeMeansNoPlan() {
        XCTAssertNil(PlaybackPlanner.chooseQuality(info: infoWith(qualities: [], transcode: false), preference: .auto))
    }

    func testAudioOverrideOnlyWhenPreferredDiffersFromDefault() {
        XCTAssertEqual(PlaybackPlanner.audioOverride(info: info, preferredLanguage: "fr"), 2)
        XCTAssertNil(PlaybackPlanner.audioOverride(info: info, preferredLanguage: "en"))
        XCTAssertNil(PlaybackPlanner.audioOverride(info: info, preferredLanguage: "de"))
        XCTAssertNil(PlaybackPlanner.audioOverride(info: info, preferredLanguage: ""))
        XCTAssertEqual(PlaybackPlanner.audioOverride(info: info, preferredLanguage: "fre"), 2)
    }

    func testEffectiveAudio() {
        XCTAssertEqual(PlaybackPlanner.effectiveAudio(info: info, streamIndex: 2)?.language, "fr")
        XCTAssertEqual(PlaybackPlanner.effectiveAudio(info: info, streamIndex: nil)?.streamIndex, 1)
        XCTAssertEqual(PlaybackPlanner.effectiveAudio(info: info, streamIndex: 99)?.streamIndex, 1)
    }

    func testSubtitleDefaults() {
        let audio = PlaybackPlanner.effectiveAudio(info: info, streamIndex: nil)
        XCTAssertNil(PlaybackPlanner.defaultSubtitle(info: info, enabled: false, language: "en", audio: audio))
        XCTAssertEqual(PlaybackPlanner.defaultSubtitle(info: info, enabled: true, language: "en", audio: audio)?.key, "side:0")
        XCTAssertNil(PlaybackPlanner.defaultSubtitle(info: info, enabled: true, language: "fr", audio: audio))
    }

    func testForcedSubtitleMatchingAudioIsUsedEvenWhenSubtitlesAreOff() {
        let withForced = decode(PlaybackInfo.self, """
        {"ok":true,"audio":[{"streamIndex":1,"language":"en","isDefault":true}],
         "subtitles":[{"key":"side:0","kind":"text","language":"en","forced":true,"url":"/s?i=0"},
                      {"key":"side:1","kind":"text","language":"en","forced":false,"url":"/s?i=1"}]}
        """)
        let audio = PlaybackPlanner.effectiveAudio(info: withForced, streamIndex: nil)
        XCTAssertEqual(PlaybackPlanner.defaultSubtitle(info: withForced, enabled: false, language: "en", audio: audio)?.key, "side:0")
        XCTAssertEqual(PlaybackPlanner.defaultSubtitle(info: withForced, enabled: true, language: "en", audio: audio)?.key, "side:1")
    }

    func testResolveSubtitleChoices() throws {
        let resolver: (String) -> URL? = { URL(string: "http://h:1" + $0) }
        let prefs = PlaybackPreferences(quality: .auto, subtitlesEnabled: true, subtitleLanguage: "en", audioLanguage: "")
        let audio = PlaybackPlanner.effectiveAudio(info: info, streamIndex: nil)

        guard case .overlay(let track, let url) = PlaybackPlanner.resolveSubtitle(info: info, choice: .automatic, preferences: prefs, audio: audio, resolveURL: resolver) else {
            return XCTFail("expected overlay")
        }
        XCTAssertEqual(track.key, "side:0")
        XCTAssertTrue(url.absoluteString.hasPrefix("http://h:1/subtitles/file"))

        XCTAssertEqual(PlaybackPlanner.resolveSubtitle(info: info, choice: .off, preferences: prefs, audio: audio, resolveURL: resolver), .none)

        guard case .burnedIn(let picture) = PlaybackPlanner.resolveSubtitle(info: info, choice: .track("emb:5"), preferences: prefs, audio: audio, resolveURL: resolver) else {
            return XCTFail("expected burned-in")
        }
        XCTAssertEqual(picture.streamIndex, 5)

        XCTAssertEqual(PlaybackPlanner.resolveSubtitle(info: info, choice: .track("missing"), preferences: prefs, audio: audio, resolveURL: resolver), .none)
    }

    func testLanguageCodes() {
        XCTAssertEqual(LanguageCode.twoLetter("eng"), "en")
        XCTAssertEqual(LanguageCode.twoLetter("en-US"), "en")
        XCTAssertEqual(LanguageCode.twoLetter("FR"), "fr")
        XCTAssertEqual(LanguageCode.twoLetter("deu"), "de")
        XCTAssertTrue(LanguageCode.matches("fra", "fr"))
        XCTAssertFalse(LanguageCode.matches("", ""))
        XCTAssertFalse(LanguageCode.matches("en", "fr"))
    }
}

final class ResumeAndProgressTests: XCTestCase {
    func testResumeIgnoresTinyAndFinishedPositions() {
        XCTAssertEqual(ResumePolicy.startPosition(positionSeconds: 5, durationSeconds: 6000), 0)
        XCTAssertEqual(ResumePolicy.startPosition(positionSeconds: 5800, durationSeconds: 6000), 0)
        XCTAssertEqual(ResumePolicy.startPosition(positionSeconds: 600, durationSeconds: 6000, watched: true), 0)
    }

    func testResumeRewindsAFewSeconds() {
        XCTAssertEqual(ResumePolicy.startPosition(positionSeconds: 600, durationSeconds: 6000), 597)
        XCTAssertEqual(ResumePolicy.startPosition(positionSeconds: 20, durationSeconds: 0), 17)
    }

    func testResumeFromPercent() {
        XCTAssertEqual(ResumePolicy.startPosition(percent: 50, durationSeconds: 6000), 2997, accuracy: 0.001)
        XCTAssertEqual(ResumePolicy.startPosition(percent: 0, durationSeconds: 6000), 0)
        XCTAssertEqual(ResumePolicy.startPosition(percent: 97, durationSeconds: 6000), 0)
        XCTAssertEqual(ResumePolicy.startPosition(percent: 50, durationSeconds: 0), 0)
    }

    func testProgressThrottle() {
        var tracker = ProgressTracker(interval: 10)
        XCTAssertTrue(tracker.shouldReport(now: 0))
        XCTAssertFalse(tracker.shouldReport(now: 4))
        XCTAssertFalse(tracker.shouldReport(now: 9.9))
        XCTAssertTrue(tracker.shouldReport(now: 10))
        XCTAssertFalse(tracker.shouldReport(now: 15))
        XCTAssertTrue(tracker.shouldReport(now: 16, force: true))
        XCTAssertFalse(tracker.shouldReport(now: 20))
        XCTAssertTrue(tracker.shouldReport(now: 26))
    }

    func testProgressTrackerReportsAfterClockGoesBackwards() {
        var tracker = ProgressTracker(interval: 10)
        XCTAssertTrue(tracker.shouldReport(now: 100))
        XCTAssertTrue(tracker.shouldReport(now: 50))
        tracker.reset()
        XCTAssertTrue(tracker.shouldReport(now: 51))
    }
}

final class PlaybackServiceTests: XCTestCase {
    private func transport(info: String = Fixtures.playbackInfo, start: String = Fixtures.startOK, startStatus: Int = 200) -> MockTransport {
        let t = MockTransport()
        t.route("/api/playback/info", body: info)
        t.route("/api/playback/start", method: "POST", status: startStatus, body: start)
        t.route("/api/watch-session", method: "POST", body: "{\"ok\":true,\"sessionId\":\"sess-1\"}")
        return t
    }

    private let ref = MediaRef(kind: .movie, id: "QWxpZW4", title: "Alien")

    func testPrepareBuildsHLSURLAndStartsWatchSession() async throws {
        let t = transport()
        let service = PlaybackService(api: Fixtures.api(t), preferences: PlaybackPreferences())
        let session = try await service.prepare(ref)
        XCTAssertEqual(session.hlsURL.absoluteString, "http://192.168.1.20:47811/hls/TICKET123/index.m3u8")
        XCTAssertEqual(session.ticket, "TICKET123")
        XCTAssertEqual(session.watchSessionId, "sess-1")
        XCTAssertEqual(session.durationSeconds, 7020.5, accuracy: 0.01)
        XCTAssertEqual(session.quality, "1080p")
        XCTAssertNil(session.audioStreamIndex)
        XCTAssertEqual(session.subtitle, .none)
        let body = t.jsonBody(of: try XCTUnwrap(t.requests(to: "/api/playback/start").first))
        XCTAssertEqual(body["quality"] as? String, "1080p")
        XCTAssertNil(body["audio"])
        XCTAssertNil(body["burnSubtitle"])
    }

    func testPrepareNeverAsksForRawFileURLs() async throws {
        let t = transport()
        _ = try await PlaybackService(api: Fixtures.api(t), preferences: PlaybackPreferences()).prepare(ref)
        let paths = t.requests.compactMap { $0.url?.path }
        XCTAssertFalse(paths.contains("/file"))
        XCTAssertFalse(paths.contains("/tvfile"))
        XCTAssertTrue(paths.contains("/api/playback/start"))
    }

    func testPreferredAudioLanguageSwitchesTrack() async throws {
        let t = transport()
        let prefs = PlaybackPreferences(quality: .p720, subtitlesEnabled: false, subtitleLanguage: "en", audioLanguage: "fr")
        let session = try await PlaybackService(api: Fixtures.api(t), preferences: prefs).prepare(ref)
        let body = t.jsonBody(of: try XCTUnwrap(t.requests(to: "/api/playback/start").first))
        XCTAssertEqual(body["audio"] as? Int, 2)
        XCTAssertEqual(body["quality"] as? String, "720p")
        XCTAssertEqual(session.audioStreamIndex, 2)
        XCTAssertEqual(session.effectiveAudio?.language, "fr")
    }

    func testSubtitlesEnabledUsesOverlayTrackWithAbsoluteURL() async throws {
        let t = transport()
        let prefs = PlaybackPreferences(quality: .auto, subtitlesEnabled: true, subtitleLanguage: "en", audioLanguage: "")
        let session = try await PlaybackService(api: Fixtures.api(t), preferences: prefs).prepare(ref)
        guard case .overlay(let track, let url) = session.subtitle else { return XCTFail("expected overlay") }
        XCTAssertEqual(track.key, "side:0")
        XCTAssertTrue(url.absoluteString.hasPrefix("http://192.168.1.20:47811/subtitles/file?kind=movie"))
        XCTAssertEqual(session.selection.subtitle, .track("side:0"))
    }

    func testPictureSubtitleIsBurnedIntoTheStream() async throws {
        let t = transport()
        let session = try await PlaybackService(api: Fixtures.api(t), preferences: PlaybackPreferences())
            .prepare(ref, selection: PlaybackSelection(audioStreamIndex: nil, subtitle: .track("emb:5")))
        let body = t.jsonBody(of: try XCTUnwrap(t.requests(to: "/api/playback/start").first))
        XCTAssertEqual(body["burnSubtitle"] as? Int, 5)
        guard case .burnedIn = session.subtitle else { return XCTFail("expected burned-in") }
    }

    func testReusedWatchSessionIsNotRestarted() async throws {
        let t = transport()
        let session = try await PlaybackService(api: Fixtures.api(t), preferences: PlaybackPreferences())
            .prepare(ref, reuseWatchSessionId: "old")
        XCTAssertEqual(session.watchSessionId, "old")
        XCTAssertTrue(t.requests(to: "/api/watch-session").isEmpty)
    }

    func testWatchSessionFailureDoesNotBlockPlayback() async throws {
        let t = transport()
        t.route("/api/watch-session", method: "POST", status: 500, body: "boom")
        let session = try await PlaybackService(api: Fixtures.api(t), preferences: PlaybackPreferences()).prepare(ref)
        XCTAssertNil(session.watchSessionId)
        XCTAssertFalse(session.hlsURL.absoluteString.isEmpty)
    }

    func testNoTranscoderMeansAClearRefusalAndNoStartCall() async {
        let info = "{\"ok\":true,\"durationSec\":100,\"transcode\":{\"available\":false,\"reason\":\"The converter (ffmpeg) is not installed on the PC.\"}}"
        let t = transport(info: info)
        do {
            _ = try await PlaybackService(api: Fixtures.api(t), preferences: PlaybackPreferences()).prepare(ref)
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(code: "transcode_unavailable", message: "The converter (ffmpeg) is not installed on the PC."))
        }
        XCTAssertTrue(t.requests(to: "/api/playback/start").isEmpty)
    }

    func testServerBusyBubblesUp() async {
        let t = transport(start: "{\"ok\":false,\"error\":\"busy\",\"message\":\"Busy.\"}", startStatus: 503)
        do {
            _ = try await PlaybackService(api: Fixtures.api(t), preferences: PlaybackPreferences()).prepare(ref)
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(code: "busy", message: "Busy."))
        }
    }

    func testProgressIsReportedAgainstTheWatchSession() async throws {
        let t = transport()
        t.route("/api/progress", method: "POST", body: "{\"ok\":true}")
        let service = PlaybackService(api: Fixtures.api(t), preferences: PlaybackPreferences())
        let session = try await service.prepare(ref)
        await service.reportProgress(session: session, position: 123.4)
        let body = t.jsonBody(of: try XCTUnwrap(t.requests(to: "/api/progress").first))
        XCTAssertEqual(body["sessionId"] as? String, "sess-1")
        XCTAssertEqual(body["currentTime"] as? Double, 123.4)
        XCTAssertEqual(body["duration"] as? Double, 7020.5)
    }

    func testNextUpOnlyForEpisodes() async throws {
        let t = transport()
        t.route("/api/upnext", body: "{\"ok\":true,\"next\":{\"kind\":\"tv\",\"id\":\"e2\",\"showKey\":\"s\",\"title\":\"Show S1E2\"}}")
        let service = PlaybackService(api: Fixtures.api(t), preferences: PlaybackPreferences())
        let next = await service.nextUp(after: MediaRef(kind: .tv, id: "e1", title: "Show S1E1"))
        XCTAssertEqual(next?.id, "e2")
        let none = await service.nextUp(after: ref)
        XCTAssertNil(none)
    }
}
