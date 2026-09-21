import XCTest
@testable import BeeboKit

final class PairingCodeTests: XCTestCase {
    func testNormalizeAcceptsCaseHyphenAndSpaces() {
        XCTAssertEqual(PairingCodes.normalize("abcd-efgh"), "ABCDEFGH")
        XCTAssertEqual(PairingCodes.normalize(" AB CD_EF.GH "), "ABCDEFGH")
    }

    func testNormalizeRejectsWrongLengthAndAmbiguousSymbols() {
        XCTAssertNil(PairingCodes.normalize("ABCD"))
        XCTAssertNil(PairingCodes.normalize("ABCDEFGHJ"))
        XCTAssertNil(PairingCodes.normalize("ABCD-EFG0"))
        XCTAssertNil(PairingCodes.normalize("ABCD-EFGI"))
        XCTAssertNil(PairingCodes.normalize("ABCD-EFGO"))
        XCTAssertNil(PairingCodes.normalize(nil))
    }

    func testFormat() {
        XCTAssertEqual(PairingCodes.format("ABCDEFGH"), "ABCD-EFGH")
        XCTAssertEqual(PairingCodes.format("ABC"), "ABC")
    }

    func testFormatTypedAsThePersonTypes() {
        XCTAssertEqual(PairingCodes.formatTyped("ab"), "AB")
        XCTAssertEqual(PairingCodes.formatTyped("abcde"), "ABCD-E")
        XCTAssertEqual(PairingCodes.formatTyped("abcdefghjk"), "ABCD-EFGH")
        XCTAssertEqual(PairingCodes.formatTyped("a0b1c"), "ABC")
        XCTAssertEqual(PairingCodes.formatTyped("https://beebo.tv/tv?code=abcd-efgh"), "ABCD-EFGH")
    }

    func testFromLinkOrText() {
        XCTAssertEqual(PairingCodes.fromLinkOrText("https://beebo.tv/tv?code=ABCD-EFGH&x=1"), "ABCDEFGH")
        XCTAssertEqual(PairingCodes.fromLinkOrText("beebo://tv-link?code=abcdefgh"), "ABCDEFGH")
        XCTAssertEqual(PairingCodes.fromLinkOrText("abcd efgh"), "ABCDEFGH")
        XCTAssertNil(PairingCodes.fromLinkOrText("https://beebo.tv/tv"))
        XCTAssertNil(PairingCodes.fromLinkOrText(""))
        XCTAssertNil(PairingCodes.fromLinkOrText(nil))
    }
}

final class PairingParsingTests: XCTestCase {
    private func start(_ status: Int, _ json: String) -> StartResult {
        PairingParsing.parseStart(status: status, data: Data(json.utf8))
    }

    private func poll(_ status: Int, _ json: String) -> PollResult {
        PairingParsing.parsePoll(status: status, data: Data(json.utf8))
    }

    func testStartSuccess() {
        let json = "{\"device_code\":\"dev\",\"user_code\":\"ABCD-EFGH\",\"verification_uri\":\"https://beebo.tv/tv\",\"verification_uri_complete\":\"https://beebo.tv/tv?code=ABCD-EFGH\",\"expires_in\":600,\"interval\":5}"
        guard case .started(let session) = start(200, json) else { return XCTFail("expected started") }
        XCTAssertEqual(session.deviceCode, "dev")
        XCTAssertEqual(session.userCode, "ABCDEFGH")
        XCTAssertEqual(session.verificationURIComplete, "https://beebo.tv/tv?code=ABCD-EFGH")
        XCTAssertEqual(session.expiresIn, 600)
        XCTAssertEqual(session.interval, 5)
    }

    func testStartClampsAndFillsInMissingFields() {
        let json = "{\"device_code\":\"dev\",\"user_code\":\"ABCDEFGH\",\"verification_uri\":\"https://beebo.tv/tv\",\"expires_in\":5000,\"interval\":1}"
        guard case .started(let session) = start(200, json) else { return XCTFail("expected started") }
        XCTAssertEqual(session.expiresIn, 600)
        XCTAssertEqual(session.interval, 2)
        XCTAssertEqual(session.verificationURIComplete, "https://beebo.tv/tv?code=ABCD-EFGH")
    }

