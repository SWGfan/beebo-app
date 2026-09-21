import XCTest
@testable import BeeboKit

final class FormattingTests: XCTestCase {
    func testRuntime() {
        XCTAssertEqual(TimeFormat.runtime(6120), "1h 42m")
        XCTAssertEqual(TimeFormat.runtime(3600), "1h")
        XCTAssertEqual(TimeFormat.runtime(2700), "45m")
        XCTAssertEqual(TimeFormat.runtime(59), "")
        XCTAssertEqual(TimeFormat.runtime(.nan), "")
    }

    func testClock() {
        XCTAssertEqual(TimeFormat.clock(0), "0:00")
        XCTAssertEqual(TimeFormat.clock(65), "1:05")
        XCTAssertEqual(TimeFormat.clock(3725), "1:02:05")
        XCTAssertEqual(TimeFormat.clock(-4), "0:00")
    }

    func testRemaining() {
        XCTAssertEqual(TimeFormat.remaining(position: 600, duration: 6000), "1h 30m left")
        XCTAssertEqual(TimeFormat.remaining(position: 5990, duration: 6000), "Almost finished")
        XCTAssertEqual(TimeFormat.remaining(position: 10, duration: 0), "")
    }

    func testRatingAndMetadataLine() {
        XCTAssertEqual(RatingFormat.score(8.14), "8.1")
        XCTAssertNil(RatingFormat.score(0))
        XCTAssertNil(RatingFormat.score(nil))
        XCTAssertEqual(MetadataLine.make(year: 1979, quality: "1080p", runtimeSeconds: 7020, score: 8.1),
                       "1979  \u{00B7}  1h 57m  \u{00B7}  1080p  \u{00B7}  \u{2605} 8.1")
        XCTAssertEqual(MetadataLine.make(year: nil, quality: nil, runtimeSeconds: nil, score: nil), "")
        XCTAssertEqual(MetadataLine.make(year: 2020, quality: "", runtimeSeconds: 30, score: nil), "2020")
    }

    func testEpisodeLabels() {
        XCTAssertEqual(EpisodeLabel.code(season: 1, episode: 2), "S1 \u{00B7} E2")
        XCTAssertEqual(EpisodeLabel.code(season: nil, episode: 4), "Episode 4")
        XCTAssertEqual(EpisodeLabel.code(season: 2, episode: nil), "")
        let named = decode(Episode.self, "{\"id\":\"a\",\"season\":1,\"episode\":3,\"title\":\"S1E3 \\u00b7 Pilot\",\"episodeName\":\"Pilot\"}")
        XCTAssertEqual(EpisodeLabel.displayTitle(named), "Pilot")
        let numbered = decode(Episode.self, "{\"id\":\"a\",\"season\":1,\"episode\":3,\"title\":\"Show \\u2014 S1E3\"}")
        XCTAssertEqual(EpisodeLabel.displayTitle(numbered), "Episode 3")
        let loose = decode(Episode.self, "{\"id\":\"a\",\"title\":\"Show \\u2014 Special\"}")
        XCTAssertEqual(EpisodeLabel.displayTitle(loose), "Special")
        let bare = decode(Episode.self, "{\"id\":\"a\",\"title\":\"clip.mkv\"}")
        XCTAssertEqual(EpisodeLabel.displayTitle(bare), "clip.mkv")
    }
}

final class EpisodeSelectorTests: XCTestCase {
    private func seasons(_ rows: [(String, Int, Int, Int, Bool?)]) -> [Season] {
        let grouped = Dictionary(grouping: rows, by: { $0.1 })
        let list = grouped.keys.sorted().map { season -> String in
            let eps = (grouped[season] ?? []).map { row -> String in
                let watched = row.4.map { "\"watched\":\($0)," } ?? ""
                return "{\"id\":\"\(row.0)\",\"season\":\(row.1),\"episode\":\(row.2),\(watched)\"watchedPercent\":\(row.3)}"
            }
            return "{\"season\":\(season),\"episodes\":[\(eps.joined(separator: ","))]}"
        }
        return decode(EpisodesResponse.self, "{\"ok\":true,\"seasons\":[\(list.joined(separator: ","))]}").seasons
    }

    func testNothingWatchedStartsAtTheBeginning() {
        let target = EpisodeSelector.playTarget(seasons: seasons([("a", 1, 1, 0, nil), ("b", 1, 2, 0, nil)]))
        XCTAssertEqual(target?.episode.id, "a")
        XCTAssertEqual(target?.resumes, false)
    }

    func testInProgressEpisodeResumes() {
        let target = EpisodeSelector.playTarget(seasons: seasons([("a", 1, 1, 100, true), ("b", 1, 2, 40, false), ("c", 1, 3, 0, nil)]))
        XCTAssertEqual(target?.episode.id, "b")
        XCTAssertEqual(target?.resumes, true)
    }

