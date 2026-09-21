import Foundation

/// Movie Night (docs/MOVIE-NIGHT.md): party games on the shared screen, played from phones. The Beebo server draws the shared
/// screen as a web page (`/movie-night/tv`); the app's job is only to ask whether it is available, start a room as the signed-in
/// person, and open that page in a web view (iPhone and iPad; tvOS has no web view and shows the address to open elsewhere).
///
/// The reply is data from the network, so it is checked before anything is opened: the address is always on the server the person
/// already chose, on exactly one path, with a ticket of the shape the server makes.
public enum MovieNight {
    public static let tvPath = "/movie-night/tv"

    /// The shared-screen page any browser can open (it starts a room by itself): `<server>/tv`.
    public static func browserPage(base: URL) -> String {
        trimmed(base) + "/tv"
    }

    static func trimmed(_ base: URL) -> String {
        var text = base.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }

    private static func isTicket(_ text: String) -> Bool {
        guard text.count == 32 else { return false }
        return text.unicodeScalars.allSatisfy { scalar in
            (scalar.value >= 48 && scalar.value <= 57) || (scalar.value >= 65 && scalar.value <= 90) ||
                (scalar.value >= 97 && scalar.value <= 122) || scalar == "-" || scalar == "_"
        }
    }

    /// The room reply -> the page to open (`<server>/movie-night/tv#k=<ticket>`), or nil for anything that is not exactly what the
    /// server sends. The ticket rides in the fragment, so it is never sent to the server or logged.
    public static func tvURL(base: URL, room: MovieNightRoom) -> URL? {
        guard room.ok, room.tvPath == tvPath, isTicket(room.ticket), room.hash == "k=" + room.ticket else { return nil }
        guard let scheme = base.scheme?.lowercased(), scheme == "http" || scheme == "https", base.host != nil else { return nil }
        return URL(string: trimmed(base) + tvPath + "#k=" + room.ticket)
    }

    /// May a web view opened for Movie Night navigate to `url`? Only pages of the same server (scheme, host and port): the games,
    /// the film's player page, and nothing else. Everything else is refused (and never opened outside the app).
    public static func allowsNavigation(base: URL, to url: URL?) -> Bool {
        guard let url, let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "about" { return url.absoluteString == "about:blank" }
        guard scheme == "http" || scheme == "https" else { return false }
        return scheme == base.scheme?.lowercased()
            && url.host?.lowercased() == base.host?.lowercased()
            && effectivePort(url) == effectivePort(base)
    }

    private static func effectivePort(_ url: URL) -> Int {
        if let port = url.port { return port }
        return url.scheme?.lowercased() == "https" ? 443 : 80
    }

    /// What to tell the person when the server says no.
    public static func explain(_ error: Error) -> String {
        guard let api = error as? APIError else { return "Could not start Movie Night." }
        switch api {
        case .unauthorized: return "This device is no longer signed in."
        case .forbidden: return "Movie Night works on the home Wi-Fi. Connect this device to it and try again."
        case .notFound: return "Movie Night isn't available on this server. Update Beebo on the computer, or ask the owner to turn it on."
        case .server(let status) where status == 429: return "Too many Movie Nights were started just now. Wait a minute and try again."
        case .refused(_, let message): return message
        default: return api.userMessage
        }
    }
}

/// `GET /api/movie-night/status`.
public struct MovieNightStatus: Decodable, Equatable, Sendable {
    public let available: Bool
    public let reason: String
    public let message: String

    private enum CodingKeys: String, CodingKey { case available, reason, message }

    public init(available: Bool, reason: String = "", message: String = "") {
        self.available = available
        self.reason = reason
        self.message = message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = c.lenient(.available, false)
        reason = String((c.lenient(.reason, "")).prefix(40))
        message = MovieNightStatus.clean(c.lenient(.message, ""))
    }

    /// Control characters become spaces; the text is only ever shown, never interpreted.
    static func clean(_ text: String) -> String {
        var out = ""
        for scalar in text.unicodeScalars {
            if scalar.value < 32 || (scalar.value >= 127 && scalar.value <= 159) {
                out.append(" ")
            } else {
                out.unicodeScalars.append(scalar)
            }
            if out.count >= 200 { break }
        }
        return out
    }
}

/// `POST /api/movie-night/tv/create`.
public struct MovieNightRoom: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let code: String
    public let ticket: String
    public let tvPath: String
    public let hash: String

    private enum CodingKeys: String, CodingKey { case ok, code, ticket, tvPath, hash }

    public init(ok: Bool, code: String = "", ticket: String = "", tvPath: String = "", hash: String = "") {
        self.ok = ok
        self.code = code
        self.ticket = ticket
        self.tvPath = tvPath
        self.hash = hash
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        code = c.lenient(.code, "")
        ticket = c.lenient(.ticket, "")
        tvPath = c.lenient(.tvPath, "")
        hash = c.lenient(.hash, "")
    }
}
