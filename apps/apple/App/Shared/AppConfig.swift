import Foundation
import UIKit

enum AppConfig {
    /// The Worker returns a 12-hour viewer token; the home server swaps it for a normal session at
    /// /api/viewer-session (see ViewerSessionService). Servers without that route answer 404 and
    /// the TV falls back to the typed sign-in.
    static let phonePairingEnabled = true

    static let managedAtText = "Beebo services are managed at beebo.tv."
    static let manageWebsite = "beebo.tv"

    static var deviceName: String {
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "Apple TV" : name
    }

    static var deviceModel: String {
        #if os(tvOS)
        return "Apple TV"
        #else
        return UIDevice.current.model
        #endif
    }

    static var versionString: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(version) (\(build))"
    }
}
