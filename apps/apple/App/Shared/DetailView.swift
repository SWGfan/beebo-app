import SwiftUI
import BeeboKit

@MainActor
final class DetailModel: ObservableObject {
    @Published private(set) var summary: TitleSummary?
    @Published private(set) var seasons: [Season] = []
    @Published private(set) var runtimeSeconds: Double?
    @Published private(set) var isLoading = false
    @Published private(set) var failure: String?
    @Published var selectedSeasonID: Int?

    private var loadedID: String?

    func load(_ start: TitleSummary, api: BeeboAPI?) async {
        guard let api, loadedID != start.id else { return }
        loadedID = start.id
        summary = start
        isLoading = true
        failure = nil
        switch start.kind {
        case .movie: await loadMovie(start, api: api)
        case .tv: await loadShow(start, api: api)
        }
        isLoading = false
    }

    private func loadMovie(_ start: TitleSummary, api: BeeboAPI) async {
        async let enriched = enrich(start, api: api)
        async let info = try? await api.playbackInfo(kind: .movie, id: start.id)
        summary = await enriched
        let loaded = await info
        if let seconds = loaded?.durationSec, seconds > 0 { runtimeSeconds = seconds }
    }

    private func loadShow(_ start: TitleSummary, api: BeeboAPI) async {
        async let enriched = enrich(start, api: api)
        do {
            let response = try await api.episodes(showKey: start.id)
            seasons = response.seasons
            let target = EpisodeSelector.playTarget(seasons: response.seasons)
            selectedSeasonID = response.seasons.first(where: { $0.episodes.contains(where: { $0.id == target?.episode.id }) })?.id
                ?? response.seasons.first?.id
            var merged = await enriched
            merged = merged.withOverview(response.show?.overview)
            if merged.poster == nil, let poster = response.show?.poster {
                merged = merged.merging(TitleSummary(kind: .tv, id: merged.id, title: "", poster: poster))
            }
            summary = merged
        } catch {
            summary = await enriched
            failure = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
    }

    private func enrich(_ start: TitleSummary, api: BeeboAPI) async -> TitleSummary {
        guard start.needsDetails, !start.title.isEmpty else { return start }
        do {
            switch start.kind {
            case .movie:
                let page = try await api.movies(query: start.title, offset: 0, limit: 25)
                if let match = page.items.first(where: { $0.id == start.id }) { return start.merging(TitleSummary(match)) }
            case .tv:
                let page = try await api.shows(query: start.title, offset: 0, limit: 25)
                if let match = page.items.first(where: { $0.id == start.id }) { return start.merging(TitleSummary(match)) }
            }
        } catch {
            return start
        }
        return start
    }

    var playTarget: PlayTarget? {
        EpisodeSelector.playTarget(seasons: seasons)
    }

    var selectedSeason: Season? {
        seasons.first(where: { $0.id == selectedSeasonID }) ?? seasons.first
    }
}

struct DetailView: View {
    let summary: TitleSummary

    @EnvironmentObject private var model: AppModel
    @StateObject private var detail = DetailModel()

