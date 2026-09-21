import Foundation

public struct BeeboAPI: Sendable {
    public let baseURL: URL
    public let token: String?
    let transport: HTTPTransport

    public init(baseURL: URL, token: String? = nil, transport: HTTPTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.token = token
        self.transport = transport
    }

    public func withToken(_ token: String?) -> BeeboAPI {
        BeeboAPI(baseURL: baseURL, token: token, transport: transport)
    }

    public func absoluteURL(_ path: String?) -> URL? {
        ServerAddress.resolve(path, against: baseURL)
    }

    static let queryAllowed: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-._~")
        return set
    }()

    static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: queryAllowed) ?? value
    }

    func makeRequest(
        _ method: String,
        _ path: String,
        query: [(String, String?)] = [],
        body: [String: Any]? = nil,
        authorized: Bool = true
    ) throws -> URLRequest {
        var text = path
        let pairs = query.compactMap { pair -> String? in
            guard let value = pair.1, !value.isEmpty else { return nil }
            return "\(Self.encode(pair.0))=\(Self.encode(value))"
        }
        if !pairs.isEmpty { text += "?" + pairs.joined(separator: "&") }
        guard let url = ServerAddress.resolve(text, against: baseURL) else { throw APIError.invalidAddress }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authorized {
            guard let token, !token.isEmpty else { throw APIError.unauthorized }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }
        return request
    }

    func rawSend(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await transport.send(request)
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.network(NetworkFailure.classify(error))
        }
    }

    static func errorCode(in data: Data) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        return (object["error"] as? String) ?? ""
    }

    static func errorMessage(in data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object["message"] as? String
    }

    func perform<T: Decodable>(_ request: URLRequest, as type: T.Type = T.self) async throws -> T {
        let (data, response) = try await rawSend(request)
        switch response.statusCode {
        case 200..<300:
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw APIError.badResponse
            }
        case 401:
            throw APIError.unauthorized
        case 403:
            throw APIError.forbidden(Self.errorCode(in: data))
        case 404:
            throw APIError.notFound
        default:
            throw APIError.server(response.statusCode)
        }
    }

    // MARK: - Connection and sign-in

    public func ping() async throws -> PingResponse {
        try await perform(makeRequest("GET", "/api/ping", authorized: false))
    }

    public func login(username: String, password: String) async throws -> LoginResponse {
        let request = try makeRequest(
            "POST", "/api/login",
            body: ["username": username, "password": password],
            authorized: false
        )
        let (data, response) = try await rawSend(request)
        if let parsed = try? JSONDecoder().decode(LoginResponse.self, from: data) {
            return parsed
        }
        if response.statusCode == 401 {
            return try JSONDecoder().decode(LoginResponse.self, from: Data("{\"ok\":false,\"error\":\"bad_credentials\"}".utf8))
        }
        throw response.statusCode < 300 ? APIError.badResponse : APIError.server(response.statusCode)
    }

    public func me() async throws -> MeResponse {
        try await perform(makeRequest("GET", "/api/me"))
    }

    // MARK: - Library (versioned /api/v1, server-side paging)

    private func page<Item: Decodable & Sendable>(
        _ path: String,
        query: [(String, String?)],
        offset: Int,
        limit: Int
    ) async throws -> Page<Item> {
        var pairs = query
        pairs.append(("limit", String(limit)))
        pairs.append(("offset", String(offset)))
        let envelope: PageEnvelope<Item> = try await perform(makeRequest("GET", path, query: pairs))
        let items = envelope.items
        return Page(items: items, total: envelope.total ?? (offset + items.count), offset: envelope.offset ?? offset, limit: envelope.limit ?? limit)
    }

    public func movies(query: String? = nil, offset: Int = 0, limit: Int = 60) async throws -> Page<MovieSummary> {
        let result: Page<MovieSummary> = try await page(
            "/api/v1/library/movies",
            query: [("q", Self.trimmed(query)), ("sort", "title")],
            offset: offset, limit: limit
        )
        return Page(items: result.items.filter { !$0.id.isEmpty }, total: result.total, offset: result.offset, limit: result.limit)
    }

    public func shows(query: String? = nil, offset: Int = 0, limit: Int = 60) async throws -> Page<ShowSummary> {
        let result: Page<ShowSummary> = try await page(
            "/api/v1/library/tvshows",
            query: [("q", Self.trimmed(query))],
            offset: offset, limit: limit
        )
        return Page(items: result.items.filter { !$0.id.isEmpty }, total: result.total, offset: result.offset, limit: result.limit)
    }

    public func recentlyAdded(limit: Int = 24) async throws -> [RecentlyAddedEntry] {
        let result: Page<RecentlyAddedEntry> = try await page("/api/v1/library/recently-added", query: [], offset: 0, limit: limit)
        return result.items.filter { !$0.id.isEmpty }
    }

    public func continueWatching(limit: Int = 30) async throws -> [ContinueEntry] {
        let result: Page<ContinueEntry> = try await page("/api/v1/continue", query: [], offset: 0, limit: limit)
        return result.items.filter { !$0.id.isEmpty }
    }

    static func trimmed(_ text: String?) -> String? {
        guard let value = text?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    // MARK: - Shows

    public func episodes(showKey: String) async throws -> EpisodesResponse {
        try await perform(makeRequest("GET", "/api/tvshows/\(Self.encode(showKey))/episodes"))
    }

    public func upNext(kind: MediaKind, id: String) async throws -> UpNextResponse {
        try await perform(makeRequest("GET", "/api/upnext", query: [("kind", kind.rawValue), ("id", id)]))
    }

    // MARK: - Playback

    public func playbackInfo(kind: MediaKind, id: String) async throws -> PlaybackInfo {
        try await perform(makeRequest("GET", "/api/playback/info", query: [("kind", kind.rawValue), ("id", id)]))
    }

    public func playbackStart(
        kind: MediaKind,
        id: String,
        quality: String,
        audioStreamIndex: Int? = nil,
        burnSubtitleStreamIndex: Int? = nil
    ) async throws -> PlaybackStartResponse {
        var body: [String: Any] = ["kind": kind.rawValue, "id": id, "quality": quality]
        if let audioStreamIndex { body["audio"] = audioStreamIndex }
        if let burnSubtitleStreamIndex { body["burnSubtitle"] = burnSubtitleStreamIndex }
        let request = try makeRequest("POST", "/api/playback/start", body: body)
        let (data, response) = try await rawSend(request)
        if response.statusCode == 401 { throw APIError.unauthorized }
        let parsed = try? JSONDecoder().decode(PlaybackStartResponse.self, from: data)
        if let parsed, parsed.ok, !parsed.url.isEmpty { return parsed }
        let code = parsed?.error ?? Self.errorCode(in: data)
        let message = parsed?.message ?? Self.errorMessage(in: data) ?? Self.playbackRefusal(code, status: response.statusCode)
        throw APIError.refused(code: code.isEmpty ? "failed" : code, message: message)
    }

    /// Direct play / direct stream / transcode, decided by the server from this device's declared profile (docs/HOME-THEATER.md).
    /// Call it only when `PlaybackInfo.homeTheater` is present; an older server has no such route. The profile travels in the JSON body.
    public func playbackNegotiate(
        kind: MediaKind,
        id: String,
        quality: String,
        audioStreamIndex: Int? = nil,
        profile: DeviceProfileDeclaration
    ) async throws -> NegotiateOutcome {
        var body: [String: Any] = ["kind": kind.rawValue, "id": id, "quality": quality, "client": profile.client.isEmpty ? "appletv" : profile.client]
        body["deviceProfile"] = profile.object
        if let audioStreamIndex { body["audio"] = audioStreamIndex }
        let request = try makeRequest("POST", "/api/playback/negotiate", body: body)
        let (data, response) = try await rawSend(request)
        if response.statusCode == 401 { throw APIError.unauthorized }
        let parsed = try? JSONDecoder().decode(NegotiatedPlan.self, from: data)
        if response.statusCode == 503, let parsed, (parsed.error ?? "") == "preparing" {
            let wait = parsed.retryAfterSec ?? 3
            return .preparing(retryAfter: min(10, max(1, wait)))
        }
        if let parsed, parsed.isFollowable { return .plan(parsed) }
        if let parsed, parsed.ok { throw APIError.badResponse }
        let code = parsed?.error ?? Self.errorCode(in: data)
        let message = parsed?.message ?? Self.errorMessage(in: data) ?? Self.playbackRefusal(code, status: response.statusCode)
        throw APIError.refused(code: code.isEmpty ? "failed" : code, message: message)
    }

    static func playbackRefusal(_ code: String, status: Int) -> String {
        switch code {
        case "busy": return "The Beebo computer is busy converting other videos. Try again in a little while."
        case "transcode_off": return "Video conversion is switched off on the Beebo computer, so this video can't play on Apple devices yet."
        case "no_encoder": return "The Beebo computer has no video encoder available (ffmpeg), so this video can't play on Apple devices yet."
        case "unreadable": return "The Beebo computer couldn't read this file for playback."
        case "not_found": return "That video isn't in the library any more."
        default: return status == 404 ? "This server doesn't support Apple playback yet. Update the Beebo server." : "Playback couldn't start (\(code.isEmpty ? "HTTP \(status)" : code))."
        }
    }

    public func playbackStop(ticket: String) async {
        guard !ticket.isEmpty, let request = try? makeRequest("POST", "/api/playback/stop", body: ["ticket": ticket]) else { return }
        _ = try? await rawSend(request)
    }

    public func startWatchSession(kind: MediaKind, id: String) async throws -> String? {
        let response: WatchSessionResponse = try await perform(
            makeRequest("POST", "/api/watch-session", body: ["kind": kind.rawValue, "id": id])
        )
        return response.sessionId
    }

    public func reportProgress(sessionId: String, currentTime: Double, duration: Double) async throws {
        let body: [String: Any] = [
            "sessionId": sessionId,
            "currentTime": max(0, currentTime),
            "duration": max(0, duration),
        ]
        let _: OkResponse = try await perform(makeRequest("POST", "/api/progress", body: body))
    }

    // MARK: - Movie Night (docs/MOVIE-NIGHT.md)

    public func movieNightStatus() async throws -> MovieNightStatus {
        try await perform(makeRequest("GET", "/api/movie-night/status"))
    }

    /// Starts a room as the signed-in person. Open `MovieNight.tvURL(base:room:)` in a web view.
    public func movieNightCreateRoom() async throws -> MovieNightRoom {
        try await perform(makeRequest("POST", "/api/movie-night/tv/create", body: [:]))
    }

    public func fetchText(_ url: URL) async throws -> String {
        var request = URLRequest(url: url)
        request.setValue("text/vtt, text/plain, */*", forHTTPHeaderField: "Accept")
        let (data, response) = try await rawSend(request)
        guard (200..<300).contains(response.statusCode) else { throw APIError.server(response.statusCode) }
        return String(decoding: data, as: UTF8.self)
    }
}