    func testAfterFinishedEpisodeOffersTheNext() {
        let target = EpisodeSelector.playTarget(seasons: seasons([("a", 1, 1, 100, true), ("b", 1, 2, 100, true), ("c", 2, 1, 0, nil)]))
        XCTAssertEqual(target?.episode.id, "c")
        XCTAssertEqual(target?.resumes, false)
    }

    func testEverythingWatchedRestartsFromTheTop() {
        let target = EpisodeSelector.playTarget(seasons: seasons([("a", 1, 1, 100, true), ("b", 1, 2, 100, true)]))
        XCTAssertEqual(target?.episode.id, "a")
        XCTAssertEqual(target?.resumes, false)
    }

    func testEmptyShow() {
        XCTAssertNil(EpisodeSelector.playTarget(seasons: []))
    }

    func testUnwatchedCount() {
        let list = seasons([("a", 1, 1, 100, true), ("b", 1, 2, 0, nil), ("c", 1, 3, 10, false)])
        XCTAssertEqual(EpisodeSelector.unwatchedCount(in: list[0]), 2)
    }
}

final class SettingsAndSessionTests: XCTestCase {
    func testDefaultPreferences() {
        let prefs = MemorySettings().playbackPreferences
        XCTAssertEqual(prefs.quality, .auto)
        XCTAssertFalse(prefs.subtitlesEnabled)
    }

    func testUserDefaultsRoundTrip() throws {
        let suite = "beebo.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let settings = UserDefaultsSettings(defaults: defaults)
        XCTAssertNil(settings.lastServerAddress)
        XCTAssertEqual(settings.playbackPreferences.quality, .auto)

        settings.lastServerAddress = "192.168.1.20"
        settings.playbackPreferences = PlaybackPreferences(quality: .p720, subtitlesEnabled: true, subtitleLanguage: "fr", audioLanguage: "de")
        let again = UserDefaultsSettings(defaults: defaults)
        XCTAssertEqual(again.lastServerAddress, "192.168.1.20")
        XCTAssertEqual(again.playbackPreferences, PlaybackPreferences(quality: .p720, subtitlesEnabled: true, subtitleLanguage: "fr", audioLanguage: "de"))

        settings.lastServerAddress = ""
        XCTAssertNil(settings.lastServerAddress)
    }

    func testUnknownQualityValueFallsBackToAuto() throws {
        let suite = "beebo.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("4k", forKey: "beebo.quality")
        XCTAssertEqual(UserDefaultsSettings(defaults: defaults).playbackPreferences.quality, .auto)
    }

    func testQualityLabels() {
        XCTAssertEqual(QualityPreference.allCases.map(\.rawValue), ["auto", "1080p", "720p", "480p"])
        XCTAssertTrue(QualityPreference.allCases.allSatisfy { !$0.label.isEmpty })
    }

    func testInMemorySessionStore() {
        let store = InMemorySessionStore()
        XCTAssertNil(store.load())
        let saved = SavedSession(baseURL: "http://192.168.1.20:47811", token: "tok", userId: "u1", userName: "Nick")
        store.save(saved)
        XCTAssertEqual(store.load(), saved)
        store.clear()
        XCTAssertNil(store.load())
    }

    func testSavedSessionCodableRoundTrip() throws {
        let saved = SavedSession(baseURL: "https://nick.home.beebo.tv:47811", token: "t", userId: "u", userName: "N")
        let data = try JSONEncoder().encode(saved)
        XCTAssertEqual(try JSONDecoder().decode(SavedSession.self, from: data), saved)
    }
}

final class TitleSummaryTests: XCTestCase {
    func testFromMovieAndShow() {
        let movie = TitleSummary(decode(MovieSummary.self, Fixtures.movieOne))
        XCTAssertEqual(movie.kind, .movie)
        XCTAssertEqual(movie.genres, ["Horror"])
        XCTAssertFalse(movie.needsDetails)
        let show = TitleSummary(decode(ShowSummary.self, "{\"id\":\"s\",\"title\":\"S\",\"backdrop\":null}"))
        XCTAssertEqual(show.kind, .tv)
        XCTAssertTrue(show.needsDetails)
    }

    func testMergingKeepsWhatWeAlreadyKnow() {
        let stub = TitleSummary(ref: MediaRef(kind: .movie, id: "m", title: "Alien", poster: "/p.jpg"))
        XCTAssertTrue(stub.needsDetails)
        let full = TitleSummary(kind: .movie, id: "m", title: "Alien", year: 1979, overview: "Space.", poster: nil, backdrop: "https://x/b.jpg")
        let merged = stub.merging(full)
        XCTAssertEqual(merged.poster, "/p.jpg")
        XCTAssertEqual(merged.year, 1979)
        XCTAssertEqual(merged.backdrop, "https://x/b.jpg")
        XCTAssertFalse(merged.needsDetails)
        XCTAssertEqual(merged.withOverview("Other").overview, "Other")
        XCTAssertEqual(merged.withOverview("").overview, "Space.")
    }
}
