import Foundation

public struct PlaybackSession: Sendable {
    public let ref: MediaRef
    public let hlsURL: URL
    public let ticket: String
    public let watchSessionId: String?
    public let durationSeconds: Double
    public let info: PlaybackInfo
    public let quality: String
    public let audioStreamIndex: Int?
    public let subtitle: ActiveSubtitle

    public var audioTracks: [PlaybackAudioTrack] { info.audio }
    public var textSubtitleTracks: [PlaybackSubtitleTrack] { info.subtitles.filter(\.isText) }
    public var pictureSubtitleTracks: [PlaybackSubtitleTrack] { info.subtitles.filter(\.isPicture) }

    public var selection: PlaybackSelection {
        let choice: SubtitleChoice = subtitle.trackKey.map { .track($0) } ?? .off
        return PlaybackSelection(audioStreamIndex: audioStreamIndex, subtitle: choice)
    }

    public var effectiveAudio: PlaybackAudioTrack? {
        PlaybackPlanner.effectiveAudio(info: info, streamIndex: audioStreamIndex)
    }
}

public struct PlaybackService: Sendable {
    public let api: BeeboAPI
    public let preferences: PlaybackPreferences

    public init(api: BeeboAPI, preferences: PlaybackPreferences) {
        self.api = api
        self.preferences = preferences
    }

    public func prepare(
        _ ref: MediaRef,
        selection: PlaybackSelection = PlaybackSelection(),
        reuseWatchSessionId: String? = nil
    ) async throws -> PlaybackSession {
        let info = try await api.playbackInfo(kind: ref.kind, id: ref.id)
        guard info.ok else { throw APIError.notFound }
        guard let quality = PlaybackPlanner.chooseQuality(info: info, preference: preferences.quality) else {
            let reason = info.transcode.reason.isEmpty
                ? "This video can't be converted for Apple devices by your Beebo server right now."
                : info.transcode.reason
            throw APIError.refused(code: "transcode_unavailable", message: reason)
        }
        let audioIndex = selection.audioStreamIndex
            ?? PlaybackPlanner.audioOverride(info: info, preferredLanguage: preferences.audioLanguage)
        let audio = PlaybackPlanner.effectiveAudio(info: info, streamIndex: audioIndex)
        let subtitle = PlaybackPlanner.resolveSubtitle(
            info: info,
            choice: selection.subtitle,
            preferences: preferences,
            audio: audio,
            resolveURL: { api.absoluteURL($0) }
        )
        var burn: Int?
        if case .burnedIn(let track) = subtitle { burn = track.streamIndex }
        let start = try await api.playbackStart(
            kind: ref.kind, id: ref.id, quality: quality,
            audioStreamIndex: audioIndex, burnSubtitleStreamIndex: burn
        )
        guard let hls = api.absoluteURL(start.url) else { throw APIError.badResponse }
        var watchId = reuseWatchSessionId
        if watchId == nil {
            watchId = (try? await api.startWatchSession(kind: ref.kind, id: ref.id)) ?? nil
        }
        let duration = start.durationSec > 0 ? start.durationSec : info.durationSec
        return PlaybackSession(
            ref: ref, hlsURL: hls, ticket: start.ticket, watchSessionId: watchId,
            durationSeconds: duration, info: info, quality: start.quality.isEmpty ? quality : start.quality,
            audioStreamIndex: audioIndex, subtitle: subtitle
        )
    }

    public func loadSubtitleCues(from url: URL) async -> [SubtitleCue] {
        guard let text = try? await api.fetchText(url) else { return [] }
        return WebVTT.parse(text)
    }

    public func reportProgress(session: PlaybackSession, position: Double) async {
        guard let id = session.watchSessionId, session.durationSeconds > 0 else { return }
        try? await api.reportProgress(sessionId: id, currentTime: position, duration: session.durationSeconds)
    }

    public func nextUp(after ref: MediaRef) async -> MediaRef? {
        guard ref.kind == .tv, let response = try? await api.upNext(kind: ref.kind, id: ref.id), let next = response.next, !next.id.isEmpty else {
            return nil
        }
        return next.ref
    }
}
