import Foundation

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = URLSessionTransport.makeSession()) {
        self.session = session
    }

    public static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 120
        configuration.waitsForConnectivity = false
        configuration.httpAdditionalHeaders = ["User-Agent": "\(BeeboKitInfo.userAgentToken)/1"]
        return URLSession(configuration: configuration)
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

public enum NetworkFailure: Equatable, Sendable {
    case offline
    case cannotFindHost
    case cannotConnect
    case timedOut
    case secureConnectionFailed
    case blockedByTransportSecurity
    case other(String)

    public static func classify(_ error: Error) -> NetworkFailure {
        guard let urlError = error as? URLError else { return .other(error.localizedDescription) }
        switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
            return .offline
        case .cannotFindHost, .dnsLookupFailed:
            return .cannotFindHost
        case .cannotConnectToHost:
            return .cannotConnect
        case .timedOut:
            return .timedOut
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected:
            return .secureConnectionFailed
        case .appTransportSecurityRequiresSecureConnection:
            return .blockedByTransportSecurity
        default:
            return .other(urlError.localizedDescription)
        }
    }
}

public enum APIError: Error, Equatable, LocalizedError, Sendable {
    case invalidAddress
    case unauthorized
    case forbidden(String)
    case notFound
    case server(Int)
    case refused(code: String, message: String)
    case network(NetworkFailure)
    case badResponse

    public var errorDescription: String? { userMessage }

    public var userMessage: String {
        switch self {
        case .invalidAddress:
            return "That server address doesn't look right. Try something like 192.168.1.20 or my-pc.local."
        case .unauthorized:
            return "Your sign-in has expired. Please sign in again."
        case .forbidden(let code):
            return Self.forbiddenMessage(code)
        case .notFound:
            return "The server doesn't have that. If it keeps happening, update your Beebo server."
        case .server(let status):
            return "The server answered with an error (HTTP \(status)). Try again in a moment."
        case .refused(_, let message):
            return message
        case .network(let failure):
            return Self.networkMessage(failure)
        case .badResponse:
            return "The server's answer wasn't what Beebo expected. Update the Beebo server and this app, then try again."
        }
    }

    public var isUnauthorized: Bool {
        if case .unauthorized = self { return true }
        return false
    }

    static func forbiddenMessage(_ code: String) -> String {
        switch code {
        case "history_private": return "This profile keeps its viewing history private."
        case "insufficient_scope": return "This sign-in isn't allowed to read that."
        case "admin_only": return "Only the server owner can do that."
        default: return "The server refused that request."
        }
    }

    static func networkMessage(_ failure: NetworkFailure) -> String {
        switch failure {
        case .offline:
            return "This device isn't connected to a network."
        case .cannotFindHost:
            return "That server address can't be found. Check the spelling, and that this device is on the same network as your Beebo computer."
        case .cannotConnect:
            return "Can't reach the server. Is the Beebo computer switched on, is the address right, and is Local Network access allowed for Beebo in Settings?"
        case .timedOut:
            return "The server didn't answer in time."
        case .secureConnectionFailed:
            return "A secure connection couldn't be made. Use the server's IP address (plain http on your home network) or its https address with a valid certificate."
        case .blockedByTransportSecurity:
            return "Plain http is only allowed to devices on your home network. Use https for anything else."
        case .other(let text):
            return "Network error: \(text)"
        }
    }
}
