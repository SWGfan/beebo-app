import Foundation
import XCTest
@testable import BeeboKit

/// Movie Night (docs/MOVIE-NIGHT.md): the room reply is checked before a web view opens anything.
final class MovieNightTests: XCTestCase {
    private let base = URL(string: "http://192.168.1.20:47811")!
    private let ticket = "aB3_dE6-gH9jK2mN5pQ8rS1tU4vW7xYz"

    private func room(_ json: String) -> MovieNightRoom {
        decode(MovieNightRoom.self, json)
    }

    private var goodRoom: MovieNightRoom {
        room("{\"ok\":true,\"code\":\"K7M2QX\",\"ticket\":\"\(ticket)\",\"tvPath\":\"/movie-night/tv\",\"hash\":\"k=\(ticket)\",\"poolCount\":12}")
    }

    func testAGoodReplyBecomesTheServersOwnPageWithTheTicketInTheFragment() throws {
        let url = try XCTUnwrap(MovieNight.tvURL(base: base, room: goodRoom))
        XCTAssertEqual(url.absoluteString, "http://192.168.1.20:47811/movie-night/tv#k=\(ticket)")
        XCTAssertNil(url.query, "the ticket is never in the query string")
        XCTAssertEqual(url.fragment, "k=\(ticket)")
        let https = try XCTUnwrap(MovieNight.tvURL(base: URL(string: "https://nick.home.beebo.tv:47811/")!, room: goodRoom))
        XCTAssertEqual(https.absoluteString, "https://nick.home.beebo.tv:47811/movie-night/tv#k=\(ticket)")
    }

    func testAWrongOrHostileReplyNeverYieldsAnAddress() {
        let bad = [
            "{\"ok\":false}",
            "{}",
            "{\"ok\":true,\"tvPath\":\"//evil.example/x\",\"ticket\":\"\(ticket)\",\"hash\":\"k=\(ticket)\"}",
            "{\"ok\":true,\"tvPath\":\"https://evil.example/movie-night/tv\",\"ticket\":\"\(ticket)\",\"hash\":\"k=\(ticket)\"}",
            "{\"ok\":true,\"tvPath\":\"/movie-night/tv/../../login\",\"ticket\":\"\(ticket)\",\"hash\":\"k=\(ticket)\"}",
            "{\"ok\":true,\"tvPath\":\"/other\",\"ticket\":\"\(ticket)\",\"hash\":\"k=\(ticket)\"}",
            "{\"ok\":true,\"tvPath\":\"/movie-night/tv\",\"ticket\":\"short\",\"hash\":\"k=short\"}",
            "{\"ok\":true,\"tvPath\":\"/movie-night/tv\",\"ticket\":\"\(ticket)x\",\"hash\":\"k=\(ticket)x\"}",
            "{\"ok\":true,\"tvPath\":\"/movie-night/tv\",\"ticket\":\"\(ticket.dropLast())/\",\"hash\":\"k=\(ticket.dropLast())/\"}",
            "{\"ok\":true,\"tvPath\":\"/movie-night/tv\",\"ticket\":\"\(ticket.dropLast())#\",\"hash\":\"k=\(ticket.dropLast())#\"}",
            "{\"ok\":true,\"tvPath\":\"/movie-night/tv\",\"ticket\":\"\(ticket)\",\"hash\":\"k=\(ticket)&x=1\"}",
            "{\"ok\":true,\"tvPath\":\"/movie-night/tv\",\"ticket\":\"\(ticket)\",\"hash\":\"k=other\"}",
            "{\"ok\":true,\"tvPath\":\"/movie-night/tv\",\"hash\":\"k=\(ticket)\"}",
        ]
        for json in bad {
            XCTAssertNil(MovieNight.tvURL(base: base, room: room(json)), json)
        }
        XCTAssertNil(MovieNight.tvURL(base: URL(string: "ftp://192.168.1.20")!, room: goodRoom))
    }

