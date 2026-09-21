import Foundation

public enum QualityPreference: String, CaseIterable, Identifiable, Sendable {
    case auto
    case p1080 = "1080p"
    case p720 = "720p"
    case p480 = "480p"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .auto: return "Best available"
        case .p1080: return "1080p"
        case .p720: return "720p"
        case .p480: return "480p"
        }
    }
}

public struct PlaybackPreferences: Equatable, Sendable {
    public var quality: QualityPreference
    public var subtitlesEnabled: Bool
    public var subtitleLanguage: String
    public var audioLanguage: String

    public init(
        quality: QualityPreference = .auto,
        subtitlesEnabled: Bool = false,
        subtitleLanguage: String = "en",
        audioLanguage: String = ""
    ) {
        self.quality = quality
        self.subtitlesEnabled = subtitlesEnabled
        self.subtitleLanguage = subtitleLanguage
        self.audioLanguage = audioLanguage
    }
}

public protocol SettingsStoring: AnyObject {
    var lastServerAddress: String? { get set }
    var playbackPreferences: PlaybackPreferences { get set }
}

public final class MemorySettings: SettingsStoring {
    public var lastServerAddress: String?
    public var playbackPreferences: PlaybackPreferences

    public init(lastServerAddress: String? = nil, playbackPreferences: PlaybackPreferences = PlaybackPreferences()) {
        self.lastServerAddress = lastServerAddress
        self.playbackPreferences = playbackPreferences
    }
}

public final class UserDefaultsSettings: SettingsStoring {
    private let defaults: UserDefaults

    private enum Key {
        static let server = "beebo.lastServerAddress"
        static let quality = "beebo.quality"
        static let subtitlesEnabled = "beebo.subtitlesEnabled"
        static let subtitleLanguage = "beebo.subtitleLanguage"
        static let audioLanguage = "beebo.audioLanguage"
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var lastServerAddress: String? {
        get { defaults.string(forKey: Key.server) }
        set {
            if let newValue, !newValue.isEmpty { defaults.set(newValue, forKey: Key.server) } else { defaults.removeObject(forKey: Key.server) }
        }
    }

    public var playbackPreferences: PlaybackPreferences {
        get {
            PlaybackPreferences(
                quality: defaults.string(forKey: Key.quality).flatMap(QualityPreference.init(rawValue:)) ?? .auto,
                subtitlesEnabled: defaults.bool(forKey: Key.subtitlesEnabled),
                subtitleLanguage: defaults.string(forKey: Key.subtitleLanguage) ?? LanguageCode.deviceLanguage,
                audioLanguage: defaults.string(forKey: Key.audioLanguage) ?? ""
            )
        }
        set {
            defaults.set(newValue.quality.rawValue, forKey: Key.quality)
            defaults.set(newValue.subtitlesEnabled, forKey: Key.subtitlesEnabled)
            defaults.set(newValue.subtitleLanguage, forKey: Key.subtitleLanguage)
            defaults.set(newValue.audioLanguage, forKey: Key.audioLanguage)
        }
    }
}

public enum LanguageCode {
    public static var deviceLanguage: String {
        Locale.current.language.languageCode?.identifier ?? "en"
    }

    private static let threeToTwo: [String: String] = [
        "eng": "en", "fre": "fr", "fra": "fr", "ger": "de", "deu": "de", "spa": "es", "ita": "it",
        "por": "pt", "jpn": "ja", "kor": "ko", "zho": "zh", "chi": "zh", "rus": "ru", "dut": "nl",
        "nld": "nl", "swe": "sv", "nor": "no", "dan": "da", "fin": "fi", "pol": "pl", "tur": "tr",
        "ara": "ar", "heb": "he", "hin": "hi", "ces": "cs", "cze": "cs", "hun": "hu", "ell": "el",
        "gre": "el", "ukr": "uk", "tha": "th", "vie": "vi", "ind": "id", "ron": "ro", "rum": "ro",
    ]

    public static func twoLetter(_ raw: String) -> String {
        let cleaned = raw.trimmingCharacters(in: .whitespaces).lowercased()
        guard !cleaned.isEmpty else { return "" }
        let base = cleaned.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? cleaned
        if base.count == 2 { return base }
        return threeToTwo[base] ?? base
    }

    public static func matches(_ a: String, _ b: String) -> Bool {
        let x = twoLetter(a)
        let y = twoLetter(b)
        return !x.isEmpty && x == y
    }
}
