import Foundation
import XCTest
@testable import BeeboKit

/// The device profile and the negotiate flow (docs/HOME-THEATER.md). UNVERIFIED on a device: these prove the declaration and the
/// decisions in code, not what AVPlayer really plays.
final class DeviceProfileTests: XCTestCase {
    private func fourK(platform: DeviceCapabilities.Platform = .tvOS) -> DeviceCapabilities {
        DeviceCapabilities(
            platform: platform, deviceName: "Living room", hardwareHEVC: true, hardwareAV1: false,
            hdr10: true, hlg: true, dolbyVision: true, maxHeight: 2160, outputChannels: 8, spatialAudio: true
        )
    }

    private func dict(_ value: Any?) -> [String: Any] {
        (value as? [String: Any]) ?? [:]
    }

    func testFourKAppleTVDeclaration() throws {
        let p = DeviceProfile.declaration(fourK())
        XCTAssertEqual(p["client"] as? String, "appletv")
        XCTAssertEqual(p["v"] as? Int, 1)
        XCTAssertEqual(p["name"] as? String, "Living room")
        let video = dict(p["video"])
        XCTAssertEqual(Set(video.keys), ["h264", "hevc"])
        XCTAssertEqual(dict(video["hevc"])["bitDepths"] as? [Int], [8, 10])
        XCTAssertEqual(dict(video["h264"])["maxLevel"] as? Int, 52)
        XCTAssertEqual(p["hdr"] as? [String], ["hdr10", "hlg", "dv:5,8"])
        XCTAssertEqual(p["maxHeight"] as? Int, 2160)
        XCTAssertEqual(p["maxWidth"] as? Int, 3840)
        XCTAssertEqual(p["containers"] as? [String], ["mp4", "mov"])
        XCTAssertEqual(p["streaming"] as? [String], ["hls-fmp4", "hls-ts"])
        XCTAssertEqual(p["subtitles"] as? [String], ["vtt"])
        XCTAssertTrue(JSONSerialization.isValidJSONObject(p), "the declaration must be sendable as JSON")
    }

    func testMatroskaIsNeverClaimed() {
        for caps in [fourK(), DeviceCapabilities(platform: .iOS)] {
            let containers = DeviceProfile.declaration(caps)["containers"] as? [String] ?? []
            XCTAssertFalse(containers.contains("mkv"))
            XCTAssertFalse(containers.contains("webm"))
        }
    }

    func testTrueHDAndDTSAreNeverListed() {
        let audio = dict(DeviceProfile.declaration(fourK())["audio"])
        for key in ["truehd", "dts", "dtshd", "dtsx"] {
            XCTAssertNil(audio[key], key)
        }
        for value in audio.values {
            XCTAssertNil(dict(value)["passthrough"], "no receiver passthrough is claimed")
        }
    }

    func testAtmosOnlyWhenTheRouteRendersIt() {
        var caps = fourK()
        XCTAssertEqual(dict(dict(DeviceProfile.declaration(caps)["audio"])["eac3"])["atmos"] as? Bool, true)
        caps.spatialAudio = false
        XCTAssertNil(dict(dict(DeviceProfile.declaration(caps)["audio"])["eac3"])["atmos"])
    }

    func testHDRIsOnlyWhatTheScreenReported() {
        var caps = fourK()
        caps.dolbyVision = false
        XCTAssertEqual(DeviceProfile.declaration(caps)["hdr"] as? [String], ["hdr10", "hlg"])
        caps.hdr10 = false
        caps.hlg = false
        XCTAssertEqual(DeviceProfile.declaration(caps)["hdr"] as? [String], [], "an SDR screen says SDR")
        let text = String(describing: DeviceProfile.declaration(fourK()))
        XCTAssertFalse(text.contains("hdr10plus"), "HDR10+ is never claimed")
        XCTAssertFalse(text.contains("dv:7"), "Dolby Vision profile 7 is never claimed")
    }

