import Foundation

public struct TitleSummary: Hashable, Identifiable, Sendable {
    public let kind: MediaKind
    public let id: String
    public let title: String
    public let year: Int?
    public let overview: String?
    public let poster: String?
    public let backdrop: String?
    public let quality: String?
    public let voteAverage: Double?
    public let genres: [String]

    public init(
        kind: MediaKind, id: String, title: String, year: Int? = nil, overview: String? = nil,
        poster: String? = nil, backdrop: String? = nil, quality: String? = nil,
        voteAverage: Double? = nil, genres: [String] = []
    ) {
        self.kind = kind
        self.id = id
        self.title = title
        self.year = year
        self.overview = overview
        self.poster = poster
        self.backdrop = backdrop
        self.quality = quality
        self.voteAverage = voteAverage
        self.genres = genres
    }

    public init(_ movie: MovieSummary) {
        self.init(
            kind: .movie, id: movie.id, title: movie.title, year: movie.year, overview: movie.overview,
            poster: movie.poster, backdrop: movie.backdrop, quality: movie.quality,
            voteAverage: movie.voteAverage, genres: movie.genres.compactMap(\.name)
        )
    }

    public init(_ show: ShowSummary) {
        self.init(
            kind: .tv, id: show.id, title: show.title, year: show.year, overview: nil,
            poster: show.poster, backdrop: show.backdrop, quality: show.quality,
            voteAverage: show.voteAverage, genres: show.genres.compactMap(\.name)
        )
    }

    public init(ref: MediaRef) {
        self.init(kind: ref.kind, id: ref.id, title: ref.title, poster: ref.poster, backdrop: ref.backdrop)
    }

    public var ref: MediaRef {
        MediaRef(kind: kind, id: id, title: title, poster: poster, backdrop: backdrop)
    }

    public var needsDetails: Bool {
        backdrop == nil || (kind == .movie && overview == nil)
    }

    public func merging(_ other: TitleSummary) -> TitleSummary {
        TitleSummary(
            kind: kind, id: id, title: other.title.isEmpty ? title : other.title,
            year: other.year ?? year, overview: other.overview ?? overview,
            poster: other.poster ?? poster, backdrop: other.backdrop ?? backdrop,
            quality: other.quality ?? quality, voteAverage: other.voteAverage ?? voteAverage,
            genres: other.genres.isEmpty ? genres : other.genres
        )
    }

    public func withOverview(_ text: String?) -> TitleSummary {
        guard let text, !text.isEmpty else { return self }
        return TitleSummary(
            kind: kind, id: id, title: title, year: year, overview: text, poster: poster,
            backdrop: backdrop, quality: quality, voteAverage: voteAverage, genres: genres
        )
    }
}
