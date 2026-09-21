import Foundation

public enum SignInService {
    public static let tunnelOnlyMessage =
        "That address is Beebo's away-from-home page, which needs Beebo's remote-access tunnel. This version of the Apple app connects directly. Use your Beebo computer's address on your home network, for example 192.168.1.20, or your home address like nick.home.beebo.tv."

    public static func signIn(
        address: String,
        username: String,
        password: String,
        transport: HTTPTransport = URLSessionTransport()
    ) async throws -> SavedSession {
        let typed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { throw APIError.invalidAddress }
        if ServerAddress.beeboTvName(typed) != nil {
            throw APIError.refused(code: "tunnel_only", message: tunnelOnlyMessage)
        }
        let candidates = ServerAddress.candidates(typed)
        guard !candidates.isEmpty else { throw APIError.invalidAddress }
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !password.isEmpty else {
            throw APIError.refused(code: "missing_credentials", message: "Enter your Beebo username and password.")
        }

        var firstFailure: Error?
        for candidate in candidates {
            let api = BeeboAPI(baseURL: candidate, transport: transport)
            do {
                let ping = try await api.ping()
                guard ping.isBeeboServer else {
                    throw APIError.refused(code: "not_beebo", message: "Reached something at that address, but it isn't a Beebo server.")
                }
            } catch let error as APIError {
                if case .refused = error { throw error }
                if case .network = error {
                    firstFailure = firstFailure ?? error
                    continue
                }
                if case .notFound = error {
                    throw APIError.refused(code: "not_beebo", message: "Reached something at that address, but it isn't a Beebo server.")
                }
                throw error
            }
            let login = try await api.login(username: name, password: password)
            guard login.ok, let token = login.token, !token.isEmpty, let user = login.user else {
                throw APIError.refused(code: login.locked ? "locked" : "bad_credentials", message: login.failureMessage)
            }
            return SavedSession(baseURL: candidate.absoluteString, token: token, userId: user.id, userName: user.name)
        }
        throw firstFailure ?? APIError.network(.cannotConnect)
    }
}