    func testStartFailures() {
        XCTAssertEqual(start(404, "{\"error\":\"not_found\"}"), .failed(PairFailure(.unavailable)))
        XCTAssertEqual(start(429, "{\"retry_after\":90}"), .failed(PairFailure(.rateLimited, retryAfter: 90)))
        XCTAssertEqual(start(503, "oops"), .failed(PairFailure(.server)))
        XCTAssertEqual(start(200, "{\"device_code\":\"dev\",\"user_code\":\"bad\"}"), .failed(PairFailure(.badResponse)))
        XCTAssertEqual(start(200, "[]"), .failed(PairFailure(.badResponse)))
    }

    func testPollStatuses() {
        XCTAssertEqual(poll(200, "{\"status\":\"pending\",\"interval\":5}"), .pending(interval: 5))
        XCTAssertEqual(poll(429, "{\"status\":\"slow_down\",\"interval\":10}"), .slowDown(interval: 10))
        XCTAssertEqual(poll(200, "{\"status\":\"expired\",\"error\":\"expired_token\"}"), .expired)
        XCTAssertEqual(poll(200, "{\"status\":\"denied\",\"error\":\"no_home\"}"), .denied(reason: "no_home"))
        XCTAssertEqual(poll(200, "{\"status\":\"denied\"}"), .denied(reason: "access_denied"))
    }

    func testPollApproved() {
        XCTAssertEqual(poll(200, "{\"status\":\"approved\",\"name\":\"nick\",\"token\":\"tok\",\"expiresAt\":1789999999,\"iceServers\":[]}"),
                       .approved(name: "nick", token: "tok", expiresAt: 1789999999))
        XCTAssertEqual(poll(200, "{\"status\":\"approved\",\"name\":\"nick\"}"), .failed(PairFailure(.badResponse)))
    }

    func testPollFailures() {
        XCTAssertEqual(poll(404, "{\"error\":\"not_found\"}"), .failed(PairFailure(.unavailable)))
        XCTAssertEqual(poll(500, "nope"), .failed(PairFailure(.server)))
        XCTAssertEqual(poll(400, "{\"error\":\"invalid_request\"}"), .failed(PairFailure(.badResponse)))
    }

    func testBackoffSchedule() {
        XCTAssertEqual([1, 2, 3, 4, 5].map { PairingTiming.backoff(failures: $0) }, [5, 10, 20, 30, 30])
        XCTAssertEqual(PairingTiming.clampInterval(1), 2)
        XCTAssertEqual(PairingTiming.clampInterval(99), 30)
        XCTAssertEqual(PairingTiming.retryDelay(PairFailure(.rateLimited, retryAfter: 60), failures: 1), 60)
        XCTAssertEqual(PairingTiming.retryDelay(PairFailure(.rateLimited, retryAfter: 1), failures: 1), 5)
        XCTAssertEqual(PairingTiming.retryDelay(PairFailure(.offline), failures: 3), 20)
    }

    func testDeviceSpecificCopy() {
        XCTAssertTrue(PairingMessages.problem(PairFailure(.rateLimited, retryAfter: 60), retryIn: 60).contains("1 minute"))
        XCTAssertTrue(PairingMessages.denied("no_home").contains("Beebo home"))
        XCTAssertTrue(PairingMessages.denied("access_denied").contains("said no"))
        XCTAssertTrue(PairingMessages.steps(address: "beebo.tv/tv").contains("beebo.tv/tv"))
    }
}

final class FakePairingService: PairingService, @unchecked Sendable {
    private let lock = NSLock()
    private var starts: [StartResult]
    private var polls: [String: [PollResult]]
    private(set) var startCount = 0
    private(set) var polledCodes: [String] = []

