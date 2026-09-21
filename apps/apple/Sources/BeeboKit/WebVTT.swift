import Foundation

public struct SubtitleCue: Equatable, Sendable {
    public let start: Double
    public let end: Double
    public let text: String

    public init(start: Double, end: Double, text: String) {
        self.start = start
        self.end = end
        self.text = text
    }
}

public enum WebVTT {
    public static func parse(_ raw: String) -> [SubtitleCue] {
        var text = raw
        if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
        text = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let blocks = text.components(separatedBy: "\n\n")
        var cues: [SubtitleCue] = []
        for block in blocks {
            let lines = block.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
            guard !lines.isEmpty else { continue }
            let first = lines[0]
            if first.hasPrefix("WEBVTT") || first.hasPrefix("NOTE") || first.hasPrefix("STYLE") || first.hasPrefix("REGION") {
                if !lines.contains(where: { $0.contains("-->") }) { continue }
            }
            guard let timingIndex = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
            guard let (start, end) = parseTiming(lines[timingIndex]) else { continue }
            let body = lines[(timingIndex + 1)...].joined(separator: "\n")
            let cleaned = clean(body)
            if cleaned.isEmpty || end <= start { continue }
            cues.append(SubtitleCue(start: start, end: end, text: cleaned))
        }
        return cues.sorted { $0.start < $1.start }
    }

    static func parseTiming(_ line: String) -> (Double, Double)? {
        let parts = line.components(separatedBy: "-->")
        guard parts.count == 2 else { return nil }
        let left = parts[0].trimmingCharacters(in: .whitespaces)
        let rightToken = parts[1].trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 1).first.map(String.init) ?? ""
        guard let start = parseTimestamp(left), let end = parseTimestamp(rightToken) else { return nil }
        return (start, end)
    }

    static func parseTimestamp(_ text: String) -> Double? {
        let normalized = text.replacingOccurrences(of: ",", with: ".")
        let pieces = normalized.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard pieces.count == 2 || pieces.count == 3 else { return nil }
        guard let seconds = Double(pieces[pieces.count - 1]) else { return nil }
        guard let minutes = Double(pieces[pieces.count - 2]) else { return nil }
        let parsedHours: Double? = pieces.count == 3 ? Double(pieces[0]) : 0.0
        guard let hours = parsedHours else { return nil }
        return hours * 3600 + minutes * 60 + seconds
    }

    static func clean(_ body: String) -> String {
        var out = ""
        var inTag = false
        for character in body {
            if character == "<" { inTag = true; continue }
            if character == ">" && inTag { inTag = false; continue }
            if !inTag { out.append(character) }
        }
        out = out
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&lrm;", with: "")
            .replacingOccurrences(of: "&rlm;", with: "")
            .replacingOccurrences(of: "&amp;", with: "&")
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public struct SubtitleTimeline: Sendable {
    private let cues: [SubtitleCue]

    public init(cues: [SubtitleCue]) {
        self.cues = cues.sorted { $0.start < $1.start }
    }

    public var isEmpty: Bool { cues.isEmpty }
    public var count: Int { cues.count }

    public func text(at time: Double) -> String? {
        guard !cues.isEmpty else { return nil }
        var low = 0
        var high = cues.count
        while low < high {
            let mid = (low + high) / 2
            if cues[mid].start <= time { low = mid + 1 } else { high = mid }
        }
        var active: [String] = []
        var index = low - 1
        var scanned = 0
        while index >= 0 && scanned < 8 {
            let cue = cues[index]
            if cue.start <= time && time < cue.end { active.append(cue.text) }
            index -= 1
            scanned += 1
        }
        guard !active.isEmpty else { return nil }
        return active.reversed().joined(separator: "\n")
    }
}
