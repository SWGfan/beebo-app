import Foundation

public enum PairingCodes {
    public static let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
    public static let length = 8

    public static func normalize(_ input: String?) -> String? {
        let cleaned = (input ?? "").uppercased().filter { !$0.isWhitespace && $0 != "-" && $0 != "_" && $0 != "." }
        guard cleaned.count == length, cleaned.allSatisfy({ alphabet.contains($0) }) else { return nil }
        return cleaned
    }

    public static func format(_ code: String) -> String {
        guard code.count == length else { return code }
        return String(code.prefix(4)) + "-" + String(code.suffix(4))
    }

    public static func formatTyped(_ raw: String) -> String {
        if raw.lowercased().contains("code="), let fromLink = fromLinkOrText(raw) { return format(fromLink) }
        let symbols = String(raw.uppercased().filter { alphabet.contains($0) }.prefix(length))
        guard symbols.count > 4 else { return symbols }
        return String(symbols.prefix(4)) + "-" + String(symbols.dropFirst(4))
    }

    public static func fromLinkOrText(_ text: String?) -> String? {
        let trimmed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let range = trimmed.range(of: "code=", options: .caseInsensitive) else { return normalize(trimmed) }
        let tail = trimmed[range.upperBound...]
        let value = String(tail.prefix { $0 != "&" && $0 != "#" && !$0.isWhitespace })
        return normalize(value.removingPercentEncoding ?? value)
    }
}

public struct PairSession: Equatable, Sendable {
    public let deviceCode: String
    public let userCode: String
    public let verificationURI: String
    public let verificationURIComplete: String
    public let expiresIn: Int
    public let interval: Int

    public init(deviceCode: String, userCode: String, verificationURI: String, verificationURIComplete: String, expiresIn: Int, interval: Int) {
        self.deviceCode = deviceCode
        self.userCode = userCode
        self.verificationURI = verificationURI
        self.verificationURIComplete = verificationURIComplete
        self.expiresIn = expiresIn
        self.interval = interval
    }
}

public struct PairFailure: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case offline
        case rateLimited
        case unavailable
        case server
        case badResponse
    }

    public let kind: Kind
    public let retryAfter: Int

    public init(_ kind: Kind, retryAfter: Int = 0) {
        self.kind = kind
        self.retryAfter = retryAfter
    }
}

public enum StartResult: Equatable, Sendable {
    case started(PairSession)
    case failed(PairFailure)
}

public enum PollResult: Equatable, Sendable {
    case pending(interval: Int)
    case slowDown(interval: Int)
    case approved(name: String, token: String, expiresAt: Int)
    case denied(reason: String)
    case expired
    case failed(PairFailure)
}

public protocol PairingService: Sendable {
    func start(deviceName: String, deviceModel: String) async -> StartResult
    func poll(deviceCode: String) async -> PollResult
}

public enum PairingParsing {
    private static func object(_ data: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private static func int(_ value: Any?) -> Int? {
        if let n = value as? Int { return n }
        if let d = value as? Double { return Int(d) }
        return nil
    }

    static func failure(status: Int, body: [String: Any]?) -> PairFailure {
        if status == 404 { return PairFailure(.unavailable) }
        if status == 429 {
            let retry = int(body?["retry_after"]) ?? int(body?["interval"]) ?? 0
            return PairFailure(.rateLimited, retryAfter: min(3600, max(0, retry)))
        }
        if status >= 500 { return PairFailure(.server) }
        return PairFailure(.badResponse)
    }

    public static func parseStart(status: Int, data: Data) -> StartResult {
        let body = object(data)
        guard status == 200, let body else { return .failed(failure(status: status, body: body)) }
        guard let device = body["device_code"] as? String, !device.isEmpty,
              let user = PairingCodes.normalize(body["user_code"] as? String) else {
            return .failed(PairFailure(.badResponse))
        }
        let uri = (body["verification_uri"] as? String) ?? ""
        let complete = (body["verification_uri_complete"] as? String) ?? (uri.isEmpty ? "" : uri + "?code=" + PairingCodes.format(user))
        let expires = min(600, max(30, int(body["expires_in"]) ?? 600))
        let interval = PairingTiming.clampInterval(int(body["interval"]) ?? 5)
        return .started(PairSession(
            deviceCode: device, userCode: user, verificationURI: uri,
            verificationURIComplete: complete, expiresIn: expires, interval: interval
        ))
    }

    public static func parsePoll(status: Int, data: Data) -> PollResult {
        guard let body = object(data) else { return .failed(failure(status: status, body: nil)) }
        switch body["status"] as? String {
        case "pending":
            return .pending(interval: int(body["interval"]) ?? 5)
        case "slow_down":
            return .slowDown(interval: int(body["interval"]) ?? 10)
        case "expired":
            return .expired
        case "denied":
            return .denied(reason: (body["error"] as? String) ?? "access_denied")
        case "approved":
            guard let name = body["name"] as? String, !name.isEmpty, let token = body["token"] as? String, !token.isEmpty else {
                return .failed(PairFailure(.badResponse))
            }
            return .approved(name: name, token: token, expiresAt: int(body["expiresAt"]) ?? 0)
        default:
            return .failed(failure(status: status, body: body))
        }
    }
}

public struct PairingHTTP: PairingService, TVLinkService {
    public static let defaultBase = URL(string: "https://login.beebo.tv")!