    init(starts: [StartResult], polls: [String: [PollResult]]) {
        self.starts = starts
        self.polls = polls
    }

    func start(deviceName: String, deviceModel: String) async -> StartResult {
        nextStart()
    }

    func poll(deviceCode: String) async -> PollResult {
        nextPoll(deviceCode)
    }

    private func nextStart() -> StartResult {
        lock.withLock {
            startCount += 1
            return starts.isEmpty ? .failed(PairFailure(.server)) : starts.removeFirst()
        }
    }

    private func nextPoll(_ deviceCode: String) -> PollResult {
        lock.withLock {
            polledCodes.append(deviceCode)
            guard var queue = polls[deviceCode], !queue.isEmpty else { return .pending(interval: 5) }
            let next = queue.count > 1 ? queue.removeFirst() : queue[0]
            polls[deviceCode] = queue
            return next
        }
    }
}

func session(_ device: String, code: String = "ABCDEFGH", expiresIn: Int = 600, interval: Int = 5) -> PairSession {
    PairSession(deviceCode: device, userCode: code, verificationURI: "https://beebo.tv/tv",
                verificationURIComplete: "https://beebo.tv/tv?code=" + PairingCodes.format(code), expiresIn: expiresIn, interval: interval)
}

@MainActor
final class PairingControllerTests: XCTestCase {
    private final class Clock {
        var time: Double = 1_000_000
        var sleeps: [Double] = []
    }

    private func controller(_ service: FakePairingService, clock: Clock = Clock()) -> (PairingController, Clock) {
        let c = PairingController(
            service: service, deviceName: "Living Room", deviceModel: "Apple TV",
            now: { Date(timeIntervalSince1970: clock.time) },
            sleep: { seconds in
                clock.sleeps.append(seconds)
                clock.time += seconds
            }
        )
        return (c, clock)
    }

    func testApprovalAfterPending() async {
        let service = FakePairingService(
            starts: [.started(session("d1"))],
            polls: ["d1": [.pending(interval: 5), .pending(interval: 5), .approved(name: "nick", token: "tok", expiresAt: 42)]]
        )
        let (c, clock) = controller(service)
        var states: [PairingState] = []
        c.onState = { states.append($0) }
        let outcome = await c.run()
        XCTAssertEqual(outcome, .approved(name: "nick", token: "tok", expiresAt: 42))
        XCTAssertEqual(clock.sleeps, [5, 5, 5])
        XCTAssertEqual(service.startCount, 1)
        XCTAssertTrue(states.contains(.showCode(userCode: "ABCD-EFGH", verificationURI: "https://beebo.tv/tv", verificationURIWithCode: "https://beebo.tv/tv?code=ABCD-EFGH", offline: false)))
    }

    func testSlowDownIncreasesTheInterval() async {
        let service = FakePairingService(
            starts: [.started(session("d1"))],
            polls: ["d1": [.slowDown(interval: 5), .pending(interval: 10), .approved(name: "n", token: "t", expiresAt: 1)]]
        )
        let (c, clock) = controller(service)
        _ = await c.run()
        XCTAssertEqual(clock.sleeps, [5, 10, 10])
    }

    func testDenied() async {
        let service = FakePairingService(starts: [.started(session("d1"))], polls: ["d1": [.denied(reason: "no_home")]])
        let (c, _) = controller(service)
        let outcome = await c.run()
        XCTAssertEqual(outcome, .denied(reason: "no_home"))
    }

    func testUnavailableAtStartFallsBackToTypedSignIn() async {
        let service = FakePairingService(starts: [.failed(PairFailure(.unavailable))], polls: [:])
        let (c, _) = controller(service)
        let outcome = await c.run()
        XCTAssertEqual(outcome, .unavailable)
    }

    func testUnavailableDuringPollingFallsBack() async {
        let service = FakePairingService(starts: [.started(session("d1"))], polls: ["d1": [.failed(PairFailure(.unavailable))]])
        let (c, _) = controller(service)
        let outcome = await c.run()
        XCTAssertEqual(outcome, .unavailable)
    }

