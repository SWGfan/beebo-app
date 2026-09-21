import Foundation

public enum MediaKind: String, Codable, Hashable, Sendable {
    case movie
    case tv
}

public struct MediaRef: Hashable, Identifiable, Sendable {
    public let kind: MediaKind
    public let id: String
    public let title: String
    public let poster: String?
    public let backdrop: String?

    public init(kind: MediaKind, id: String, title: String, poster: String? = nil, backdrop: String? = nil) {
        self.kind = kind
        self.id = id
        self.title = title
        self.poster = poster
        self.backdrop = backdrop
    }
}

public struct PingResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let app: String?
    public let apiVersion: Int?

    private enum CodingKeys: String, CodingKey { case ok, app, apiVersion }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        app = c.lenientOptional(.app)
        apiVersion = c.lenientOptional(.apiVersion)
    }

    public var isBeeboServer: Bool {
        ok && (app == "beeboentertainment" || app == "movieapp")
    }
}

public struct BeeboUser: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let isAdmin: Bool
    public let restricted: Bool
    public let guest: Bool

    private enum CodingKeys: String, CodingKey { case id, name, isAdmin, restricted, guest }

    public init(id: String, name: String, isAdmin: Bool = false, restricted: Bool = false, guest: Bool = false) {
        self.id = id
        self.name = name
        self.isAdmin = isAdmin
        self.restricted = restricted
        self.guest = guest
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id, "")
        name = c.lenient(.name, "")
        isAdmin = c.lenient(.isAdmin, false)
        restricted = c.lenient(.restricted, false)
        guest = c.lenient(.guest, false)
    }
}

public struct LoginResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let token: String?
    public let user: BeeboUser?
    public let error: String?
    public let locked: Bool
    public let minutesRemaining: Int?

    private enum CodingKeys: String, CodingKey { case ok, token, user, error, locked, minutesRemaining }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        token = c.lenientOptional(.token)
        user = c.lenientOptional(.user)
        error = c.lenientOptional(.error)
        locked = c.lenient(.locked, false)
        minutesRemaining = c.lenientOptional(.minutesRemaining)
    }

    public var failureMessage: String {
        if locked {
            let minutes = minutesRemaining ?? 0
            if minutes > 0 {
                return "Too many failed attempts. Try again in \(minutes) minute\(minutes == 1 ? "" : "s")."
            }
            return "Too many failed attempts. Try again shortly."
        }
        if error == "bad_credentials" { return "Wrong username or password." }
        if let error, !error.isEmpty { return "Sign-in failed (\(error))." }
        return "Sign-in failed."
    }
}

public struct MeResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let user: BeeboUser?

    private enum CodingKeys: String, CodingKey { case ok, user }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        user = c.lenientOptional(.user)
    }
}

public struct Genre: Decodable, Hashable, Sendable {
    public let id: Int
    public let name: String?

    private enum CodingKeys: String, CodingKey { case id, name }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id, 0)
        name = c.lenientOptional(.name)
    }
}

public struct CollectionRef: Decodable, Hashable, Sendable {
    public let id: Int?
    public let name: String?

    private enum CodingKeys: String, CodingKey { case id, name }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientOptional(.id)
        name = c.lenientOptional(.name)
    }
}

public struct MovieSummary: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let year: Int?
    public let overview: String?
    public let tmdbId: Int?
    public let voteAverage: Double?
    public let quality: String?
    public let genres: [Genre]
    public let collection: CollectionRef?
    public let isNew: Bool
    public let poster: String?
    public let backdrop: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, year, overview, tmdbId, voteAverage, quality, genres, collection, isNew, poster, backdrop
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id, "")
        title = c.lenient(.title, "")
        year = c.lenientOptional(.year)
        overview = c.lenientOptional(.overview)
        tmdbId = c.lenientOptional(.tmdbId)
        voteAverage = c.lenientOptional(.voteAverage)
        quality = c.lenientOptional(.quality)
        genres = c.lossyList(.genres)
        collection = c.lenientOptional(.collection)
        isNew = c.lenient(.isNew, false)
        poster = c.lenientOptional(.poster)
        backdrop = c.lenientOptional(.backdrop)
    }

    public var ref: MediaRef {
        MediaRef(kind: .movie, id: id, title: title, poster: poster, backdrop: backdrop)
    }
}

public struct ShowSummary: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let year: Int?
    public let tmdbId: Int?
    public let voteAverage: Double?
    public let quality: String?
    public let genres: [Genre]
    public let episodeCount: Int
    public let isNew: Bool
    public let poster: String?
    public let backdrop: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, year, tmdbId, voteAverage, quality, genres, episodeCount, isNew, poster, backdrop
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id, "")
        title = c.lenient(.title, "")
        year = c.lenientOptional(.year)
        tmdbId = c.lenientOptional(.tmdbId)
        voteAverage = c.lenientOptional(.voteAverage)
        quality = c.lenientOptional(.quality)
        genres = c.lossyList(.genres)
        episodeCount = c.lenient(.episodeCount, 0)
        isNew = c.lenient(.isNew, false)
        poster = c.lenientOptional(.poster)
        backdrop = c.lenientOptional(.backdrop)
    }

    public var ref: MediaRef {
        MediaRef(kind: .tv, id: id, title: title, poster: poster, backdrop: backdrop)
    }
}