    let transport: HTTPTransport
    let base: URL

    public init(transport: HTTPTransport = URLSessionTransport(), base: URL = PairingHTTP.defaultBase) {
        self.transport = transport
        self.base = base
    }

    private func post(_ path: String, _ body: [String: Any], bearer: String? = nil) async -> (Int, Data)? {
        guard let url = URL(string: base.absoluteString + path),
              let payload = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = payload
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        guard let (data, response) = try? await transport.send(request) else { return nil }
        return (response.statusCode, data)
    }

    public func start(deviceName: String, deviceModel: String) async -> StartResult {
        guard let (status, data) = await post("/tvpair/start", ["device_name": deviceName, "device_model": deviceModel]) else {
            return .failed(PairFailure(.offline))
        }
        return PairingParsing.parseStart(status: status, data: data)
    }

    public func poll(deviceCode: String) async -> PollResult {
        guard let (status, data) = await post("/tvpair/poll", ["device_code": deviceCode]) else {
            return .failed(PairFailure(.offline))
        }
        return PairingParsing.parsePoll(status: status, data: data)
    }

    public func lookup(token: String, userCode: String) async -> LinkResult<TVRequest> {
        guard let (status, data) = await post("/tvpair/lookup", ["user_code": userCode], bearer: token) else {
            return .refused(.offline)
        }
        return TVLinkParsing.parseLookup(status: status, data: data)
    }

    public func decide(token: String, userCode: String, decision: TVDecision) async -> LinkResult<TVRequest> {
        guard let (status, data) = await post("/tvpair/approve", ["user_code": userCode, "decision": decision.rawValue], bearer: token) else {
            return .refused(.offline)
        }
        return TVLinkParsing.parseDecision(status: status, data: data, decision: decision)
    }

    public func findHome(email: String, password: String) async -> FindHomeResult {
        guard let (status, data) = await post("/rtc/find-home", ["email": email, "password": password]) else {
            return .failed(.offline)
        }
        return TVLinkParsing.parseFindHome(status: status, data: data)
    }
}

public enum PairingState: Equatable, Sendable {
    case starting
    case showCode(userCode: String, verificationURI: String, verificationURIWithCode: String, offline: Bool)
    case waiting(PairFailure, retryIn: Int)
}

public enum PairingOutcome: Equatable, Sendable {
    case approved(name: String, token: String, expiresAt: Int)
    case denied(reason: String)
    case unavailable
    case cancelled
}

public enum PairingTiming {
    public static let minInterval = 2
    public static let maxInterval = 30
    public static let graceSeconds: Double = 15

    public static func clampInterval(_ seconds: Int) -> Int {
        min(maxInterval, max(minInterval, seconds))
    }

    public static func backoff(failures: Int) -> Int {
        min(maxInterval, 5 << min(3, max(0, failures - 1)))
    }

    public static func retryDelay(_ failure: PairFailure, failures: Int) -> Int {
        if failure.kind == .rateLimited && failure.retryAfter > 0 { return min(900, max(5, failure.retryAfter)) }
        return backoff(failures: failures)
    }
}

@MainActor
public final class PairingController {

    public private(set) var state: PairingState = .starting {
        didSet { onState?(state) }
    }

    public var onState: ((PairingState) -> Void)?

    private let service: PairingService
    private let deviceName: String
    private let deviceModel: String
    private let now: () -> Date
    private let sleep: (Double) async throws -> Void