    func testExpiredSessionStartsOverWithAFreshCode() async {
        let service = FakePairingService(
            starts: [.started(session("d1", code: "AAAAAAAA", expiresIn: 30)), .started(session("d2", code: "BBBBBBBB"))],
            polls: ["d1": [.pending(interval: 5)], "d2": [.approved(name: "n", token: "t", expiresAt: 1)]]
        )
        let (c, _) = controller(service)
        var codes: [String] = []
        c.onState = { if case .showCode(let code, _, _, _) = $0 { codes.append(code) } }
        let outcome = await c.run()
        XCTAssertEqual(outcome, .approved(name: "n", token: "t", expiresAt: 1))
        XCTAssertEqual(service.startCount, 2)
        XCTAssertEqual(codes, ["AAAA-AAAA", "BBBB-BBBB"])
    }

    func testServerSideExpiryAlsoStartsOver() async {
        let service = FakePairingService(
            starts: [.started(session("d1")), .started(session("d2"))],
            polls: ["d1": [.expired], "d2": [.approved(name: "n", token: "t", expiresAt: 1)]]
        )
        let (c, _) = controller(service)
        let outcome = await c.run()
        XCTAssertEqual(outcome, .approved(name: "n", token: "t", expiresAt: 1))
        XCTAssertEqual(service.startCount, 2)
    }

    func testRateLimitedStartWaitsForRetryAfter() async {
        let service = FakePairingService(
            starts: [.failed(PairFailure(.rateLimited, retryAfter: 60)), .started(session("d1"))],
            polls: ["d1": [.approved(name: "n", token: "t", expiresAt: 1)]]
        )
        let (c, clock) = controller(service)
        _ = await c.run()
        XCTAssertEqual(clock.sleeps.first, 60)
    }

    func testOfflinePollsBackOffAndKeepTheCodeOnScreen() async {
        let service = FakePairingService(
            starts: [.started(session("d1"))],
            polls: ["d1": [.failed(PairFailure(.offline)), .failed(PairFailure(.offline)), .failed(PairFailure(.offline)), .pending(interval: 5), .approved(name: "n", token: "t", expiresAt: 1)]]
        )
        let (c, clock) = controller(service)
        var offlineSeen = false
        var recovered = false
        c.onState = {
            if case .showCode(_, _, _, let offline) = $0 {
                if offline { offlineSeen = true } else if offlineSeen { recovered = true }
            }
        }
        let outcome = await c.run()
        XCTAssertEqual(outcome, .approved(name: "n", token: "t", expiresAt: 1))
        XCTAssertEqual(clock.sleeps, [5, 5, 10, 20, 5])
        XCTAssertTrue(offlineSeen)
        XCTAssertTrue(recovered)
    }

    func testStartFailuresRetryWithBackoff() async {
        let service = FakePairingService(
            starts: [.failed(PairFailure(.offline)), .failed(PairFailure(.offline)), .started(session("d1"))],
            polls: ["d1": [.approved(name: "n", token: "t", expiresAt: 1)]]
        )
        let (c, clock) = controller(service)
        var waits: [Int] = []
        c.onState = { if case .waiting(_, let retryIn) = $0 { waits.append(retryIn) } }
        _ = await c.run()
        XCTAssertEqual(waits, [5, 10])
        XCTAssertEqual(Array(clock.sleeps.prefix(2)), [5, 10])
    }

    func testCancellationStopsTheLoop() async {
        let service = FakePairingService(starts: [.started(session("d1"))], polls: [:])
        let c = PairingController(
            service: service, deviceName: "TV", deviceModel: "",
            now: Date.init,
            sleep: { _ in try await Task.sleep(nanoseconds: 20_000_000) }
        )
        let task = Task { await c.run() }
        try? await Task.sleep(nanoseconds: 60_000_000)
        task.cancel()
        let outcome = await task.value
        XCTAssertEqual(outcome, .cancelled)
    }
}

