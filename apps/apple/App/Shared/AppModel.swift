import SwiftUI
import BeeboKit

struct PlaybackRequest: Identifiable {
    let id = UUID()
    let ref: MediaRef
    let resumeSeconds: Double?
    let resumePercent: Int?
}

private final class APIBox {
    var api: BeeboAPI?
}

private func attempt<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, Error> {
    do {
        return .success(try await body())
    } catch {
        return .failure(error)
    }
}

@MainActor
final class AppModel: ObservableObject {
    enum Phase {
        case launching
        case signedOut
        case signedIn
    }

    @Published private(set) var phase: Phase = .launching
    @Published private(set) var api: BeeboAPI?
    @Published private(set) var session: SavedSession?
    @Published private(set) var continueItems: [ContinueEntry] = []
    @Published private(set) var recentItems: [RecentlyAddedEntry] = []
    @Published private(set) var homeLoaded = false
    @Published private(set) var homeError: String?
    @Published var playback: PlaybackRequest?
    @Published var notice: String?
    @Published var pendingLinkCode: String?
    @Published var suggestedAddress: String?
    @Published var preferences: PlaybackPreferences {
        didSet { settings.playbackPreferences = preferences }
    }

    let movies: PagedLoader<MovieSummary>
    let shows: PagedLoader<ShowSummary>
    let settings: SettingsStoring

    private let sessions: SessionStoring
    private let box: APIBox

    init(settings: SettingsStoring = UserDefaultsSettings(), sessions: SessionStoring = KeychainSessionStore()) {
        let box = APIBox()
        self.box = box
        self.settings = settings
        self.sessions = sessions
        self.preferences = settings.playbackPreferences
        self.movies = PagedLoader<MovieSummary> { offset, limit in
            guard let api = box.api else { throw APIError.unauthorized }
            return try await api.movies(offset: offset, limit: limit)
        }
        self.shows = PagedLoader<ShowSummary> { offset, limit in
            guard let api = box.api else { throw APIError.unauthorized }
            return try await api.shows(offset: offset, limit: limit)
        }
    }

    var serverAddress: String {
        guard let text = session?.baseURL, let url = URL(string: text) else { return "" }
        return ServerAddress.display(url)
    }

    var userName: String { session?.userName ?? "" }

    func restore() async {
        guard phase == .launching else { return }
        guard let saved = sessions.load(), let url = URL(string: saved.baseURL) else {
            phase = .signedOut
            return
        }
        open(saved, url: url)
        await validateSession()
    }

    func signIn(address: String, username: String, password: String) async throws {
        let saved = try await SignInService.signIn(address: address, username: username, password: password)
        guard let url = URL(string: saved.baseURL) else { throw APIError.invalidAddress }
        settings.lastServerAddress = address.trimmingCharacters(in: .whitespacesAndNewlines)
        sessions.save(saved)
        notice = nil
        suggestedAddress = nil
        open(saved, url: url)
    }

    func completePairing(houseName: String, viewerToken: String) async -> PairedSignInResult {
        let result = await PairedSignIn.complete(
            viewerToken: viewerToken, houseName: houseName,
            lastAddress: settings.lastServerAddress, deviceName: AppConfig.deviceName
        )
        if case .signedIn(let saved) = result, let url = URL(string: saved.baseURL) {
            settings.lastServerAddress = ServerAddress.display(url)
            sessions.save(saved)
            notice = nil
            open(saved, url: url)
        }
        return result
    }

    func signOut() {
        sessions.clear()
        close()
    }

    func sessionExpired() {
        guard phase == .signedIn else { return }
        sessions.clear()
        close()
        notice = "Your session expired. Please sign in again."
    }

    private func open(_ saved: SavedSession, url: URL) {
        let client = BeeboAPI(baseURL: url, token: saved.token)
        session = saved
        api = client
        box.api = client
        movies.reset()
        shows.reset()
        phase = .signedIn
    }

    private func close() {
        api = nil
        box.api = nil
        session = nil
        continueItems = []
        recentItems = []
        homeLoaded = false
        homeError = nil
        playback = nil
        movies.reset()
        shows.reset()
        phase = .signedOut
    }

    private func validateSession() async {
        guard let api else { return }
        do {
            _ = try await api.me()
        } catch let error as APIError where error.isUnauthorized {
            sessionExpired()
        } catch {
            return
        }
    }

    func refreshHome() async {
        guard let api else { return }
        async let continued = attempt { try await api.continueWatching() }
        async let recent = attempt { try await api.recentlyAdded() }
        let (continueResult, recentResult) = await (continued, recent)
        var problem: String?
        switch continueResult {
        case .success(let entries):
            continueItems = entries.filter { !$0.watched || $0.upNext }
        case .failure(let error):
            if let apiError = error as? APIError {
                if apiError.isUnauthorized { sessionExpired(); return }
                if case .forbidden = apiError { continueItems = [] } else { problem = apiError.userMessage }
            } else {
                problem = error.localizedDescription
            }
        }
        switch recentResult {
        case .success(let entries):
            recentItems = entries
        case .failure(let error):
            if let apiError = error as? APIError, apiError.isUnauthorized { sessionExpired(); return }
            problem = problem ?? (error as? APIError)?.userMessage ?? error.localizedDescription
        }
        homeError = problem
        homeLoaded = true
    }

    func play(_ ref: MediaRef, resumeSeconds: Double? = nil, resumePercent: Int? = nil) {
        playback = PlaybackRequest(ref: ref, resumeSeconds: resumeSeconds, resumePercent: resumePercent)
    }

    func play(_ entry: ContinueEntry) {
        let start = entry.upNext
            ? nil
            : ResumePolicy.startPosition(positionSeconds: entry.positionSeconds, durationSeconds: entry.durationSeconds, watched: entry.watched)
        play(entry.ref, resumeSeconds: start)
    }

    func resumeSeconds(forID id: String) -> Double? {
        guard let entry = continueItems.first(where: { $0.id == id && !$0.upNext }) else { return nil }
        let start = ResumePolicy.startPosition(positionSeconds: entry.positionSeconds, durationSeconds: entry.durationSeconds, watched: entry.watched)
        return start > 0 ? start : nil
    }

    func playbackEnded() {
        playback = nil
        Task { await refreshHome() }
    }

    func handle(url: URL) {
        switch DeepLink.parse(url) {
        case .pair(let code):
            pendingLinkCode = code ?? ""
        case .connect(let address):
            suggestedAddress = address
        case nil:
            break
        }
    }
}
