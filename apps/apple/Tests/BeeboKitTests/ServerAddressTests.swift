import XCTest
@testable import BeeboKit

final class ServerAddressTests: XCTestCase {
    private func norm(_ s: String) -> String? { ServerAddress.normalize(s)?.absoluteString }

    func testBareLocalIPGetsHttpAndDefaultPort() {
        XCTAssertEqual(norm("192.168.1.20"), "http://192.168.1.20:47811")
    }

    func testExplicitPortIsKept() {
        XCTAssertEqual(norm("192.168.1.20:8080"), "http://192.168.1.20:8080")
    }

    func testPathAndWhitespaceAreDropped() {
        XCTAssertEqual(norm("  http://192.168.1.20/some/path/ "), "http://192.168.1.20:47811")
    }

    func testHomeBeeboAddressGetsHttpsAndPort() {
        XCTAssertEqual(norm("nick.home.beebo.tv"), "https://nick.home.beebo.tv:47811")
        XCTAssertEqual(norm("https://nick.home.beebo.tv"), "https://nick.home.beebo.tv:47811")
    }

    func testPublicHostGetsHttps() {
        XCTAssertEqual(norm("example.com"), "https://example.com")
        XCTAssertEqual(norm("http://example.com"), "https://example.com")
    }

    func testLocalNamesGetHttp() {
        XCTAssertEqual(norm("beebo-pc"), "http://beebo-pc:47811")
        XCTAssertEqual(norm("my-pc.local"), "http://my-pc.local:47811")
    }

    func testExplicitHttpsOnLocalIsKept() {
        XCTAssertEqual(norm("https://192.168.1.20"), "https://192.168.1.20:47811")
    }

    func testRejectsNonsense() {
        XCTAssertNil(norm(""))
        XCTAssertNil(norm("   "))
        XCTAssertNil(norm("ftp://192.168.1.20"))
        XCTAssertNil(norm("http://"))
    }

    func testHostIsLowercased() {
        XCTAssertEqual(norm("My-PC.LOCAL"), "http://my-pc.local:47811")
    }

    func testLocalHostRules() {
        for host in ["10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.1.1", "100.64.0.1", "169.254.1.1", "127.0.0.1",
                     "localhost", "beebo-pc", "nas.local", "pc.lan", "fd00::1", "fe80::1", "::1", "[::1]"] {
            XCTAssertTrue(ServerAddress.isLocalHost(host), host)
        }
        for host in ["8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.1.1", "example.com", "nick.beebo.tv", "2001:db8::1", ""] {
            XCTAssertFalse(ServerAddress.isLocalHost(host), host)
        }
    }

    func testBeeboTvName() {
        XCTAssertEqual(ServerAddress.beeboTvName("nick.beebo.tv"), "nick")
        XCTAssertEqual(ServerAddress.beeboTvName("https://Nick.beebo.tv:443/x"), "nick")
        XCTAssertNil(ServerAddress.beeboTvName("nick.home.beebo.tv"))
        XCTAssertNil(ServerAddress.beeboTvName("www.beebo.tv"))
        XCTAssertNil(ServerAddress.beeboTvName("beebo.tv"))
        XCTAssertNil(ServerAddress.beeboTvName("192.168.1.20"))
    }

    func testTunnelOnlyDetection() throws {
        XCTAssertTrue(ServerAddress.isTunnelOnly(try XCTUnwrap(URL(string: "https://nick.beebo.tv"))))
        XCTAssertFalse(ServerAddress.isTunnelOnly(try XCTUnwrap(URL(string: "https://nick.home.beebo.tv:47811"))))
        XCTAssertEqual(ServerAddress.directHomeAddress(forName: "nick"), "https://nick.home.beebo.tv:47811")
    }

    func testCandidatesForBareLocalAddressTryHttpFirst() {
        XCTAssertEqual(ServerAddress.candidates("192.168.1.20").map(\.absoluteString),
                       ["http://192.168.1.20:47811", "https://192.168.1.20:47811"])
    }

    func testCandidatesForPublicHostAreHttpsOnly() {
        XCTAssertEqual(ServerAddress.candidates("example.com").map(\.absoluteString), ["https://example.com"])
    }

    func testCandidatesWithExplicitSchemeAreSingle() {
        XCTAssertEqual(ServerAddress.candidates("https://192.168.1.20").map(\.absoluteString), ["https://192.168.1.20:47811"])
        XCTAssertTrue(ServerAddress.candidates("").isEmpty)
    }

    func testResolveRelativeAndAbsolute() throws {
        let base = try XCTUnwrap(URL(string: "http://192.168.1.20:47811"))
        XCTAssertEqual(ServerAddress.resolve("/media/poster/1.jpg", against: base)?.absoluteString,
                       "http://192.168.1.20:47811/media/poster/1.jpg")
        XCTAssertEqual(ServerAddress.resolve("media/poster/1.jpg", against: base)?.absoluteString,
                       "http://192.168.1.20:47811/media/poster/1.jpg")
        XCTAssertEqual(ServerAddress.resolve("https://image.tmdb.org/t/p/w780/x.jpg", against: base)?.absoluteString,
                       "https://image.tmdb.org/t/p/w780/x.jpg")
        XCTAssertEqual(ServerAddress.resolve("/file?id=abc&mt=1.2", against: base)?.absoluteString,
                       "http://192.168.1.20:47811/file?id=abc&mt=1.2")
        XCTAssertNil(ServerAddress.resolve(nil, against: base))
        XCTAssertNil(ServerAddress.resolve("  ", against: base))
    }

    func testResolveTrimsTrailingSlashOnBase() throws {
        let base = try XCTUnwrap(URL(string: "https://nick.home.beebo.tv:47811/"))
        XCTAssertEqual(ServerAddress.resolve("/hls/t/index.m3u8", against: base)?.absoluteString,
                       "https://nick.home.beebo.tv:47811/hls/t/index.m3u8")
    }

    func testDisplay() throws {
        XCTAssertEqual(ServerAddress.display(try XCTUnwrap(URL(string: "http://192.168.1.20:47811"))), "192.168.1.20:47811")
        XCTAssertEqual(ServerAddress.display(try XCTUnwrap(URL(string: "https://example.com"))), "example.com")
    }
}
