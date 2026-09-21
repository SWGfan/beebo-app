import XCTest
@testable import BeeboKit

final class SignInServiceTests: XCTestCase {
    private let pingOK = "{\"ok\":true,\"app\":\"beeboentertainment\",\"apiVersion\":1}"
    private let loginOK = "{\"ok\":true,\"token\":\"u1.999.sig\",\"user\":{\"id\":\"u1\",\"name\":\"Nick\"}}"

    func testSignsInAtHomeOverHttp() async throws {
        let t = MockTransport()
        t.route("/api/ping", host: "192.168.1.20", body: pingOK)
        t.route("/api/login", host: "192.168.1.20", method: "POST", body: loginOK)
        let session = try await SignInService.signIn(address: "192.168.1.20", username: " nick ", password: "pw", transport: t)
        XCTAssertEqual(session, SavedSession(baseURL: "http://192.168.1.20:47811", token: "u1.999.sig", userId: "u1", userName: "Nick"))
        XCTAssertEqual(t.jsonBody(of: t.requests(to: "/api/login")[0])["username"] as? String, "nick")
    }

    func testFallsBackToHttpsWhenPlainHttpIsRefused() async throws {
        let t = MockTransport()
        t.route("/api/ping", host: "my-pc.local", body: pingOK)
        t.route("/api/login", host: "my-pc.local", method: "POST", body: loginOK)
        let seen = TransportSpy(wrapping: t, failScheme: "http")
        let session = try await SignInService.signIn(address: "my-pc.local", username: "nick", password: "pw", transport: seen)
        XCTAssertTrue(session.baseURL.hasPrefix("https://my-pc.local"))
        XCTAssertEqual(seen.schemesTried, ["http", "https", "https"])
    }

    func testTunnelOnlyAddressExplainsItself() async {
        let t = MockTransport()
        do {
            _ = try await SignInService.signIn(address: "nick.beebo.tv", username: "n", password: "p", transport: t)
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(code: "tunnel_only", message: SignInService.tunnelOnlyMessage))
        }
        XCTAssertTrue(t.requests.isEmpty)
    }

    func testWrongServerIsRecognised() async {
        let t = MockTransport()
        t.route("/api/ping", body: "{\"ok\":true,\"app\":\"plex\"}")
        do {
            _ = try await SignInService.signIn(address: "192.168.1.20", username: "n", password: "p", transport: t)
            XCTFail("expected refusal")
        } catch {
            guard case .refused(let code, _) = error as? APIError else { return XCTFail("wrong error \(error)") }
            XCTAssertEqual(code, "not_beebo")
        }
    }

    func testPingNotFoundMeansNotBeebo() async {
        let t = MockTransport()
        t.route("/api/ping", status: 404, body: "<html>404</html>")
        do {
            _ = try await SignInService.signIn(address: "192.168.1.20", username: "n", password: "p", transport: t)
            XCTFail("expected refusal")
        } catch {
            guard case .refused(let code, _) = error as? APIError else { return XCTFail("wrong error \(error)") }
            XCTAssertEqual(code, "not_beebo")
        }
    }

    func testBadPasswordAndLockout() async {
        let t = MockTransport()
        t.route("/api/ping", body: pingOK)
        t.route("/api/login", method: "POST", status: 401, body: "{\"ok\":false,\"error\":\"bad_credentials\"}")
        do {
            _ = try await SignInService.signIn(address: "192.168.1.20", username: "n", password: "wrong", transport: t)
            XCTFail("expected refusal")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(code: "bad_credentials", message: "Wrong username or password."))
        }
        t.route("/api/login", method: "POST", status: 401, body: "{\"ok\":false,\"error\":\"bad_credentials\",\"locked\":true,\"minutesRemaining\":5}")
        do {
            _ = try await SignInService.signIn(address: "192.168.1.20", username: "n", password: "wrong", transport: t)
            XCTFail("expected refusal")
        } catch {
            guard case .refused(let code, let message) = error as? APIError else { return XCTFail("wrong error \(error)") }
            XCTAssertEqual(code, "locked")
            XCTAssertTrue(message.contains("5 minutes"))
        }
    }

    func testUnreachableServerReportsTheNetworkProblem() async {
        do {
            _ = try await SignInService.signIn(address: "192.168.1.20", username: "n", password: "p", transport: MockTransport())
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual(error as? APIError, .network(.cannotConnect))
        }
    }

    func testEmptyFieldsAreRejectedBeforeAnyRequest() async {
        let t = MockTransport()
        for (address, user, pass) in [("", "n", "p"), ("192.168.1.20", " ", "p"), ("192.168.1.20", "n", "")] {
            do {
                _ = try await SignInService.signIn(address: address, username: user, password: pass, transport: t)
                XCTFail("expected refusal")
            } catch {
                XCTAssertNotNil(error as? APIError)
            }
        }
        XCTAssertTrue(t.requests.isEmpty)
    }
}

final class TransportSpy: HTTPTransport, @unchecked Sendable {
    private let inner: HTTPTransport
    private let failScheme: String
    private let lock = NSLock()
    private var schemes: [String] = []

    init(wrapping inner: HTTPTransport, failScheme: String) {
        self.inner = inner
        self.failScheme = failScheme
    }

    var schemesTried: [String] { lock.withLock { schemes } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let scheme = request.url?.scheme ?? ""
        lock.withLock { schemes.append(scheme) }
        if scheme == failScheme { throw URLError(.cannotConnectToHost) }
        return try await inner.send(request)
    }
}
