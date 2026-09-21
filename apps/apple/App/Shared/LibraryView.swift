import SwiftUI
import BeeboKit

struct LibraryCard: Identifiable {
    let id: String
    let summary: TitleSummary
    let subtitle: String?
    let badge: String?
    let accessibilityText: String
}

struct MoviesView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        LibraryGridView(title: "Movies", noun: "movies", loader: model.movies) { movie in
            let summary = TitleSummary(movie)
            let yearText: String? = movie.year.map { String($0) }
            let detail = [yearText, movie.quality].compactMap { $0 }.joined(separator: " \u{00B7} ")
            return LibraryCard(
                id: movie.id, summary: summary, subtitle: detail.isEmpty ? nil : detail,
                badge: movie.isNew ? "New" : nil,
                accessibilityText: "\(movie.title)\(movie.year.map { ", \($0)" } ?? "")"
            )
        }
    }
}

struct ShowsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        LibraryGridView(title: "TV Shows", noun: "shows", loader: model.shows) { show in
            let summary = TitleSummary(show)
            let episodes = show.episodeCount == 1 ? "1 episode" : "\(show.episodeCount) episodes"
            return LibraryCard(
                id: show.id, summary: summary, subtitle: show.episodeCount > 0 ? episodes : nil,
                badge: show.isNew ? "New" : nil,
                accessibilityText: "\(show.title), \(episodes)"
            )
        }
    }
}

struct LibraryGridView<Item: Identifiable & Sendable>: View where Item.ID: Hashable & Sendable {
    let title: String
    let noun: String
    @ObservedObject var loader: PagedLoader<Item>
    let makeCard: (Item) -> LibraryCard

    @EnvironmentObject private var model: AppModel

    private var columns: [GridItem] {
        [GridItem(.adaptive(minimum: Theme.Layout.posterWidth), spacing: Theme.Layout.gridSpacing, alignment: .top)]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                header
                LazyVGrid(columns: columns, alignment: .leading, spacing: Theme.Layout.gridSpacing) {
                    ForEach(loader.items) { item in
                        card(for: item)
                    }
                }
                .padding(.horizontal, Theme.Spacing.screenEdge)
                footer
            }
            .padding(.vertical, Theme.Spacing.md)
        }
        .screenTitle(title)
        .task { if !loader.hasLoadedOnce && !loader.isLoading { await loader.reload() } }
        .onReceive(loader.$failure) { failure in
            if failure?.isUnauthorized == true { model.sessionExpired() }
        }
        .refreshableIfAvailable { await loader.reload() }
    }

    @ViewBuilder
    private var header: some View {
        if let total = loader.total {
            Text("\(total.formatted()) \(noun)")
                .font(Theme.Fonts.metadata)
                .foregroundColor(Theme.Palette.textSecondary)
                .padding(.horizontal, Theme.Spacing.screenEdge)
                .accessibilityLabel("\(total) \(noun) in your library")
        }
    }

    private func card(for item: Item) -> some View {
        let data = makeCard(item)
        return NavigationLink(value: data.summary) {
            PosterCard(
                title: data.summary.title,
                subtitle: data.subtitle,
                posterURL: model.api?.absoluteURL(data.summary.poster),
                badge: data.badge
            )
        }
        .posterButtonStyle()
        .accessibilityLabel(data.accessibilityText)
        .onAppear { loader.itemAppeared(item) }
    }

    @ViewBuilder
    private var footer: some View {
        if let failure = loader.failure, !failure.isUnauthorized {
            MessageView(
                systemImage: "wifi.exclamationmark",
                title: "Couldn't load \(noun)",
                message: failure.userMessage,
                actionTitle: "Try again"
            ) {
                Task { await loader.retry() }
            }
            .frame(maxWidth: .infinity)
        } else if loader.isLoading {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(Theme.Spacing.lg)
                .accessibilityLabel("Loading \(noun)")
        } else if loader.hasLoadedOnce && loader.items.isEmpty {
            MessageView(
                systemImage: "film.stack",
                title: "No \(noun) yet",
                message: "Add \(noun) to the folders your Beebo server watches, and they'll appear here."
            )
            .frame(maxWidth: .infinity)
        }
    }
}
