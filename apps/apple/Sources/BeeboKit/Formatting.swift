import Foundation

public enum TimeFormat {
    public static func runtime(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 60 else { return "" }
        let totalMinutes = Int((seconds / 60).rounded())
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours == 0 { return "\(minutes)m" }
        if minutes == 0 { return "\(hours)h" }
        return "\(hours)h \(minutes)m"
    }

    public static func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0:00" }
        let total = Int(seconds)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours > 0 { return String(format: "%d:%02d:%02d", hours, minutes, secs) }
        return String(format: "%d:%02d", minutes, secs)
    }

    public static func remaining(position: Double, duration: Double) -> String {
        guard duration > 0, position >= 0 else { return "" }
        let left = duration - position
        guard left >= 60 else { return "Almost finished" }
        return "\(runtime(left)) left"
    }
}

public enum RatingFormat {
    public static func score(_ voteAverage: Double?) -> String? {
        guard let voteAverage, voteAverage > 0 else { return nil }
        return String(format: "%.1f", voteAverage)
    }
}

public enum EpisodeLabel {
    public static func code(season: Int?, episode: Int?) -> String {
        if let season, let episode { return "S\(season) \u{00B7} E\(episode)" }
        if let episode { return "Episode \(episode)" }
        return ""
    }

    public static func code(_ episode: Episode) -> String {
        code(season: episode.season, episode: episode.episode)
    }

    public static func displayTitle(_ episode: Episode) -> String {
        if let name = episode.episodeName?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return name }
        if let number = episode.episode { return "Episode \(number)" }
        let title = episode.title
        if let range = title.range(of: " \u{2014} ") { return String(title[range.upperBound...]) }
        return title
    }
}

public enum MetadataLine {
    public static func make(year: Int?, quality: String?, runtimeSeconds: Double?, score: Double?) -> String {
        var parts: [String] = []
        if let year, year > 0 { parts.append(String(year)) }
        if let runtimeSeconds {
            let text = TimeFormat.runtime(runtimeSeconds)
            if !text.isEmpty { parts.append(text) }
        }
        if let quality, !quality.isEmpty { parts.append(quality) }
        if let score = RatingFormat.score(score) { parts.append("\u{2605} \(score)") }
        return parts.joined(separator: "  \u{00B7}  ")
    }
}

public struct PlayTarget: Equatable, Sendable {
    public let episode: Episode
    public let resumes: Bool
}

public enum EpisodeSelector {
    public static func playTarget(seasons: [Season]) -> PlayTarget? {
        let all = seasons.flatMap { $0.episodes }
        guard !all.isEmpty else { return nil }
        if let inProgress = all.last(where: { $0.watched != true && $0.watchedPercent >= 1 && $0.watchedPercent < 95 }) {
            return PlayTarget(episode: inProgress, resumes: true)
        }
        if let lastWatchedIndex = all.lastIndex(where: { $0.isWatched }) {
            let next = lastWatchedIndex + 1
            if next < all.count { return PlayTarget(episode: all[next], resumes: false) }
            return PlayTarget(episode: all[0], resumes: false)
        }
        return PlayTarget(episode: all[0], resumes: false)
    }

    public static func unwatchedCount(in season: Season) -> Int {
        season.episodes.filter { !$0.isWatched }.count
    }
}
