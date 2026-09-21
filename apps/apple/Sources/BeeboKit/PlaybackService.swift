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
    /// How the title reaches the screen. `.transcode` for the plain conversion (older servers, and the fallback).
    public let method: PlaybackMethod
    /// The file's own labels from the server ("4K", "Dolby Vision", "Atmos"); empty on an older server.
    public let badges: [String]

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
    /// What this device can play (see `DeviceProfile`). Nil: always use the plain conversion.
    public let deviceProfile: DeviceProfileDeclaration?
    /// How often a "preparing" answer is asked again (about 3 s each) before the plain conversion is used instead.
    public let maxPrepareAttempts: Int
    private let pause: @Sendable (Double) async -> Void

    public init(
        api: BeeboAPI,
        preferences: PlaybackPreferences,
        deviceProfile: DeviceProfileDeclaration? = nil,
        maxPrepareAttempts: Int = 8,
        pause: @escaping @Sendable (Double) async -> Void = { seconds in
            _ = try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    ) {
        self.api = api
        self.preferences = preferences
        self.deviceProfile = deviceProfile
        self.maxPrepareAttempts = maxPrepareAttempts
        self.pause = pause
    }

    /// `allowDirect: false` skips the negotiation and uses the plain conversion (used after a direct play or a direct stream
    /// could not be played on this device).
    public func prepare(
        _ ref: MediaRef,
        selection: PlaybackSelection = PlaybackSelection(),
        reuseWatchSessionId: String? = nil,
        allowDirect: Bool = true
    ) async throws -> PlaybackSession {
        let info = try await api.playbackInfo(kind: ref.kind, id: ref.id)
        guard info.ok else { throw APIError.notFound }
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

        var stream: (url: URL, ticket: String, method: PlaybackMethod, quality: String, duration: Double)?
        if let profile = deviceProfile,
           NegotiateRules.canNegotiate(info: info, audioStreamIndex: audioIndex, burnSubtitle: burn != nil, allowDirect: allowDirect, hasProfile: true) {
            stream = try await negotiate(ref, profile: profile)
        }
        if stream == nil {
            guard let quality = PlaybackPlanner.chooseQuality(info: info, preference: preferences.quality) else {
                let reason = info.transcode.reason.isEmpty
                    ? "This video can't be converted for Apple devices by your Beebo server right now."
                    : info.transcode.reason
                throw APIError.refused(code: "transcode_unavailable", message: reason)
            }
            let start = try await api.playbackStart(
                kind: ref.kind, id: ref.id, quality: quality,
                audioStreamIndex: audioIndex, burnSubtitleStreamIndex: burn
            )
            guard let hls = api.absoluteURL(start.url) else { throw APIError.badResponse }
            stream = (hls, start.ticket, .transcode, start.quality.isEmpty ? quality : start.quality, start.durationSec)
        }
        guard let chosen = stream else { throw APIError.badResponse }

        var watchId = reuseWatchSessionId
        if watchId == nil {
            watchId = (try? await api.startWatchSession(kind: ref.kind, id: ref.id)) ?? nil
        }
        let duration = chosen.duration > 0 ? chosen.duration : info.durationSec
        return PlaybackSession(
            ref: ref, hlsURL: chosen.url, ticket: chosen.ticket, watchSessionId: watchId,
            durationSeconds: duration, info: info, quality: chosen.quality,
            audioStreamIndex: audioIndex, subtitle: subtitle,
            method: chosen.method, badges: info.homeTheater?.badges ?? []
        )
    }

    /// Asks the server how to play this title for this device. Returns nil when the answer cannot be followed (the caller then uses
    /// the plain conversion); "preparing" is asked again a few times.
    private func negotiate(
        _ ref: MediaRef,
        profile: DeviceProfileDeclaration
    ) async throws -> (url: URL, ticket: String, method: PlaybackMethod, quality: String, duration: Double)? {
        var attempt = 0
        while true {
            let outcome: NegotiateOutcome
            do {
                outcome = try await api.playbackNegotiate(
                    kind: ref.kind, id: ref.id, quality: NegotiateRules.quality(for: preferences.quality), profile: profile
                )
            } catch APIError.badResponse {
                return nil
            }
            switch outcome {
            case .plan(let plan):
                guard let method = plan.playbackMethod, let url = api.absoluteURL(plan.url) else { return nil }
                return (url, plan.ticket, method, method.label, plan.durationSec)
            case .preparing(let wait):
                attempt += 1
                if attempt >= maxPrepareAttempts { return nil }
                await pause(wait)
            }
        }
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