    private var title: TitleSummary { detail.summary ?? summary }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                header
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    metadata
                    if let overview = title.overview, !overview.isEmpty {
                        Text(overview)
                            .font(Theme.Fonts.body)
                            .foregroundColor(Theme.Palette.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    actions
                }
                .padding(.horizontal, Theme.Spacing.screenEdge)
                if title.kind == .tv {
                    episodes
                }
            }
            .padding(.bottom, Theme.Spacing.xl)
        }
        .screenTitle(title.title)
        .task { await detail.load(summary, api: model.api) }
    }

    // MARK: Header

    private var header: some View {
        Color.clear
            .frame(height: Theme.Layout.backdropHeight)
            .frame(maxWidth: .infinity)
            .overlay {
                RemoteImage(url: model.api?.absoluteURL(title.backdrop ?? title.poster))
            }
            .overlay {
                LinearGradient(colors: [.clear, Theme.Palette.background], startPoint: .top, endPoint: .bottom)
            }
            .overlay(alignment: .bottomLeading) {
                Text(title.title)
                    .font(Theme.Fonts.screenTitle)
                    .foregroundColor(Theme.Palette.textPrimary)
                    .lineLimit(3)
                    .padding(.horizontal, Theme.Spacing.screenEdge)
                    .padding(.bottom, Theme.Spacing.sm)
                    .accessibilityAddTraits(.isHeader)
            }
            .clipped()
    }

    private var metadata: some View {
        let line = MetadataLine.make(
            year: title.year, quality: title.quality,
            runtimeSeconds: detail.runtimeSeconds, score: title.voteAverage
        )
        return VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            if !line.isEmpty {
                Text(line)
                    .font(Theme.Fonts.metadata)
                    .foregroundColor(Theme.Palette.textSecondary)
            }
            if !title.genres.isEmpty {
                Text(title.genres.prefix(4).joined(separator: ", "))
                    .font(Theme.Fonts.metadata)
                    .foregroundColor(Theme.Palette.textSecondary)
            }
        }
    }

    // MARK: Actions

    @ViewBuilder
    private var actions: some View {
        if title.kind == .movie {
            movieActions
        } else if let target = detail.playTarget {
            showActions(target)
        } else if detail.isLoading {
            ProgressView().accessibilityLabel("Loading episodes")
        }
    }

    private var movieActions: some View {
        let resume = model.resumeSeconds(forID: title.id)
        return HStack(spacing: Theme.Spacing.md) {
            Button {
                model.play(title.ref, resumeSeconds: resume)
            } label: {
                Label(resume.map { "Resume from \(TimeFormat.clock($0))" } ?? "Play", systemImage: "play.fill")
                    .font(Theme.Fonts.button)
            }
            .primaryActionStyle()
            .accessibilityHint("Plays this movie")
            if resume != nil {
                Button {
                    model.play(title.ref)
                } label: {
                    Label("Start over", systemImage: "arrow.counterclockwise")
                        .font(Theme.Fonts.button)
                }
            }
        }
    }

    private func showActions(_ target: PlayTarget) -> some View {
        let code = EpisodeLabel.code(target.episode)
        let verb = target.resumes ? "Resume" : "Play"
        return Button {
            play(target.episode, resumePercent: target.resumes ? target.episode.watchedPercent : nil)
        } label: {
            Label(code.isEmpty ? verb : "\(verb) \(code)", systemImage: "play.fill")
                .font(Theme.Fonts.button)
        }
        .primaryActionStyle()
        .accessibilityHint("Plays the next episode for you")
    }

    private func play(_ episode: Episode, resumePercent: Int?) {
        let code = EpisodeLabel.code(episode)
        let name = code.isEmpty ? title.title : "\(title.title) \u{2014} \(code)"
        let ref = MediaRef(kind: .tv, id: episode.id, title: name, poster: title.poster)
        model.play(ref, resumeSeconds: model.resumeSeconds(forID: episode.id), resumePercent: resumePercent)
    }

    // MARK: Episodes

    @ViewBuilder
    private var episodes: some View {
        if let failure = detail.failure {
            MessageView(systemImage: "exclamationmark.triangle", title: "Couldn't load episodes", message: failure)
                .frame(maxWidth: .infinity)
        } else if !detail.seasons.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                seasonPicker
                if let season = detail.selectedSeason {
                    LazyVStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        ForEach(season.episodes) { episode in
                            episodeRow(episode)
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.screenEdge)
                }
            }
        }
    }

    private var seasonPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(detail.seasons) { season in
                    Button {
                        detail.selectedSeasonID = season.id
                    } label: {
                        Text(season.displayName)
                            .font(Theme.Fonts.button)
                            .padding(.horizontal, Theme.Spacing.sm)
                    }
                    .accessibilityAddTraits(season.id == detail.selectedSeasonID ? .isSelected : [])
                    .accessibilityHint("Shows this season's episodes")
                }
            }
            .padding(.horizontal, Theme.Spacing.screenEdge)
            .padding(.vertical, Theme.Spacing.sm)
        }
    }

    private func episodeRow(_ episode: Episode) -> some View {
        Button {
            play(episode, resumePercent: episode.isWatched ? nil : episode.watchedPercent)
        } label: {
            HStack(spacing: Theme.Spacing.md) {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(EpisodeLabel.code(episode))
                        .font(Theme.Fonts.cardSubtitle)
                        .foregroundColor(Theme.Palette.textSecondary)
                    Text(EpisodeLabel.displayTitle(episode))
                        .font(Theme.Fonts.cardTitle)
                        .foregroundColor(Theme.Palette.textPrimary)
                        .multilineTextAlignment(.leading)
                    if !episode.isWatched && episode.watchedPercent > 0 {
                        ProgressBar(fraction: Double(episode.watchedPercent) / 100)
                            .frame(maxWidth: 240)
                    }
                }
                Spacer(minLength: Theme.Spacing.sm)
                if episode.isWatched {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(Theme.Palette.success)
                        .accessibilityHidden(true)
                }
                Image(systemName: "play.fill")
                    .foregroundColor(Theme.Palette.textSecondary)
                    .accessibilityHidden(true)
            }
            .padding(Theme.Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .rowButtonStyle()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(episodeAccessibility(episode))
        .accessibilityHint("Plays this episode")
        .accessibilityAddTraits(.isButton)
    }

    private func episodeAccessibility(_ episode: Episode) -> String {
        var parts = [EpisodeLabel.code(episode), EpisodeLabel.displayTitle(episode)].filter { !$0.isEmpty }
        if episode.isWatched {
            parts.append("watched")
        } else if episode.watchedPercent > 0 {
            parts.append("\(episode.watchedPercent) percent watched")
        }
        return parts.joined(separator: ", ")
    }
}
