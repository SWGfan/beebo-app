import SwiftUI
import AVKit
import UIKit
import BeeboKit

final class SubtitleOverlayView: UIView {
    private let label = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isHidden = true
        backgroundColor = UIColor.black.withAlphaComponent(0.6)
        layer.cornerRadius = 8
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .white
        label.adjustsFontForContentSizeCategory = true
        #if os(tvOS)
        label.font = UIFont.preferredFont(forTextStyle: .title2)
        #else
        label.font = UIFont.preferredFont(forTextStyle: .body)
        #endif
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func install(in host: UIView) {
        translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(self)
        #if os(tvOS)
        let bottomInset: CGFloat = 120
        #else
        let bottomInset: CGFloat = 70
        #endif
        NSLayoutConstraint.activate([
            centerXAnchor.constraint(equalTo: host.centerXAnchor),
            bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: -bottomInset),
            leadingAnchor.constraint(greaterThanOrEqualTo: host.leadingAnchor, constant: 40),
            trailingAnchor.constraint(lessThanOrEqualTo: host.trailingAnchor, constant: -40),
        ])
    }

    func setText(_ text: String?) {
        guard let text, !text.isEmpty else {
            isHidden = true
            return
        }
        if label.text != text { label.text = text }
        isHidden = false
    }
}

struct TrackChoice: Identifiable, Equatable {
    static let offID = "off"

    let id: String
    let title: String
    let selected: Bool
}