    func testDeviceWithoutHEVCHardwareListsOnlyH264AtOneEightyP() {
        let caps = DeviceCapabilities(platform: .iOS, deviceName: "Old iPhone", hardwareHEVC: false)
        let p = DeviceProfile.declaration(caps)
        XCTAssertEqual(p["client"] as? String, "ios")
        XCTAssertEqual(Set(dict(p["video"]).keys), ["h264"])
        XCTAssertEqual(dict(dict(p["video"])["h264"])["maxLevel"] as? Int, 42)
        XCTAssertEqual(p["maxHeight"] as? Int, 1080)
        XCTAssertNil(p["maxWidth"])
        XCTAssertEqual(p["hdr"] as? [String], [])
    }

    func testAV1OnlyWhenTheHardwareHasIt() {
        var caps = fourK()
        XCTAssertNil(dict(DeviceProfile.declaration(caps)["video"])["av1"])
        caps.hardwareAV1 = true
        XCTAssertNotNil(dict(DeviceProfile.declaration(caps)["video"])["av1"])
    }

    func testBareAndSummary() {
        let bare = DeviceProfile.bare(.tvOS)
        XCTAssertEqual(bare["client"] as? String, "appletv")
        XCTAssertNil(bare["video"])
        XCTAssertEqual(DeviceProfile.summary(DeviceProfile.declaration(fourK())), "h264 hevc · hdr10 hlg dv:5,8 · 2160p")
        XCTAssertNil(DeviceProfile.declaration(DeviceCapabilities(platform: .tvOS, deviceName: "   "))["name"], "a blank name is left out")
    }
}

final class NegotiateTests: XCTestCase {
    private let ref = MediaRef(kind: .movie, id: "QWxpZW4", title: "Alien")
    private let profile = DeviceProfileDeclaration(DeviceProfile.declaration(
        DeviceCapabilities(platform: .tvOS, deviceName: "Den", hardwareHEVC: true, hdr10: true, maxHeight: 2160)
    ))

    private func infoWithHomeTheater(_ block: String = "{\"badges\":[\"4K\",\"HDR10\"]}") -> String {
        Fixtures.playbackInfo.replacingOccurrences(of: "\"ok\":true,", with: "\"ok\":true,\"homeTheater\":\(block),")
    }

    private func transport(info: String, negotiateStatus: Int = 200, negotiate: String) -> MockTransport {
        let t = MockTransport()
        t.route("/api/playback/info", body: info)
        t.route("/api/playback/negotiate", method: "POST", status: negotiateStatus, body: negotiate)
        t.route("/api/playback/start", method: "POST", body: Fixtures.startOK)
        t.route("/api/watch-session", method: "POST", body: "{\"ok\":true,\"sessionId\":\"sess-1\"}")
        return t
    }

    private func service(_ t: MockTransport, profile: DeviceProfileDeclaration?, quality: QualityPreference = .auto, attempts: Int = 3) -> PlaybackService {
        PlaybackService(
            api: Fixtures.api(t), preferences: PlaybackPreferences(quality: quality),
            deviceProfile: profile, maxPrepareAttempts: attempts, pause: { _ in }
        )
    }

    private static let directPlay = "{\"ok\":true,\"method\":\"DirectPlay\",\"url\":\"/file?id=QWxpZW4&mt=T\",\"mimeType\":\"video/x-matroska\",\"durationSec\":7020.5,\"container\":\"mkv\",\"plan\":{\"reasonCodes\":[]}}"
    private static let directStream = "{\"ok\":true,\"method\":\"DirectStream\",\"url\":\"/hls/T9/master.m3u8\",\"ticket\":\"T9\",\"container\":\"hls-fmp4\",\"durationSec\":7020.5}"

    func testInfoCarriesTheHomeTheaterBlock() {
        XCTAssertNil(decode(PlaybackInfo.self, Fixtures.playbackInfo).homeTheater)
        XCTAssertEqual(decode(PlaybackInfo.self, infoWithHomeTheater()).homeTheater?.badges, ["4K", "HDR10"])
    }

