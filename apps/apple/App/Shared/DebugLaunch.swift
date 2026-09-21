import Foundation
import BeeboKit

/// Launch-time switches for the CI simulator smoke test (tools/mock-server). They exist only in
/// Debug builds; in Release every value is nil and nothing reads the environment.
enum DebugLaunch {
    #if DEBUG
    private static let env = ProcessInfo.processInfo.environment
    static let server: String? = env["BEEBO_DEMO_SERVER"]
    static let username: String? = env["BEEBO_DEMO_USER"]
    static let password: String? = env["BEEBO_DEMO_PASS"]
    static let tab: String? = env["BEEBO_DEMO_TAB"]
    static let openTitle: String? = env["BEEBO_DEMO_OPEN"]
    static let playTitle: String? = env["BEEBO_DEMO_PLAY"]
    #else
    static let server: String? = nil
    static let username: String? = nil
    static let password: String? = nil
    static let tab: String? = nil
    static let openTitle: String? = nil
    static let playTitle: String? = nil
    #endif

    /// "movie:movie-006:Frozen Orbit 006" or "tv:show-02:Northern Lights 02" -> a reference to open or play.
    static func ref(from spec: String?) -> MediaRef? {
        guard let spec else { return nil }
        let parts = spec.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2, !parts[1].isEmpty else { return nil }
        let kind: MediaKind = parts[0] == "tv" ? .tv : .movie
        return MediaRef(kind: kind, id: parts[1], title: parts.count > 2 ? parts[2] : parts[1])
    }
}