final class TVLinkTests: XCTestCase {
    func testLookupParsing() {
        let ok = TVLinkParsing.parseLookup(status: 200, data: Data("{\"ok\":true,\"device_name\":\"Living Room\",\"device_model\":\"Apple TV 4K\",\"requested_minutes_ago\":2,\"expires_in\":540}".utf8))
        XCTAssertEqual(ok, .ok(TVRequest(deviceName: "Living Room", deviceModel: "Apple TV 4K", requestedMinutesAgo: 2, expiresIn: 540)))
    }

    func testLookupRefusals() {
        func refusal(_ status: Int, _ body: String) -> LinkResult<TVRequest> {
            TVLinkParsing.parseLookup(status: status, data: Data(body.utf8))
        }
        XCTAssertEqual(refusal(404, "{\"error\":\"invalid_code\"}"), .refused(.invalidCode))
        XCTAssertEqual(refusal(401, "{}"), .refused(.unauthorized))
        XCTAssertEqual(refusal(403, "{\"error\":\"not_allowed\"}"), .refused(.notAllowed))
        XCTAssertEqual(refusal(403, "{\"error\":\"no_home\"}"), .refused(.noHome))
        XCTAssertEqual(refusal(403, "{\"error\":\"password_reset_required\"}"), .refused(.passwordReset))
        XCTAssertEqual(refusal(429, "{\"retry_after\":120}"), .refused(.rateLimited, retryAfter: 120))
        XCTAssertEqual(refusal(404, "{}"), .refused(.unavailable))
        XCTAssertEqual(refusal(500, "x"), .refused(.server))
    }

    func testDecisionParsing() {
        let approved = TVLinkParsing.parseDecision(status: 200, data: Data("{\"ok\":true,\"status\":\"approved\",\"device_name\":\"TV\"}".utf8), decision: .approve)
        XCTAssertEqual(approved, .ok(TVRequest(deviceName: "TV", deviceModel: "", requestedMinutesAgo: 0, expiresIn: 0)))
        let mismatch = TVLinkParsing.parseDecision(status: 200, data: Data("{\"ok\":true,\"status\":\"denied\",\"device_name\":\"TV\"}".utf8), decision: .approve)
        XCTAssertEqual(mismatch, .refused(.server))
        XCTAssertEqual(TVDecision.approve.rawValue, "approve")
        XCTAssertEqual(TVDecision.deny.rawValue, "deny")
    }

    func testFindHomeParsing() {
        XCTAssertEqual(TVLinkParsing.parseFindHome(status: 200, data: Data("{\"name\":\"nick\",\"token\":\"t\",\"iceServers\":[]}".utf8)), .found(name: "nick", token: "t"))
        XCTAssertEqual(TVLinkParsing.parseFindHome(status: 401, data: Data("{\"error\":\"invalid_credentials\"}".utf8)), .failed(.invalidCredentials))
        XCTAssertEqual(TVLinkParsing.parseFindHome(status: 402, data: Data("{}".utf8)), .failed(.accountInactive))
        XCTAssertEqual(TVLinkParsing.parseFindHome(status: 200, data: Data("{}".utf8)), .failed(.server))
    }

    func testEveryLinkErrorHasCopy() {
        let all: [LinkError] = [.invalidCode, .rateLimited, .unauthorized, .notAllowed, .noHome, .passwordReset,
                                .accountInactive, .invalidCredentials, .unavailable, .offline, .server]
        for error in all { XCTAssertFalse(TVLinkMessages.message(for: error, retryAfter: 90).isEmpty) }
        XCTAssertEqual(TVLinkMessages.ago(minutes: 0), "just now")
        XCTAssertEqual(TVLinkMessages.ago(minutes: 1), "1 minute ago")
        XCTAssertEqual(TVLinkMessages.ago(minutes: 7), "7 minutes ago")
    }

