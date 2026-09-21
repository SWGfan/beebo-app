import Foundation

public struct PlaybackVideo: Decodable, Hashable, Sendable {
    public let codec: String?
    public let width: Int?
    public let height: Int?
    public let hdr: Bool

    private enum CodingKeys: String, CodingKey { case codec, width, height, hdr }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        codec = c.lenientOptional(.codec)
        width = c.lenientOptional(.width)
        height = c.lenientOptional(.height)
        hdr = c.lenient(.hdr, false)
    }
}

public struct PlaybackQuality: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let label: String
    public let height: Int
    public let videoKbps: Int
    public let upscale: Bool

    private enum CodingKeys: String, CodingKey { case id, label, height, videoKbps, upscale }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id, "")
        label = c.lenient(.label, "")
        height = c.lenient(.height, 0)
        videoKbps = c.lenient(.videoKbps, 0)
        upscale = c.lenient(.upscale, false)
    }
}

public struct PlaybackTranscode: Decodable, Hashable, Sendable {
    public let available: Bool
    public let encoderLabel: String
    public let reason: String

    private enum CodingKeys: String, CodingKey { case available, encoderLabel, reason }

    public static let unknown = PlaybackTranscode(available: false, encoderLabel: "", reason: "")

    public init(available: Bool, encoderLabel: String, reason: String) {
        self.available = available
        self.encoderLabel = encoderLabel
        self.reason = reason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = c.lenient(.available, false)
        encoderLabel = c.lenient(.encoderLabel, "")
        reason = c.lenient(.reason, "")
    }
}

public struct PlaybackAudioTrack: Decodable, Hashable, Identifiable, Sendable {
    public let ordinal: Int
    public let streamIndex: Int
    public let label: String
    public let language: String
    public let codec: String?
    public let channels: Int?
    public let isDefault: Bool

    public var id: Int { streamIndex }

    private enum CodingKeys: String, CodingKey { case ordinal, streamIndex, label, language, codec, channels, isDefault }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ordinal = c.lenient(.ordinal, 0)
        streamIndex = c.lenient(.streamIndex, -1)
        label = c.lenient(.label, "")
        language = c.lenient(.language, "")
        codec = c.lenientOptional(.codec)
        channels = c.lenientOptional(.channels)
        isDefault = c.lenient(.isDefault, false)
    }

    public var displayName: String {
        if !label.isEmpty { return label }
        if !language.isEmpty { return language.uppercased() }
        return "Track \(ordinal + 1)"
    }
}

public struct PlaybackSubtitleTrack: Decodable, Hashable, Identifiable, Sendable {
    public let key: String
    public let source: String
    public let kind: String
    public let label: String
    public let language: String
    public let streamIndex: Int?
    public let forced: Bool
    public let hearingImpaired: Bool
    public let url: String

    public var id: String { key }

    private enum CodingKeys: String, CodingKey {
        case key, source, kind, label, language, streamIndex, forced, hearingImpaired, url
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lenient(.key, "")
        source = c.lenient(.source, "sidecar")
        kind = c.lenient(.kind, "text")
        label = c.lenient(.label, "Subtitles")
        language = c.lenient(.language, "")
        streamIndex = c.lenientOptional(.streamIndex)
        forced = c.lenient(.forced, false)
        hearingImpaired = c.lenient(.hearingImpaired, false)
        url = c.lenient(.url, "")
    }

    public var isText: Bool { kind == "text" && !url.isEmpty }
    public var isPicture: Bool { kind == "image" && streamIndex != nil }
}

public struct PlaybackPrefs: Decodable, Hashable, Sendable {
    public let quality: String
    public let audioLanguage: String
    public let subtitleLanguage: String
    public let subtitlesOn: Bool

    private enum CodingKeys: String, CodingKey { case quality, audioLanguage, subtitleLanguage, subtitlesOn }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        quality = c.lenient(.quality, "auto")
        audioLanguage = c.lenient(.audioLanguage, "")
        subtitleLanguage = c.lenient(.subtitleLanguage, "")
        subtitlesOn = c.lenient(.subtitlesOn, false)
    }
}

public struct PlaybackInfo: Decodable, Sendable {
    public let ok: Bool
    public let durationSec: Double
    public let video: PlaybackVideo?
    public let qualities: [PlaybackQuality]
    public let transcode: PlaybackTranscode
    public let audio: [PlaybackAudioTrack]
    public let subtitles: [PlaybackSubtitleTrack]
    public let prefs: PlaybackPrefs?

    private enum CodingKeys: String, CodingKey {
        case ok, durationSec, video, qualities, transcode, audio, subtitles, prefs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        durationSec = c.lenient(.durationSec, 0.0)
        video = c.lenientOptional(.video)
        qualities = c.lossyList(.qualities)
        transcode = c.lenientOptional(.transcode) ?? .unknown
        audio = c.lossyList(.audio)
        subtitles = c.lossyList(.subtitles)
        prefs = c.lenientOptional(.prefs)
    }

    init(
        ok: Bool = true,
        durationSec: Double = 0,
        video: PlaybackVideo? = nil,
        qualities: [PlaybackQuality] = [],
        transcode: PlaybackTranscode = .unknown,
        audio: [PlaybackAudioTrack] = [],
        subtitles: [PlaybackSubtitleTrack] = [],
        prefs: PlaybackPrefs? = nil
    ) {
        self.ok = ok
        self.durationSec = durationSec
        self.video = video
        self.qualities = qualities
        self.transcode = transcode
        self.audio = audio
        self.subtitles = subtitles
        self.prefs = prefs
    }
}

public struct PlaybackStartResponse: Decodable, Sendable {
    public let ok: Bool
    public let error: String?
    public let message: String?
    public let url: String
    public let ticket: String
    public let quality: String
    public let height: Int
    public let durationSec: Double

    private enum CodingKeys: String, CodingKey { case ok, error, message, url, ticket, quality, height, durationSec }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        error = c.lenientOptional(.error)
        message = c.lenientOptional(.message)
        url = c.lenient(.url, "")
        ticket = c.lenient(.ticket, "")
        quality = c.lenient(.quality, "")
        height = c.lenient(.height, 0)
        durationSec = c.lenient(.durationSec, 0.0)
    }
}
