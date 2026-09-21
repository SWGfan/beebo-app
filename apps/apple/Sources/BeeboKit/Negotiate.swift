import Foundation

/// The declaration as a value that can cross concurrency domains (a JSON-compatible dictionary that is never mutated).
public struct DeviceProfileDeclaration: @unchecked Sendable {
    public let object: [String: Any]

    public init(_ object: [String: Any]) {
        self.object = object
    }

    public var client: String { (object["client"] as? String) ?? "" }
}

/// How a title reaches the screen (docs/HOME-THEATER.md, section 3).
public enum PlaybackMethod: String, Equatable, Sendable {
    /// The original file, HTTP range requests, nothing converted.
    case directPlay = "DirectPlay"
    /// The picture (HDR and Dolby Vision included) copied into fragmented-MP4 HLS.
    case directStream = "DirectStream"
    /// The live H.264 / AAC conversion (what `POST /api/playback/start` makes).
    case transcode = "Transcode"

    public var label: String {
        switch self {
        case .directPlay: return "Direct play"
        case .directStream: return "Direct stream"
        case .transcode: return "Converted"
        }
    }
}

/// The answer of `POST /api/playback/negotiate`: a plan and the address that plays it.
public struct NegotiatedPlan: Decodable, Sendable {
    public let ok: Bool
    public let method: String
    public let url: String
    public let ticket: String
    public let mimeType: String
    public let container: String
    public let durationSec: Double
    public let error: String?
    public let message: String?
    public let retryAfterSec: Double?
    public let reasonCodes: [String]

    private enum CodingKeys: String, CodingKey {
        case ok, method, url, ticket, mimeType, container, durationSec, error, message, retryAfterSec, plan
    }

    private struct PlanBlock: Decodable {
        let reasonCodes: [String]

        private enum CodingKeys: String, CodingKey { case reasonCodes }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            reasonCodes = c.lenient(.reasonCodes, [])
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        method = c.lenient(.method, "")
        url = c.lenient(.url, "")
        ticket = c.lenient(.ticket, "")
        mimeType = c.lenient(.mimeType, "")
        container = c.lenient(.container, "")
        durationSec = c.lenient(.durationSec, 0.0)
        error = c.lenientOptional(.error)
        message = c.lenientOptional(.message)
        retryAfterSec = c.lenientOptional(.retryAfterSec)
        let block: PlanBlock? = c.lenientOptional(.plan)
        reasonCodes = block?.reasonCodes ?? []
    }

    public var playbackMethod: PlaybackMethod? { PlaybackMethod(rawValue: method) }

    /// Only the three plans on their own routes are followed: an answer that points anywhere else is ignored (the caller
    /// then uses the plain conversion), so a wrong or hostile reply can never send the player somewhere unexpected.
    public var isFollowable: Bool {
        guard ok, let method = playbackMethod, !url.isEmpty, url.hasPrefix("/") else { return false }
        if url.hasPrefix("//") || url.contains("\\") || url.contains("..") || url.contains("\n") { return false }
        switch method {
        case .directPlay:
            return url.hasPrefix("/file?") || url.hasPrefix("/tvfile?")
        case .directStream, .transcode:
            return url.hasPrefix("/hls/") && url.contains(".m3u8")
        }
    }
}

public enum NegotiateOutcome: Sendable {
    case plan(NegotiatedPlan)
    /// 503 `preparing`: a big film is being read once so it can be streamed without converting it. Ask again.
    case preparing(retryAfter: Double)
}

/// The `homeTheater` block of `GET /api/playback/info`. Its presence is the feature test: an older server has none, and the app
/// then keeps using `POST /api/playback/start`. `badges` are the file's own labels ("4K", "Dolby Vision", "Atmos").
public struct HomeTheaterInfo: Decodable, Sendable {
    public let badges: [String]

    private enum CodingKeys: String, CodingKey { case badges }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        badges = c.lenient(.badges, [])
    }
}

public enum NegotiateRules {
    /// "auto" means "the best way to play the file as it is"; an explicit quality caps the picture.
    public static func quality(for preference: QualityPreference) -> String {
        preference == .auto ? "original" : preference.rawValue
    }

    /// Whether this playback can be negotiated. A chosen audio track, or a picture subtitle that must be burnt in, goes through
    /// the conversion (a direct play cannot switch tracks on every player), and so does everything after a direct play or
    /// direct stream already failed on this device.
    public static func canNegotiate(
        info: PlaybackInfo,
        audioStreamIndex: Int?,
        burnSubtitle: Bool,
        allowDirect: Bool,
        hasProfile: Bool
    ) -> Bool {
        info.homeTheater != nil && hasProfile && allowDirect && audioStreamIndex == nil && !burnSubtitle
    }
}