    func testDirectPlayUsesTheFileAndNeverStartsAConversion() async throws {
        let t = transport(info: infoWithHomeTheater(), negotiate: Self.directPlay)
        let session = try await service(t, profile: profile).prepare(ref)
        XCTAssertEqual(session.method, .directPlay)
        XCTAssertEqual(session.hlsURL.absoluteString, "http://192.168.1.20:47811/file?id=QWxpZW4&mt=T")
        XCTAssertEqual(session.ticket, "")
        XCTAssertEqual(session.badges, ["4K", "HDR10"])
        XCTAssertEqual(session.durationSeconds, 7020.5, accuracy: 0.01)
        XCTAssertEqual(session.watchSessionId, "sess-1")
        XCTAssertTrue(t.requests(to: "/api/playback/start").isEmpty)
    }

    func testTheProfileTravelsInTheBodyWithTheBearerToken() async throws {
        let t = transport(info: infoWithHomeTheater(), negotiate: Self.directPlay)
        _ = try await service(t, profile: profile).prepare(ref)
        let request = try XCTUnwrap(t.requests(to: "/api/playback/negotiate").first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Beebo-Device-Profile"))
        let body = t.jsonBody(of: request)
        XCTAssertEqual(body["kind"] as? String, "movie")
        XCTAssertEqual(body["id"] as? String, "QWxpZW4")
        XCTAssertEqual(body["client"] as? String, "appletv")
        XCTAssertEqual(body["quality"] as? String, "original", "best available means the file as it is")
        let sent = try XCTUnwrap(body["deviceProfile"] as? [String: Any])
        XCTAssertEqual(sent["hdr"] as? [String], ["hdr10"])
        XCTAssertNil(body["audio"])
    }

    func testAnExplicitQualityCapsThePicture() async throws {
        let t = transport(info: infoWithHomeTheater(), negotiate: Self.directPlay)
        _ = try await service(t, profile: profile, quality: .p720).prepare(ref)
        XCTAssertEqual(t.jsonBody(of: try XCTUnwrap(t.requests(to: "/api/playback/negotiate").first))["quality"] as? String, "720p")
    }

    func testDirectStreamKeepsItsTicket() async throws {
        let t = transport(info: infoWithHomeTheater(), negotiate: Self.directStream)
        let session = try await service(t, profile: profile).prepare(ref)
        XCTAssertEqual(session.method, .directStream)
        XCTAssertEqual(session.hlsURL.absoluteString, "http://192.168.1.20:47811/hls/T9/master.m3u8")
        XCTAssertEqual(session.ticket, "T9")
    }

    func testAnOlderServerKeepsTheConversionEvenWithAProfile() async throws {
        let t = transport(info: Fixtures.playbackInfo, negotiate: Self.directPlay)
        let session = try await service(t, profile: profile).prepare(ref)
        XCTAssertEqual(session.method, .transcode)
        XCTAssertEqual(session.ticket, "TICKET123")
        XCTAssertTrue(t.requests(to: "/api/playback/negotiate").isEmpty, "no negotiation without the homeTheater block")
        XCTAssertTrue(session.badges.isEmpty)
    }

    func testNoProfileMeansTheConversion() async throws {
        let t = transport(info: infoWithHomeTheater(), negotiate: Self.directPlay)
        let session = try await service(t, profile: nil).prepare(ref)
        XCTAssertEqual(session.method, .transcode)
        XCTAssertTrue(t.requests(to: "/api/playback/negotiate").isEmpty)
    }

    func testAChosenAudioTrackGoesThroughTheConversion() async throws {
        let t = transport(info: infoWithHomeTheater(), negotiate: Self.directPlay)
        let session = try await service(t, profile: profile).prepare(ref, selection: PlaybackSelection(audioStreamIndex: 2, subtitle: .off))
        XCTAssertEqual(session.method, .transcode)
        XCTAssertEqual(t.jsonBody(of: try XCTUnwrap(t.requests(to: "/api/playback/start").first))["audio"] as? Int, 2)
        XCTAssertTrue(t.requests(to: "/api/playback/negotiate").isEmpty)
    }

    func testABurnedInSubtitleGoesThroughTheConversion() async throws {
        let t = transport(info: infoWithHomeTheater(), negotiate: Self.directPlay)
        let session = try await service(t, profile: profile).prepare(ref, selection: PlaybackSelection(audioStreamIndex: nil, subtitle: .track("emb:5")))
        XCTAssertEqual(session.method, .transcode)
        XCTAssertTrue(t.requests(to: "/api/playback/negotiate").isEmpty)
    }

    func testAfterADirectPlayFailedTheConversionIsUsed() async throws {
        let t = transport(info: infoWithHomeTheater(), negotiate: Self.directPlay)
        let session = try await service(t, profile: profile).prepare(ref, allowDirect: false)
        XCTAssertEqual(session.method, .transcode)
        XCTAssertTrue(t.requests(to: "/api/playback/negotiate").isEmpty)
    }

    func testAHostileAnswerFallsBackToTheConversion() async throws {
        let hostile = [
            "{\"ok\":true,\"method\":\"DirectPlay\",\"url\":\"http://evil.example/file?id=a\"}",
            "{\"ok\":true,\"method\":\"DirectPlay\",\"url\":\"//evil.example/file?id=a\"}",
            "{\"ok\":true,\"method\":\"DirectPlay\",\"url\":\"/api/admin/settings\"}",
            "{\"ok\":true,\"method\":\"DirectPlay\",\"url\":\"/hls/T/index.m3u8\"}",
            "{\"ok\":true,\"method\":\"DirectStream\",\"url\":\"/file?id=a\"}",
            "{\"ok\":true,\"method\":\"DirectStream\",\"url\":\"/hls/../x.m3u8\"}",
            "{\"ok\":true,\"method\":\"Teleport\",\"url\":\"/file?id=a\"}",
        ]
        for answer in hostile {
            let t = transport(info: infoWithHomeTheater(), negotiate: answer)
            let session = try await service(t, profile: profile).prepare(ref)
            XCTAssertEqual(session.method, .transcode, answer)
            XCTAssertEqual(session.ticket, "TICKET123", answer)
        }
    }

    func testPreparingIsAskedAgainThenGivenUp() async throws {
        let preparing = "{\"ok\":false,\"error\":\"preparing\",\"retryAfterSec\":3}"
        let t = transport(info: infoWithHomeTheater(), negotiateStatus: 503, negotiate: preparing)
        let session = try await service(t, profile: profile, attempts: 3).prepare(ref)
        XCTAssertEqual(t.requests(to: "/api/playback/negotiate").count, 3)
        XCTAssertEqual(session.method, .transcode, "after the last try the plain conversion plays it")
    }

    func testARefusalIsShownNotHidden() async {
        let t = transport(info: infoWithHomeTheater(), negotiateStatus: 404, negotiate: "{\"ok\":false,\"error\":\"not_found\"}")
        do {
            _ = try await service(t, profile: profile).prepare(ref)
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(code: "not_found", message: "That video isn't in the library any more."))
        }
    }

    func testUnauthorizedSignsOut() async {
        let t = transport(info: infoWithHomeTheater(), negotiateStatus: 401, negotiate: "{\"ok\":false}")
        do {
            _ = try await service(t, profile: profile).prepare(ref)
            XCTFail("expected unauthorized")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
    }

    func testDirectPlayNeedsNoTranscoder() async throws {
        let info = infoWithHomeTheater().replacingOccurrences(of: "\"available\":true", with: "\"available\":false")
        let t = transport(info: info, negotiate: Self.directPlay)
        let session = try await service(t, profile: profile).prepare(ref)
        XCTAssertEqual(session.method, .directPlay)
    }

    func testMethodLabels() {
        XCTAssertEqual(PlaybackMethod.directPlay.label, "Direct play")
        XCTAssertEqual(PlaybackMethod.directStream.label, "Direct stream")
        XCTAssertEqual(PlaybackMethod.transcode.label, "Converted")
        XCTAssertEqual(NegotiateRules.quality(for: .auto), "original")
        XCTAssertEqual(NegotiateRules.quality(for: .p1080), "1080p")
    }
}
