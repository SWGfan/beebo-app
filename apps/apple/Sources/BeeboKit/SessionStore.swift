import Foundation

public struct SavedSession: Codable, Equatable, Sendable {
    public let baseURL: String
    public let token: String
    public let userId: String
    public let userName: String

    public init(baseURL: String, token: String, userId: String, userName: String) {
        self.baseURL = baseURL
        self.token = token
        self.userId = userId
        self.userName = userName
    }
}

public protocol SessionStoring: AnyObject {
    func load() -> SavedSession?
    func save(_ session: SavedSession)
    func clear()
}

public final class InMemorySessionStore: SessionStoring {
    private let lock = NSLock()
    private var stored: SavedSession?

    public init(_ initial: SavedSession? = nil) {
        stored = initial
    }

    public func load() -> SavedSession? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    public func save(_ session: SavedSession) {
        lock.lock()
        defer { lock.unlock() }
        stored = session
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        stored = nil
    }
}

#if canImport(Security)
import Security

public final class KeychainSessionStore: SessionStoring {
    private let service: String
    private let account = "session"

    public init(service: String = "com.beeboentertainment.apple.session") {
        self.service = service
    }

    private var identity: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func load() -> SavedSession? {
        var query = identity
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(SavedSession.self, from: data)
    }

    public func save(_ session: SavedSession) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        SecItemDelete(identity as CFDictionary)
        var add = identity
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    public func clear() {
        SecItemDelete(identity as CFDictionary)
    }
}
#endif

public enum DeepLink: Equatable, Sendable {
    case pair(code: String?)
    case connect(address: String)

    public static func parse(_ url: URL) -> DeepLink? {
        guard url.scheme?.lowercased() == "beebo" else { return nil }
        let host = (url.host ?? "").lowercased()
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
        let target = host.isEmpty ? path : host
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first(where: { $0.name.lowercased() == name })?.value?.trimmingCharacters(in: .whitespaces)
        }
        switch target {
        case "pair", "tv-link", "tvlink":
            let code = value("code").flatMap { PairingCodes.normalize($0) }
            return .pair(code: code.map(PairingCodes.format))
        case "connect", "server":
            guard let address = value("server") ?? value("address"), !address.isEmpty else { return nil }
            return .connect(address: address)
        default:
            return nil
        }
    }
}
