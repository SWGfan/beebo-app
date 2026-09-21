import XCTest
@testable import BeeboKit

final class ViewerSessionTests: XCTestCase {
    private let okBody = "{\"token\":\"u1.999.sig\",\"user\":{\"id\":\"u1\",\"name\":\"Nick\",\"isAdmin\":true},\"expiresAt\":1790000000,\"server\":{\"name\":\"nick\"}}"

    private func lan() -> URL { URL(string: "http://192.168.1.20:47811")! }

    func testSuccessSendsBearerAndDeviceName() async throws {
        let t = MockTransport()
        t.route("/api/viewer-session", method: "POST", body: okBody)
        let result = await ViewerSessionService.exchange(viewerToken: "viewer-tok", serverBase: lan(), deviceName: "Living Room", transport: t)
        guard case .success(let session) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertEqual(session.token, "u1.999.sig")
        XCTAssertEqual(session.userName, "Nick")
        XCTAssertTrue(session.isAdmin)
        XCTAssertEqual(session.serverName, "nick")
        XCTAssertEqual(session.expiresAt ?? 0, 1790000000, accuracy: 0.5)
        let request = try XCTUnwrap(t.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://192.168.1.20:47811/api/viewer-session")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer viewer-tok")
        XCTAssertEqual(t.jsonBody(of: request)["deviceName"] as? String, "Living Room")
    }

    func testDeviceNameIsOptional() async throws {
        let t = MockTransport()
        t.route("/api/viewer-session", method: "POST", body: okBody)
        _ = await ViewerSessionService.exchange(viewerToken: "v", serverBase: lan(), deviceName: nil, transport: t)
        XCTAssertNil(try XCTUnwrap(t.requests.first).httpBody)
    }

    func testViewerTokenIsNeverSentOverPlainHttpToAPublicHost() async {
        let t = MockTransport()
        for text in ["http://example.com", "http://8.8.8.8:47811", "ftp://192.168.1.20"] {
            let result = await ViewerSessionService.exchange(viewerToken: "v", serverBase: URL(string: text)!, transport: t)
            XCTAssertEqual(result, .insecureAddress, text)
        }
        XCTAssertTrue(t.requests.isEmpty)
        XCTAssertTrue(ViewerSessionService.isSafeForViewerToken(URL(string: "https://nick.home.beebo.tv:47811")!))
        XCTAssertTrue(ViewerSessionService.isSafeForViewerToken(URL(string: "http://192.168.1.20:47811")!))
        XCTAssertTrue(ViewerSessionService.isSafeForViewerToken(URL(string: "http://beebo-pc:47811")!))
    }

    func testStatusMapping() async {
        let cases: [(Int, ViewerExchangeResult)] = [(401, .unauthorized), (403, .forbidden), (404, .notSupported), (429, .rateLimited), (500, .failed(500))]
        for (status, expected) in cases {
            let t = MockTransport()
            t.route("/api/viewer-session", method: "POST", status: status, body: "{}")
            let result = await ViewerSessionService.exchange(viewerToken: "v", serverBase: lan(), transport: t)
            XCTAssertEqual(result, expected, "status \(status)")
        }
    }

    func testSuccessWithoutTokenIsAFailure() async {
        let t = MockTransport()
        t.route("/api/viewer-session", method: "POST", body: "{\"user\":{}}")
        let result = await ViewerSessionService.exchange(viewerToken: "v", serverBase: lan(), transport: t)
        XCTAssertEqual(result, .failed(200))
    }

    func testNetworkFailureIsReported() async {
        let result = await ViewerSessionService.exchange(viewerToken: "v", serverBase: lan(), transport: MockTransport())
        XCTAssertEqual(result, .unreachable(.cannotConnect))
    }

    func testCandidatesPreferTheLastTypedAddressThenTheDirectHomeName() {
        XCTAssertEqual(PairedSignIn.candidates(lastAddress: "192.168.1.20", houseName: "nick").map(\.absoluteString),
                       ["http://192.168.1.20:47811", "https://192.168.1.20:47811", "https://nick.home.beebo.tv:47811"])
        XCTAssertEqual(PairedSignIn.candidates(lastAddress: nil, houseName: "nick").map(\.absoluteString),
                       ["https://nick.home.beebo.tv:47811"])
        XCTAssertEqual(PairedSignIn.candidates(lastAddress: "nick.beebo.tv", houseName: "nick").map(\.absoluteString),
                       ["https://nick.home.beebo.tv:47811"])
        XCTAssertEqual(PairedSignIn.candidates(lastAddress: "nick.home.beebo.tv", houseName: "nick").map(\.absoluteString),
                       ["https://nick.home.beebo.tv:47811"])
    }

    func testCompleteSignsInOnTheFirstServerThatAnswers() async {
        let t = MockTransport()
        t.route("/api/viewer-session", host: "nick.home.beebo.tv", method: "POST", body: okBody)
        let result = await PairedSignIn.complete(viewerToken: "v", houseName: "nick", lastAddress: "192.168.1.20", deviceName: "TV", transport: t)
        XCTAssertEqual(result, .signedIn(SavedSession(baseURL: "https://nick.home.beebo.tv:47811", token: "u1.999.sig", userId: "u1", userName: "Nick")))
        XCTAssertEqual(t.requests.compactMap { $0.url?.host }, ["192.168.1.20", "192.168.1.20", "nick.home.beebo.tv"])
    }

    func testCompleteFallsBackWhenTheServerHasNoRoute() async {
        let t = MockTransport()
        t.route("/api/viewer-session", method: "POST", status: 404, body: "{}")
        let result = await PairedSignIn.complete(viewerToken: "v", houseName: "nick", lastAddress: nil, deviceName: nil, transport: t)
        XCTAssertEqual(result, .notSupported)
    }

    func testCompleteStopsOnRefusalAndReportsRateLimit() async {
        let t = MockTransport()
        t.route("/api/viewer-session", method: "POST", status: 401, body: "{}")
        guard case .failed(let message) = await PairedSignIn.complete(viewerToken: "v", houseName: "nick", lastAddress: "192.168.1.20", deviceName: nil, transport: t) else {
            return XCTFail("expected failure")
        }
        XCTAssertTrue(message.contains("didn't accept"))
        XCTAssertEqual(t.requests.count, 1)

        t.route("/api/viewer-session", method: "POST", status: 429, body: "{}")
        guard case .failed(let limited) = await PairedSignIn.complete(viewerToken: "v", houseName: "nick", lastAddress: nil, deviceName: nil, transport: t) else {
            return XCTFail("expected failure")
        }
        XCTAssertTrue(limited.contains("Too many"))
    }

    func testCompleteReportsUnreachableServers() async {
        let result = await PairedSignIn.complete(viewerToken: "v", houseName: "nick", lastAddress: nil, deviceName: nil, transport: MockTransport())
        guard case .failed(let message) = result else { return XCTFail("expected failure") }
        XCTAssertTrue(message.contains("Can't reach the server"), message)
    }
}