    public init(
        service: PairingService,
        deviceName: String,
        deviceModel: String,
        now: @escaping () -> Date = Date.init,
        sleep: @escaping (Double) async throws -> Void = { seconds in
            try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
        }
    ) {
        self.service = service
        self.deviceName = deviceName
        self.deviceModel = deviceModel
        self.now = now
        self.sleep = sleep
    }

    public func run() async -> PairingOutcome {
        var startFailures = 0
        while true {
            if Task.isCancelled { return .cancelled }
            if case .waiting = state {} else { state = .starting }
            switch await service.start(deviceName: deviceName, deviceModel: deviceModel) {
            case .failed(let failure):
                if failure.kind == .unavailable { return .unavailable }
                startFailures += 1
                let wait = PairingTiming.retryDelay(failure, failures: startFailures)
                state = .waiting(failure, retryIn: wait)
                do { try await sleep(Double(wait)) } catch { return .cancelled }
            case .started(let session):
                startFailures = 0
                switch await pollSession(session) {
                case .some(let outcome): return outcome
                case .none: continue
                }
            }
        }
    }

    private func pollSession(_ session: PairSession) async -> PairingOutcome? {
        state = .showCode(
            userCode: PairingCodes.format(session.userCode),
            verificationURI: session.verificationURI,
            verificationURIWithCode: session.verificationURIComplete,
            offline: false
        )
        let deadline = now().addingTimeInterval(Double(session.expiresIn) + PairingTiming.graceSeconds)
        var base = PairingTiming.clampInterval(session.interval)
        var wait = base
        var failures = 0
        while true {
            do { try await sleep(Double(wait)) } catch { return .cancelled }
            if Task.isCancelled { return .cancelled }
            if now() >= deadline { return nil }
            switch await service.poll(deviceCode: session.deviceCode) {
            case .pending(let interval):
                failures = 0
                markOffline(false)
                base = max(base, PairingTiming.clampInterval(interval))
                wait = base
            case .slowDown(let interval):
                failures = 0
                markOffline(false)
                base = min(PairingTiming.maxInterval, max(base + 5, PairingTiming.clampInterval(interval)))
                wait = base
            case .approved(let name, let token, let expiresAt):
                return .approved(name: name, token: token, expiresAt: expiresAt)
            case .denied(let reason):
                return .denied(reason: reason)
            case .expired:
                return nil
            case .failed(let failure):
                switch failure.kind {
                case .unavailable:
                    return .unavailable
                case .rateLimited:
                    wait = max(base, min(900, max(1, failure.retryAfter)))
                default:
                    failures += 1
                    markOffline(true)
                    wait = PairingTiming.backoff(failures: failures)
                }
            }
        }
    }

    private func markOffline(_ offline: Bool) {
        guard case .showCode(let code, let uri, let complete, let current) = state, current != offline else { return }
        state = .showCode(userCode: code, verificationURI: uri, verificationURIWithCode: complete, offline: offline)
    }
}

public enum PairingMessages {
    public static let primaryAction = "Sign in with your phone"
    public static let typeInstead = "Sign in with a server address instead"
    public static let unavailable = "Signing in with your phone isn't available yet. Use your server address, username and password instead."
    public static let offlineBanner = "Can't reach Beebo right now. Trying again..."
    public static let serverNotSupported = "Your phone approved this TV, but your Beebo server is too old to sign in that way. Update the Beebo server, or use your address, username and password."

    public static func steps(address: String) -> String {
        "On your phone, open Beebo, go to Settings, then Link a TV, and enter the code. Or scan the code with your camera, or go to \(address)."
    }

    public static func problem(_ failure: PairFailure, retryIn: Int) -> String {
        switch failure.kind {
        case .offline: return "Can't reach Beebo. Check this TV's internet connection. Trying again in \(retryIn) seconds."
        case .rateLimited: return "Too many tries from this network. Trying again in \(minutes(retryIn))."
        case .unavailable: return "Phone sign-in isn't available yet."
        case .server, .badResponse: return "Beebo didn't answer properly. Trying again in \(retryIn) seconds."
        }
    }

    public static func denied(_ reason: String) -> String {
        switch reason {
        case "no_home": return "That account doesn't have a Beebo home set up yet, so there is nothing for this TV to connect to."
        case "password_reset_required": return "That account needs a new password first. Reset it, then try again."
        default: return "Your phone said no. If that wasn't you, nothing was signed in."
        }
    }

    private static func minutes(_ seconds: Int) -> String {
        let m = max(1, (seconds + 59) / 60)
        return "\(m) minute" + (m == 1 ? "" : "s")
    }
}