public struct ContinueEntry: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let kind: MediaKind
    public let title: String
    public let poster: String?
    public let positionSeconds: Double
    public let durationSeconds: Double
    public let percent: Int
    public let watched: Bool
    public let upNext: Bool
    public let updatedAt: Double?

    private enum CodingKeys: String, CodingKey {
        case id, kind, title, poster, positionSeconds, durationSeconds, percent, watched, upNext, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id, "")
        kind = c.lenient(.kind, MediaKind.movie)
        title = c.lenient(.title, "")
        poster = c.lenientOptional(.poster)
        positionSeconds = c.lenient(.positionSeconds, 0.0)
        durationSeconds = c.lenient(.durationSeconds, 0.0)
        percent = c.lenient(.percent, 0)
        watched = c.lenient(.watched, false)
        upNext = c.lenient(.upNext, false)
        updatedAt = c.lenientOptional(.updatedAt)
    }

    public var ref: MediaRef {
        MediaRef(kind: kind, id: id, title: title, poster: poster)
    }

    public var fraction: Double {
        if durationSeconds > 0 { return min(1, max(0, positionSeconds / durationSeconds)) }
        return min(1, max(0, Double(percent) / 100))
    }
}

public struct RecentlyAddedEntry: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let kind: MediaKind
    public let title: String
    public let poster: String?

    private enum CodingKeys: String, CodingKey { case id, kind, title, poster }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id, "")
        kind = c.lenient(.kind, MediaKind.movie)
        title = c.lenient(.title, "")
        poster = c.lenientOptional(.poster)
    }

    public var ref: MediaRef {
        MediaRef(kind: kind, id: id, title: title, poster: poster)
    }
}

public struct Episode: Decodable, Hashable, Identifiable, Sendable {
    public let id: String
    public let season: Int?
    public let episode: Int?
    public let title: String
    public let episodeName: String?
    public let quality: String?
    public let watched: Bool?
    public let watchedPercent: Int

    private enum CodingKeys: String, CodingKey {
        case id, season, episode, title, episodeName, quality, watched, watchedPercent
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id, "")
        season = c.lenientOptional(.season)
        episode = c.lenientOptional(.episode)
        title = c.lenient(.title, "")
        episodeName = c.lenientOptional(.episodeName)
        quality = c.lenientOptional(.quality)
        watched = c.lenientOptional(.watched)
        watchedPercent = c.lenient(.watchedPercent, 0)
    }

    public var isWatched: Bool {
        watched ?? (watchedPercent >= 95)
    }
}

public struct Season: Decodable, Hashable, Identifiable, Sendable {
    public let season: Int?
    public let episodes: [Episode]

    public var id: Int { season ?? -1 }

    private enum CodingKeys: String, CodingKey { case season, episodes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        season = c.lenientOptional(.season)
        episodes = c.lossyList(.episodes)
    }

    public var displayName: String {
        if let season { return "Season \(season)" }
        return "Unsorted"
    }
}

public struct ShowInfo: Decodable, Hashable, Sendable {
    public let key: String
    public let name: String
    public let poster: String?
    public let overview: String?
    public let tmdbId: Int?

    private enum CodingKeys: String, CodingKey { case key, name, poster, overview, tmdbId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lenient(.key, "")
        name = c.lenient(.name, "")
        poster = c.lenientOptional(.poster)
        overview = c.lenientOptional(.overview)
        tmdbId = c.lenientOptional(.tmdbId)
    }
}

public struct EpisodesResponse: Decodable, Sendable {
    public let ok: Bool
    public let show: ShowInfo?
    public let seasons: [Season]

    private enum CodingKeys: String, CodingKey { case ok, show, seasons }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        show = c.lenientOptional(.show)
        seasons = c.lossyList(.seasons)
    }

    public var allEpisodes: [Episode] {
        seasons.flatMap { $0.episodes }
    }
}

public struct UpNextItem: Decodable, Hashable, Sendable {
    public let kind: MediaKind
    public let id: String
    public let showKey: String?
    public let title: String
    public let poster: String?

    private enum CodingKeys: String, CodingKey { case kind, id, showKey, title, poster }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.lenient(.kind, MediaKind.movie)
        id = c.lenient(.id, "")
        showKey = c.lenientOptional(.showKey)
        title = c.lenient(.title, "")
        poster = c.lenientOptional(.poster)
    }

    public var ref: MediaRef {
        MediaRef(kind: kind, id: id, title: title, poster: poster)
    }
}

public struct UpNextResponse: Decodable, Sendable {
    public let ok: Bool
    public let next: UpNextItem?

    private enum CodingKeys: String, CodingKey { case ok, next }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        next = c.lenientOptional(.next)
    }
}

public struct OkResponse: Decodable, Sendable {
    public let ok: Bool
    public let error: String?

    private enum CodingKeys: String, CodingKey { case ok, error }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        error = c.lenientOptional(.error)
    }
}

public struct WatchSessionResponse: Decodable, Sendable {
    public let ok: Bool
    public let sessionId: String?

    private enum CodingKeys: String, CodingKey { case ok, sessionId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(.ok, false)
        sessionId = c.lenientOptional(.sessionId)
    }
}

public struct Page<Item: Sendable>: Sendable {
    public let items: [Item]
    public let total: Int
    public let offset: Int
    public let limit: Int

    public init(items: [Item], total: Int, offset: Int, limit: Int) {
        self.items = items
        self.total = total
        self.offset = offset
        self.limit = limit
    }
}

struct PageEnvelope<Item: Decodable & Sendable>: Decodable {
    let total: Int?
    let limit: Int?
    let offset: Int?
    let items: [Item]

    private enum CodingKeys: String, CodingKey { case total, limit, offset, items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = c.lenientOptional(.total)
        limit = c.lenientOptional(.limit)
        offset = c.lenientOptional(.offset)
        items = c.lossyList(.items)
    }
}
