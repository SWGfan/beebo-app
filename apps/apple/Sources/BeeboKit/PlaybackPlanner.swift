import Foundation

public enum SubtitleChoice: Equatable, Sendable {
    case automatic
    case off
    case track(String)
}

public struct PlaybackSelection: Equatable, Sendable {
    public var audioStreamIndex: Int?
    public var subtitle: SubtitleChoice

    public init(audioStreamIndex: Int? = nil, subtitle: SubtitleChoice = .automatic) {
        self.audioStreamIndex = audioStreamIndex
        self.subtitle = subtitle
    }
}

public enum ActiveSubtitle: Equatable, Sendable {
    case none
    case overlay(PlaybackSubtitleTrack, URL)
    case burnedIn(PlaybackSubtitleTrack)

    public var trackKey: String? {
        switch self {
        case .none: return nil
        case .overlay(let track, _): return track.key
        case .burnedIn(let track): return track.key
        }
    }
}

public enum PlaybackPlanner {
    private static let qualityOrder = ["1080p", "720p", "480p"]

    public static func chooseQuality(info: PlaybackInfo, preference: QualityPreference) -> String? {
        guard info.transcode.available else { return nil }
        var offered = info.qualities.filter { !$0.upscale }.map(\.id).filter { qualityOrder.contains($0) }
        if offered.isEmpty { offered = info.qualities.map(\.id).filter { qualityOrder.contains($0) } }
        if offered.isEmpty { offered = qualityOrder }
        offered.sort { (qualityOrder.firstIndex(of: $0) ?? 99) < (qualityOrder.firstIndex(of: $1) ?? 99) }
        guard preference != .auto else { return offered.first }
        let wanted = preference.rawValue
        if offered.contains(wanted) { return wanted }
        let wantedIndex = qualityOrder.firstIndex(of: wanted) ?? 0
        if let lower = offered.first(where: { (qualityOrder.firstIndex(of: $0) ?? 0) >= wantedIndex }) { return lower }
        return offered.last
    }

    public static func audioOverride(info: PlaybackInfo, preferredLanguage: String) -> Int? {
        guard !preferredLanguage.isEmpty, info.audio.count > 1 else { return nil }
        guard let match = info.audio.first(where: { LanguageCode.matches($0.language, preferredLanguage) }) else { return nil }
        let current = info.audio.first(where: { $0.isDefault }) ?? info.audio.first
        return match.streamIndex == current?.streamIndex ? nil : match.streamIndex
    }

    public static func effectiveAudio(info: PlaybackInfo, streamIndex: Int?) -> PlaybackAudioTrack? {
        if let streamIndex, let track = info.audio.first(where: { $0.streamIndex == streamIndex }) { return track }
        return info.audio.first(where: { $0.isDefault }) ?? info.audio.first
    }

    public static func defaultSubtitle(
        info: PlaybackInfo,
        enabled: Bool,
        language: String,
        audio: PlaybackAudioTrack?
    ) -> PlaybackSubtitleTrack? {
        let texts = info.subtitles.filter(\.isText)
        if enabled {
            let inLanguage = texts.filter { LanguageCode.matches($0.language, language) }
            return inLanguage.first(where: { !$0.forced && !$0.hearingImpaired })
                ?? inLanguage.first(where: { !$0.forced })
                ?? inLanguage.first
        }
        guard let audio, !audio.language.isEmpty else { return nil }
        return texts.first(where: { $0.forced && LanguageCode.matches($0.language, audio.language) })
    }

    public static func resolveSubtitle(
        info: PlaybackInfo,
        choice: SubtitleChoice,
        preferences: PlaybackPreferences,
        audio: PlaybackAudioTrack?,
        resolveURL: (String) -> URL?
    ) -> ActiveSubtitle {
        let track: PlaybackSubtitleTrack?
        switch choice {
        case .off:
            track = nil
        case .track(let key):
            track = info.subtitles.first(where: { $0.key == key })
        case .automatic:
            track = defaultSubtitle(info: info, enabled: preferences.subtitlesEnabled, language: preferences.subtitleLanguage, audio: audio)
        }
        guard let track else { return .none }
        if track.isText, let url = resolveURL(track.url) { return .overlay(track, url) }
        if track.isPicture { return .burnedIn(track) }
        return .none
    }
}

public enum ResumePolicy {
    public static let minimumSeconds: Double = 15
    public static let finishedFraction: Double = 0.95
    public static let rewindSeconds: Double = 3

    public static func startPosition(positionSeconds: Double, durationSeconds: Double, watched: Bool = false) -> Double {
        if watched { return 0 }
        guard positionSeconds >= minimumSeconds else { return 0 }
        if durationSeconds > 0, positionSeconds / durationSeconds >= finishedFraction { return 0 }
        return max(0, positionSeconds - rewindSeconds)
    }

    public static func startPosition(percent: Int, durationSeconds: Double) -> Double {
        guard durationSeconds > 0, percent > 0, percent < 95 else { return 0 }
        return startPosition(positionSeconds: durationSeconds * Double(percent) / 100, durationSeconds: durationSeconds)
    }
}

public struct ProgressTracker: Equatable, Sendable {
    public var interval: Double
    private var lastReportedAt: Double?

    public init(interval: Double = 10) {
        self.interval = interval
    }

    public mutating func shouldReport(now: Double, force: Bool = false) -> Bool {
        if force {
            lastReportedAt = now
            return true
        }
        guard let last = lastReportedAt else {
            lastReportedAt = now
            return true
        }
        if now - last >= interval || now < last {
            lastReportedAt = now
            return true
        }
        return false
    }

    public mutating func reset() {
        lastReportedAt = nil
    }
}
