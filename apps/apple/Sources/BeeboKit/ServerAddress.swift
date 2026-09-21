import Foundation

public enum ServerAddress {
    public static let defaultPort = BeeboKitInfo.defaultServerPort

    private static let localSuffixes = [".local", ".lan", ".home", ".home.arpa", ".internal"]

    public static func isLocalHost(_ rawHost: String) -> Bool {
        var host = rawHost.trimmingCharacters(in: .whitespaces).lowercased()
        if host.hasPrefix("[") && host.hasSuffix("]") {
            host = String(host.dropFirst().dropLast())
        }
        if host.hasSuffix(".") {
            host.removeLast()
        }
        if host.isEmpty { return false }
        if host == "localhost" || host.hasSuffix(".localhost") { return true }
        if let octets = ipv4(host) { return isPrivateIPv4(octets) }
        if host.contains(":") { return isLocalIPv6(host) }
        if localSuffixes.contains(where: { host.hasSuffix($0) }) { return true }
        return !host.contains(".") && host.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" }
    }

    private static func ipv4(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var out: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(part), n <= 255 else {
                return nil
            }
            out.append(n)
        }
        return out
    }

    private static func isPrivateIPv4(_ a: [Int]) -> Bool {
        switch (a[0], a[1]) {
        case (10, _), (127, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        case (100, 64...127): return true
        default: return false
        }
    }

    private static func isLocalIPv6(_ raw: String) -> Bool {
        let host = raw.split(separator: "%", maxSplits: 1).first.map(String.init) ?? raw
        if host == "::1" { return true }
        if host.hasPrefix("::ffff:") {
            let tail = String(host.dropFirst("::ffff:".count))
            return ipv4(tail).map(isPrivateIPv4) ?? false
        }
        guard let first = host.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first,
              !first.isEmpty, first.count <= 4, let value = Int(first, radix: 16) else { return false }
        return (value & 0xFE00) == 0xFC00 || (value & 0xFFC0) == 0xFE80
    }

    public static func beeboTvName(_ raw: String) -> String? {
        var host = raw.trimmingCharacters(in: .whitespaces).lowercased()
        if host.contains("://"), let h = URLComponents(string: host)?.host { host = h }
        if let colon = host.firstIndex(of: ":") { host = String(host[..<colon]) }
        if host.hasSuffix(".") { host.removeLast() }
        guard host.hasSuffix(".beebo.tv") else { return nil }
        let label = String(host.dropLast(".beebo.tv".count))
        if label.isEmpty || label.contains(".") || label == "www" { return nil }
        guard label.allSatisfy({ ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") || $0 == "-" }) else { return nil }
        return label
    }

    public static func isTunnelOnly(_ url: URL) -> Bool {
        guard let host = url.host else { return false }
        return beeboTvName(host) != nil
    }

    public static func directHomeAddress(forName name: String) -> String {
        "https://\(name).home.beebo.tv:\(defaultPort)"
    }

    public static func normalize(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let scheme = explicitScheme(of: trimmed)
        if trimmed.contains("://") && scheme == nil { return nil }
        return build(from: trimmed, scheme: scheme)
    }

    public static func candidates(_ raw: String) -> [URL] {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        if trimmed.contains("://") {
            return normalize(trimmed).map { [$0] } ?? []
        }
        var out: [URL] = []
        for scheme in ["http", "https"] {
            if let url = build(from: trimmed, scheme: scheme, forcedScheme: true), !out.contains(url) {
                out.append(url)
            }
        }
        if let preferred = normalize(trimmed) {
            out.removeAll { $0 == preferred }
            out.insert(preferred, at: 0)
        }
        if let host = out.first?.host, !isLocalHost(host) {
            out = out.filter { $0.scheme == "https" }
        }
        return out
    }

    private static func explicitScheme(of text: String) -> String? {
        guard let range = text.range(of: "://") else { return nil }
        let scheme = text[..<range.lowerBound].lowercased()
        return (scheme == "http" || scheme == "https") ? scheme : nil
    }

    private static func build(from text: String, scheme: String?, forcedScheme: Bool = false) -> URL? {
        let withoutScheme: String
        if let range = text.range(of: "://") {
            withoutScheme = String(text[range.upperBound...])
        } else {
            withoutScheme = text
        }
        guard let components = URLComponents(string: "x://" + withoutScheme), var host = components.host?.lowercased() else {
            return nil
        }
        if host.hasSuffix(".") { host.removeLast() }
        if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        guard !host.isEmpty else { return nil }
        let local = isLocalHost(host)
        var chosen = scheme ?? (local ? "http" : "https")
        if chosen == "http" && !local && !forcedScheme { chosen = "https" }
        if chosen == "http" && !local { return nil }
        var port = components.port
        if port == nil && (local || host.hasSuffix(".home.beebo.tv")) { port = defaultPort }
        var out = URLComponents()
        out.scheme = chosen
        out.host = host.contains(":") ? "[" + host + "]" : host
        out.port = port
        return out.url
    }

    public static func resolve(_ path: String?, against base: URL) -> URL? {
        guard let raw = path?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let lower = raw.lowercased()
        let full: String
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            full = raw
        } else {
            var baseString = base.absoluteString
            while baseString.hasSuffix("/") { baseString.removeLast() }
            full = raw.hasPrefix("/") ? baseString + raw : baseString + "/" + raw
        }
        return URL(string: full) ?? URL(string: full.addingPercentEncoding(withAllowedCharacters: permissive) ?? "")
    }

    private static let permissive: CharacterSet = {
        var set = CharacterSet.urlQueryAllowed
        set.formUnion(.urlPathAllowed)
        set.insert(charactersIn: "%#")
        return set
    }()

    public static func display(_ url: URL) -> String {
        let host = url.host ?? url.absoluteString
        if let port = url.port { return "\(host):\(port)" }
        return host
    }
}