    func testHTTPPairingSendsTheRightRequests() async {
        let t = MockTransport()
        t.route("/tvpair/start", method: "POST", body: "{\"device_code\":\"dev\",\"user_code\":\"ABCD-EFGH\",\"verification_uri\":\"https://beebo.tv/tv\",\"expires_in\":600,\"interval\":5}")
        t.route("/tvpair/poll", method: "POST", body: "{\"status\":\"pending\",\"interval\":5}")
        t.route("/tvpair/lookup", method: "POST", body: "{\"ok\":true,\"device_name\":\"TV\"}")
        t.route("/tvpair/approve", method: "POST", body: "{\"ok\":true,\"status\":\"approved\",\"device_name\":\"TV\"}")
        t.route("/rtc/find-home", method: "POST", body: "{\"name\":\"nick\",\"token\":\"acct\",\"iceServers\":[]}")
        let http = PairingHTTP(transport: t)

        let started = await http.start(deviceName: "Living Room", deviceModel: "Apple TV")
        guard case .started = started else { return XCTFail("expected started") }
        let startReq = t.requests(to: "/tvpair/start")[0]
        XCTAssertEqual(startReq.url?.absoluteString, "https://login.beebo.tv/tvpair/start")
        XCTAssertEqual(t.jsonBody(of: startReq)["device_name"] as? String, "Living Room")
        XCTAssertNil(startReq.value(forHTTPHeaderField: "Authorization"))

        let polled = await http.poll(deviceCode: "dev")
        XCTAssertEqual(polled, .pending(interval: 5))
        XCTAssertEqual(t.jsonBody(of: t.requests(to: "/tvpair/poll")[0])["device_code"] as? String, "dev")

        let home = await http.findHome(email: "a@b.c", password: "pw")
        XCTAssertEqual(home, .found(name: "nick", token: "acct"))

        let looked = await http.lookup(token: "acct", userCode: "ABCDEFGH")
        guard case .ok(let request) = looked else { return XCTFail("expected ok") }
        XCTAssertEqual(request.deviceName, "TV")
        XCTAssertEqual(t.requests(to: "/tvpair/lookup")[0].value(forHTTPHeaderField: "Authorization"), "Bearer acct")

        let decided = await http.decide(token: "acct", userCode: "ABCDEFGH", decision: .approve)
        guard case .ok = decided else { return XCTFail("expected ok") }
        XCTAssertEqual(t.jsonBody(of: t.requests(to: "/tvpair/approve")[0])["decision"] as? String, "approve")
    }

    func testHTTPPairingReportsOfflineWhenNothingAnswers() async {
        let http = PairingHTTP(transport: MockTransport())
        let started = await http.start(deviceName: "TV", deviceModel: "")
        XCTAssertEqual(started, .failed(PairFailure(.offline)))
        let polled = await http.poll(deviceCode: "x")
        XCTAssertEqual(polled, .failed(PairFailure(.offline)))
    }
}

final class DeepLinkTests: XCTestCase {
    private func parse(_ text: String) -> DeepLink? {
        URL(string: text).flatMap(DeepLink.parse)
    }

    func testPairLinks() {
        XCTAssertEqual(parse("beebo://pair?code=abcd-efgh"), .pair(code: "ABCD-EFGH"))
        XCTAssertEqual(parse("beebo://tv-link?code=ABCDEFGH"), .pair(code: "ABCD-EFGH"))
        XCTAssertEqual(parse("beebo://pair"), .pair(code: nil))
        XCTAssertEqual(parse("beebo://pair?code=nope"), .pair(code: nil))
        XCTAssertEqual(parse("BEEBO://PAIR?code=abcdefgh"), .pair(code: "ABCD-EFGH"))
    }

    func testConnectLinks() {
        XCTAssertEqual(parse("beebo://connect?server=192.168.1.20"), .connect(address: "192.168.1.20"))
        XCTAssertNil(parse("beebo://connect"))
    }

    func testForeignLinksAreIgnored() {
        XCTAssertNil(parse("https://beebo.tv/tv?code=ABCDEFGH"))
        XCTAssertNil(parse("beebo://unknown"))
    }
}
