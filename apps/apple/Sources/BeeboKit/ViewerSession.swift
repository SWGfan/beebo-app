import Foundation

public struct ViewerSession: Equatable, Sendable {
    public let token: String
    public let userId: String
    public let userName: String
    public let isAdmin: Bool
    public let expiresAt: Double?
    public let serverName: String?

    public init(token: String, userId: String, userName: String, isAdmin: Bool, expiresAt: Double?, serverName: String?) {
        self.token = token
        self.userId = userId
        self.userName = userName
        self.isAdmin = isAdmin
        self.expiresAt = expiresAt
        self.serverName = serverName
    }
}

public enum ViewerExchangeResult: Equatable, Sendable {
    case success(ViewerSession)
    case unauthorized
    case forbidden
    case rateLimited
    case notSupported
    case insecureAddress
    case unreachable(NetworkFailure)
    case failed(Int)
}

/// The one place that knows how a phone-approved viewer token becomes a normal home-server session:
/// `POST <serverBase>/api/viewer-session` with `Authorization: Bearer <viewer token>`.
public enum ViewerSessionService {
    public static let path = "/api/viewer-session"

    public static func exchange(
        viewerToken: String,
        serverBase: URL,
        deviceName: String? = nil,
        transport: HTTPTransport = URLSessionTransport()
    ) async -> ViewerExchangeResult {
        guard isSafeForViewerToken(serverBase) else { return .insecureAddress }
        guard let url = ServerAddress.resolve(path, against: serverBase) else { return .failed(0) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(viewerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let name = deviceName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty,
           let body = try? JSONSerialization.data(withJSONObject: ["deviceName": String(name.prefix(40))]) {
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch {
            return .unreachable(NetworkFailure.classify(error))
        }
        switch response.statusCode {
        case 200..<300:
            return parse(data).map(ViewerExchangeResult.success) ?? .failed(response.statusCode)
        case 401: return .unauthorized
        case 403: return .forbidden
        case 404: return .notSupported
        case 429: return .rateLimited
        default: return .failed(response.statusCode)
        }
    }

    public static func isSafeForViewerToken(_ base: URL) -> Bool {
        if base.scheme?.lowercased() == "https" { return true }
        guard base.scheme?.lowercased() == "http", let host = base.host else { return false }
        return ServerAddress.isLocalHost(host)
    }

    static func parse(_ data: Data) -> ViewerSession? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = object["token"] as? String, !token.isEmpty else { return nil }
        let user = object["user"] as? [String: Any]
        let server = object["server"] as? [String: Any]
        return ViewerSession(
            token: token,
            userId: (user?["id"] as? String) ?? "",
            userName: (user?["name"] as? String) ?? "",
            isAdmin: (user?["isAdmin"] as? Bool) ?? false,
            expiresAt: (object["expiresAt"] as? NSNumber)?.doubleValue,
            serverName: server?["name"] as? String
        )
    }
}

public enum PairedSignInResult: Equatable, Sendable {
    case signedIn(SavedSession)
    case notSupported
    case failed(String)
}

public enum PairedSignIn {
    public static func candidates(lastAddress: String?, houseName: String) -> [URL] {
        var out: [URL] = []
        if let last = lastAddress?.trimmingCharacters(in: .whitespacesAndNewlines), !last.isEmpty,
           ServerAddress.beeboTvName(last) == nil {
            out += ServerAddress.candidates(last)
        }
        if let direct = URL(string: ServerAddress.directHomeAddress(forName: houseName)), !out.contains(direct) {
            out.append(direct)
        }
        return out
    }

    public static func complete(
        viewerToken: String,
        houseName: String,
        lastAddress: String?,
        deviceName: String?,
        transport: HTTPTransport = URLSessionTransport()
    ) async -> PairedSignInResult {
        let bases = candidates(lastAddress: lastAddress, houseName: houseName)
        var lastProblem = "Couldn't reach your Beebo server. Check that it is switched on and on this network."
        for base in bases {
            let result = await ViewerSessionService.exchange(
                viewerToken: viewerToken, serverBase: base, deviceName: deviceName, transport: transport
            )
            switch result {
            case .success(let session):
                let name = session.userName.isEmpty ? houseName : session.userName
                return .signedIn(SavedSession(baseURL: base.absoluteString, token: session.token, userId: session.userId, userName: name))
            case .notSupported:
                return .notSupported
            case .unreachable(let failure):
                lastProblem = APIError.networkMessage(failure)
            case .insecureAddress:
                lastProblem = "For your safety, phone sign-in only runs over https or on your home network."
            case .rateLimited:
                return .failed("Too many tries. Wait a few minutes and try again.")
            case .unauthorized, .forbidden:
                return .failed("Your server didn't accept the sign-in. Ask for a new code and try again, or use your address, username and password.")
            case .failed(let status):
                lastProblem = "Your server answered with an error (HTTP \(status))."
            }
        }
        return .failed(lastProblem)
    }
}