    func testTheWebViewMayOnlyVisitTheServersOwnPages() {
        XCTAssertTrue(MovieNight.allowsNavigation(base: base, to: URL(string: "http://192.168.1.20:47811/movie-night/tv#k=x")))
        XCTAssertTrue(MovieNight.allowsNavigation(base: base, to: URL(string: "http://192.168.1.20:47811/tvwatch?id=abc")))
        XCTAssertTrue(MovieNight.allowsNavigation(base: base, to: URL(string: "HTTP://192.168.1.20:47811/x")))
        XCTAssertTrue(MovieNight.allowsNavigation(base: base, to: URL(string: "about:blank")))
        XCTAssertFalse(MovieNight.allowsNavigation(base: base, to: URL(string: "http://192.168.1.21:47811/movie-night/tv")), "another host")
        XCTAssertFalse(MovieNight.allowsNavigation(base: base, to: URL(string: "http://192.168.1.20:8080/x")), "another port")
        XCTAssertFalse(MovieNight.allowsNavigation(base: base, to: URL(string: "https://192.168.1.20:47811/x")), "another scheme")
        XCTAssertFalse(MovieNight.allowsNavigation(base: base, to: URL(string: "https://evil.example/")))
        XCTAssertFalse(MovieNight.allowsNavigation(base: base, to: URL(string: "javascript:alert(1)")))
        XCTAssertFalse(MovieNight.allowsNavigation(base: base, to: URL(string: "file:///etc/passwd")))
        XCTAssertFalse(MovieNight.allowsNavigation(base: base, to: URL(string: "about:srcdoc")))
        XCTAssertFalse(MovieNight.allowsNavigation(base: base, to: nil))
        // a default port matches the scheme's own default
        let plain = URL(string: "https://nick.example.com")!
        XCTAssertTrue(MovieNight.allowsNavigation(base: plain, to: URL(string: "https://nick.example.com:443/x")))
        XCTAssertFalse(MovieNight.allowsNavigation(base: plain, to: URL(string: "https://nick.example.com:47811/x")))
    }

    func testBrowserPageIsTheServersTVAddress() {
        XCTAssertEqual(MovieNight.browserPage(base: base), "http://192.168.1.20:47811/tv")
        XCTAssertEqual(MovieNight.browserPage(base: URL(string: "https://nick.home.beebo.tv:47811/")!), "https://nick.home.beebo.tv:47811/tv")
    }

    func testStatusTextIsCleaned() {
        let status = decode(MovieNightStatus.self, "{\"ok\":true,\"available\":false,\"reason\":\"off\",\"message\":\"Turned off\\nin Settings.\"}")
        XCTAssertFalse(status.available)
        XCTAssertEqual(status.reason, "off")
        XCTAssertEqual(status.message, "Turned off in Settings.")
        XCTAssertTrue(decode(MovieNightStatus.self, "{\"available\":true}").available)
        XCTAssertFalse(decode(MovieNightStatus.self, "{}").available)
        XCTAssertEqual(decode(MovieNightStatus.self, "{\"message\":\"\(String(repeating: "x", count: 500))\"}").message.count, 200)
    }

    func testTheApiCallsAreTheDocumentedOnesWithTheBearerToken() async throws {
        let t = MockTransport()
        t.route("/api/movie-night/status", body: "{\"ok\":true,\"enabled\":true,\"available\":true}")
        t.route("/api/movie-night/tv/create", method: "POST", body: "{\"ok\":true,\"code\":\"K7M2QX\",\"ticket\":\"\(ticket)\",\"tvPath\":\"/movie-night/tv\",\"hash\":\"k=\(ticket)\"}")
        let api = Fixtures.api(t)
        let status = try await api.movieNightStatus()
        XCTAssertTrue(status.available)
        let created = try await api.movieNightCreateRoom()
        XCTAssertEqual(created.code, "K7M2QX")
        XCTAssertNotNil(MovieNight.tvURL(base: api.baseURL, room: created))
        for request in t.requests {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
            XCTAssertFalse(request.url?.absoluteString.contains("tok") ?? true, "the token is never in the address")
        }
        XCTAssertEqual(t.requests(to: "/api/movie-night/tv/create").first?.httpMethod, "POST")
    }

    func testExplanationsArePlain() {
        XCTAssertTrue(MovieNight.explain(APIError.notFound).contains("isn't available"))
        XCTAssertTrue(MovieNight.explain(APIError.forbidden("x")).contains("home Wi-Fi"))
        XCTAssertTrue(MovieNight.explain(APIError.unauthorized).contains("signed in"))
        XCTAssertTrue(MovieNight.explain(APIError.server(429)).contains("Too many"))
        XCTAssertEqual(MovieNight.explain(APIError.refused(code: "x", message: "Custom.")), "Custom.")
        XCTAssertEqual(MovieNight.explain(URLError(.badURL)), "Could not start Movie Night.")
    }
}