@MainActor
final class PlayerCoordinator: NSObject, ObservableObject {
    enum Phase: Equatable {
        case loading
        case playing
        case failed(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var audioChoices: [TrackChoice] = []
    @Published private(set) var subtitleChoices: [TrackChoice] = []

    let controller = AVPlayerViewController()
    let player = AVPlayer()
    var onClose: (@MainActor () -> Void)?

    private let api: BeeboAPI
    private let preferences: PlaybackPreferences
    private let service: PlaybackService
    private var currentRef: MediaRef
    private var startAt: Double?
    private var startPercent: Int?

    private var session: PlaybackSession?
    private var selection = PlaybackSelection()
    private var activeSubtitle: ActiveSubtitle = .none
    private var timeline = SubtitleTimeline(cues: [])
    private var tracker = ProgressTracker()
    private let overlay = SubtitleOverlayView()

    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var controlObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var switching = false
    private var stopped = false
    /// Set to false once a direct play / direct stream could not be played on this device: the plain conversion is used from then on.
    private var allowDirect = true

    init(api: BeeboAPI, preferences: PlaybackPreferences, request: PlaybackRequest) {
        self.api = api
        self.preferences = preferences
        // The declaration of what this device can decode and show: the server picks direct play / direct stream / conversion from it.
        self.service = PlaybackService(api: api, preferences: preferences, deviceProfile: DeviceCapabilitiesProbe.declaration())
        self.currentRef = request.ref
        self.startAt = request.resumeSeconds
        self.startPercent = request.resumePercent
        super.init()
        controller.player = player
        #if os(iOS)
        controller.allowsPictureInPicturePlayback = false
        #endif
    }

    // MARK: Lifecycle

    func start() async {
        guard session == nil, !stopped else { return }
        configureAudioSession()
        controller.loadViewIfNeeded()
        if let host = controller.contentOverlayView { overlay.install(in: host) }
        observePlayer()
        await load(currentRef, at: startAt, percent: startPercent, selection: PlaybackSelection(), reuseWatchSession: nil)
    }

    func retry() async {
        guard !stopped else { return }
        let position = player.currentTime().seconds
        await load(currentRef, at: position.isFinite && position > 1 ? position : startAt, percent: startPercent,
                   selection: selection, reuseWatchSession: session?.watchSessionId)
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        let position = player.currentTime().seconds
        if let session {
            let service = self.service
            let api = self.api
            let seconds = position.isFinite ? position : 0
            Task {
                await service.reportProgress(session: session, position: seconds)
                await api.playbackStop(ticket: session.ticket)
            }
        }
        player.pause()
        player.replaceCurrentItem(with: nil)
        removeObservers()
    }

    private func configureAudioSession() {
        let audio = AVAudioSession.sharedInstance()
        try? audio.setCategory(.playback, mode: .moviePlayback)
        try? audio.setActive(true)
    }

    // MARK: Loading

    private func load(
        _ ref: MediaRef,
        at position: Double?,
        percent: Int?,
        selection wanted: PlaybackSelection,
        reuseWatchSession: String?
    ) async {
        phase = .loading
        do {
            let prepared = try await service.prepare(ref, selection: wanted, reuseWatchSessionId: reuseWatchSession, allowDirect: allowDirect)
            if stopped {
                await api.playbackStop(ticket: prepared.ticket)
                return
            }
            let previous = session
            session = prepared
            currentRef = ref
            selection = prepared.selection
            activeSubtitle = prepared.subtitle
            timeline = SubtitleTimeline(cues: [])
            overlay.setText(nil)
            tracker.reset()
            let start = position ?? percent.map { ResumePolicy.startPosition(percent: $0, durationSeconds: prepared.durationSeconds) } ?? 0
            attach(prepared, startAt: start)
            phase = .playing
            if let previous { await api.playbackStop(ticket: previous.ticket) }
            rebuildMenus()
            await loadSubtitleCues()
        } catch {
            if stopped { return }
            phase = .failed((error as? APIError)?.userMessage ?? error.localizedDescription)
        }
    }

    private func attach(_ prepared: PlaybackSession, startAt start: Double) {
        statusObservation = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        let item = AVPlayerItem(url: prepared.hlsURL)
        item.externalMetadata = [titleMetadata(prepared.ref.title)]
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.itemStatusChanged() }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.playedToEnd() }
        }
        player.replaceCurrentItem(with: item)
        if start > 0 {
            player.seek(to: CMTime(seconds: start, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        }
        player.play()
    }

    private func titleMetadata(_ title: String) -> AVMetadataItem {
        let item = AVMutableMetadataItem()
        item.identifier = .commonIdentifierTitle
        item.value = title as NSString
        item.extendedLanguageTag = "und"
        return item
    }

    private func itemStatusChanged() {
        guard let item = player.currentItem, !stopped else { return }
        switch item.status {
        case .failed:
            // The server thought this device could play the original (or the repackaged stream) and AVPlayer refused it:
            // once, go back to the proven conversion and carry on from the same place.
            if let session, session.method != .transcode, allowDirect {
                allowDirect = false
                Task { await retry() }
                return
            }
            let detail = item.error?.localizedDescription ?? "Unknown error"
            phase = .failed("This video couldn't be played (\(detail)). Check that your Beebo server can convert video for Apple devices.")
        case .readyToPlay:
            applyPreferredMediaSelection(for: item)
        default:
            break
        }
    }

    private func loadSubtitleCues() async {
        guard case .overlay(_, let url) = activeSubtitle else {
            timeline = SubtitleTimeline(cues: [])
            return
        }
        let cues = await service.loadSubtitleCues(from: url)
        if case .overlay(_, let current) = activeSubtitle, current == url {
            timeline = SubtitleTimeline(cues: cues)
        }
    }

    // MARK: Observing

    private func observePlayer() {
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main
        ) { [weak self] time in
            let seconds = time.seconds
            Task { @MainActor in self?.tick(seconds) }
        }
        controlObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.timeControlChanged() }
        }
    }

    private func removeObservers() {
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        statusObservation = nil
        controlObservation = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
    }

    private func tick(_ seconds: Double) {
        guard seconds.isFinite, !stopped else { return }
        overlay.setText(timeline.text(at: seconds))
        if player.timeControlStatus == .playing, tracker.shouldReport(now: Date().timeIntervalSinceReferenceDate) {
            report(seconds)
        }
    }

    private func timeControlChanged() {
        guard !stopped, player.timeControlStatus == .paused else { return }
        let seconds = player.currentTime().seconds
        if seconds.isFinite, tracker.shouldReport(now: Date().timeIntervalSinceReferenceDate, force: true) {
            report(seconds)
        }
    }

    private func report(_ position: Double) {
        guard let session else { return }
        let service = self.service
        Task { await service.reportProgress(session: session, position: position) }
    }

    private func playedToEnd() async {
        guard !stopped, let finished = session else { return }
        await service.reportProgress(session: finished, position: finished.durationSeconds)
        if let next = await service.nextUp(after: currentRef), !stopped {
            startAt = nil
            startPercent = nil
            allowDirect = true // a new title gets its own chance to be played as it is
            await load(next, at: nil, percent: nil, selection: PlaybackSelection(), reuseWatchSession: nil)
        } else {
            onClose?()
        }
    }

    // MARK: Audio and subtitles

    private func applyPreferredMediaSelection(for item: AVPlayerItem) {
        let preferred = preferences
        Task { @MainActor in
            if !preferred.audioLanguage.isEmpty,
               let group = try? await item.asset.loadMediaSelectionGroup(for: .audible),
               let option = AVMediaSelectionGroup.mediaSelectionOptions(from: group.options, with: Locale(identifier: preferred.audioLanguage)).first {
                item.select(option, in: group)
            }
            if preferred.subtitlesEnabled, case .none = activeSubtitle,
               let group = try? await item.asset.loadMediaSelectionGroup(for: .legible),
               let option = AVMediaSelectionGroup.mediaSelectionOptions(from: group.options, with: Locale(identifier: preferred.subtitleLanguage)).first {
                item.select(option, in: group)
            }
        }
    }

    func chooseAudio(_ id: String) {
        guard let streamIndex = Int(id) else { return }
        Task { await selectAudio(streamIndex) }
    }

    func chooseSubtitle(_ id: String) {
        Task { await selectSubtitle(id == TrackChoice.offID ? .off : .track(id)) }
    }

    private func rebuildMenus() {
        guard let session else { return }
        var audio: [TrackChoice] = []
        if session.audioTracks.count > 1 {
            let selected = session.effectiveAudio?.streamIndex
            audio = session.audioTracks.map { TrackChoice(id: String($0.streamIndex), title: $0.displayName, selected: $0.streamIndex == selected) }
        }
        var subtitles: [TrackChoice] = []
        let texts = session.textSubtitleTracks
        let pictures = session.pictureSubtitleTracks
        if !texts.isEmpty || !pictures.isEmpty {
            let activeKey = activeSubtitle.trackKey
            subtitles.append(TrackChoice(id: TrackChoice.offID, title: "Off", selected: activeKey == nil))
            subtitles += texts.map { TrackChoice(id: $0.key, title: $0.label, selected: activeKey == $0.key) }
            subtitles += pictures.map { TrackChoice(id: $0.key, title: "\($0.label) (re-encodes video)", selected: activeKey == $0.key) }
        }
        audioChoices = audio
        subtitleChoices = subtitles
        #if os(tvOS)
        controller.transportBarCustomMenuItems = transportMenus(audio: audio, subtitles: subtitles)
        #endif
    }

    #if os(tvOS)
    private func transportMenus(audio: [TrackChoice], subtitles: [TrackChoice]) -> [UIMenuElement] {
        var menus: [UIMenuElement] = []
        if !audio.isEmpty {
            let actions = audio.map { choice in
                UIAction(title: choice.title, state: choice.selected ? .on : .off) { [weak self] _ in
                    Task { @MainActor in self?.chooseAudio(choice.id) }
                }
            }
            menus.append(UIMenu(title: "Audio", image: UIImage(systemName: "speaker.wave.2"), children: actions))
        }
        if !subtitles.isEmpty {
            let actions = subtitles.map { choice in
                UIAction(title: choice.title, state: choice.selected ? .on : .off) { [weak self] _ in
                    Task { @MainActor in self?.chooseSubtitle(choice.id) }
                }
            }
            menus.append(UIMenu(title: "Subtitles", image: UIImage(systemName: "captions.bubble"), children: actions))
        }
        return menus
    }
    #endif

    private func selectAudio(_ streamIndex: Int) async {
        guard !switching, session?.effectiveAudio?.streamIndex != streamIndex else { return }
        var wanted = selection
        wanted.audioStreamIndex = streamIndex
        await restart(with: wanted)
    }

    private func selectSubtitle(_ choice: SubtitleChoice) async {
        guard !switching, let session else { return }
        let resolved = PlaybackPlanner.resolveSubtitle(
            info: session.info, choice: choice, preferences: preferences,
            audio: session.effectiveAudio, resolveURL: { [api] in api.absoluteURL($0) }
        )
        var wanted = selection
        wanted.subtitle = choice
        let burnedBefore: Bool
        if case .burnedIn = activeSubtitle { burnedBefore = true } else { burnedBefore = false }
        let burnedAfter: Bool
        if case .burnedIn = resolved { burnedAfter = true } else { burnedAfter = false }
        if burnedBefore || burnedAfter {
            await restart(with: wanted)
            return
        }
        selection = wanted
        activeSubtitle = resolved
        timeline = SubtitleTimeline(cues: [])
        overlay.setText(nil)
        rebuildMenus()
        await loadSubtitleCues()
    }

    private func restart(with wanted: PlaybackSelection) async {
        switching = true
        defer { switching = false }
        let position = player.currentTime().seconds
        await load(currentRef, at: position.isFinite && position > 1 ? position : nil, percent: nil,
                   selection: wanted, reuseWatchSession: session?.watchSessionId)
    }
}
