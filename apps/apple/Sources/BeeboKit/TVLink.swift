import Foundation

public struct TVRequest: Equatable, Sendable {
    public let deviceName: String
    public let deviceModel: String
    public let requestedMinutesAgo: Int
    public let expiresIn: Int

    public init(deviceName: String, deviceModel: String, requestedMinutesAgo: Int, expiresIn: Int) {
        self.deviceName = deviceName
        self.deviceModel = deviceModel
        self.requestedMinutesAgo = requestedMinutesAgo
        self.expiresIn = expiresIn
    }
}

public enum LinkError: Equatable, Sendable {
    case invalidCode
    case rateLimited
    case unauthorized
    case notAllowed
    case noHome
    case passwordReset
    case accountInactive
    case invalidCredentials
    case unavailable
    case offline
    case server
}

public enum LinkResult<Value: Sendable>: Sendable {
    case ok(Value)
    case refused(LinkError, retryAfter: Int = 0)
}

extension LinkResult: Equatable where Value: Equatable {}

public enum TVDecision: String, Sendable {
    case approve
    case deny
}

public protocol TVLinkService: Sendable {
    func lookup(token: String, userCode: String) async -> LinkResult<TVRequest>
    func decide(token: String, userCode: String, decision: TVDecision) async -> LinkResult<TVRequest>
}

public enum FindHomeResult: Equatable, Sendable {
    case found(name: String, token: String)
    case failed(LinkError)
}

public enum TVLinkParsing {
    private static func object(_ data: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private static func int(_ value: Any?) -> Int? {
        if let n = value as? Int { return n }
        if let d = value as? Double { return Int(d) }
        return nil
    }

    static func refusal(status: Int, body: [String: Any]?) -> LinkResult<TVRequest> {
        let error = body?["error"] as? String
        switch true {
        case status == 429:
            return .refused(.rateLimited, retryAfter: min(3600, max(0, int(body?["retry_after"]) ?? 0)))
        case status == 401:
            return .refused(.unauthorized)
        case error == "not_allowed":
            return .refused(.notAllowed)
        case error == "no_home":
            return .refused(.noHome)
        case error == "password_reset_required":
            return .refused(.passwordReset)
        case error == "invalid_code":
            return .refused(.invalidCode)
        case status == 404:
            return .refused(.unavailable)
        default:
            return .refused(.server)
        }
    }

    private static func request(_ body: [String: Any]) -> TVRequest {
        let name = (body["device_name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "TV"
        return TVRequest(
            deviceName: name,
            deviceModel: (body["device_model"] as? String) ?? "",
            requestedMinutesAgo: max(0, int(body["requested_minutes_ago"]) ?? 0),
            expiresIn: max(0, int(body["expires_in"]) ?? 0)
        )
    }

    public static func parseLookup(status: Int, data: Data) -> LinkResult<TVRequest> {
        let body = object(data)
        if status == 200, let body, body["device_name"] != nil { return .ok(request(body)) }
        return refusal(status: status, body: body)
    }

    public static func parseDecision(status: Int, data: Data, decision: TVDecision) -> LinkResult<TVRequest> {
        let body = object(data)
        let expected = decision == .approve ? "approved" : "denied"
        if status == 200, let body, (body["status"] as? String) == expected { return .ok(request(body)) }
        return refusal(status: status, body: body)
    }

    public static func parseFindHome(status: Int, data: Data) -> FindHomeResult {
        let body = object(data)
        if status == 200, let body, let name = body["name"] as? String, !name.isEmpty, let token = body["token"] as? String, !token.isEmpty {
            return .found(name: name, token: token)
        }
        switch status {
        case 401: return .failed(.invalidCredentials)
        case 402: return .failed(.accountInactive)
        case 429: return .failed(.rateLimited)
        case 404: return .failed(.unavailable)
        default: return .failed(.server)
        }
    }
}

public enum TVLinkMessages {
    public static func message(for error: LinkError, retryAfter: Int = 0) -> String {
        switch error {
        case .invalidCode:
            return "That code isn't right, or it has run out. Check the code on your TV. A new one appears every few minutes."
        case .rateLimited:
            let minutes = max(1, (retryAfter + 59) / 60)
            return "Too many tries. Wait \(minutes) minute\(minutes == 1 ? "" : "s") and try again."
        case .unauthorized:
            return "Your Beebo account sign-in didn't work. Sign in again, then try once more."
        case .notAllowed:
            return "This sign-in can't link a TV. Sign in with your own Beebo account."
        case .noHome:
            return "This account doesn't have a Beebo home yet, so there is nothing for a TV to connect to."
        case .passwordReset:
            return "This account needs a new password first."
        case .accountInactive:
            return "This Beebo account isn't active. Manage your account at beebo.tv."
        case .invalidCredentials:
            return "That email or password isn't right."
        case .unavailable:
            return "Linking a TV isn't available yet."
        case .offline:
            return "Couldn't reach Beebo. Check your connection and try again."
        case .server:
            return "Beebo didn't answer properly. Try again in a moment."
        }
    }

    public static func ago(minutes: Int) -> String {
        switch minutes {
        case ...0: return "just now"
        case 1: return "1 minute ago"
        default: return "\(minutes) minutes ago"
        }
    }
}
