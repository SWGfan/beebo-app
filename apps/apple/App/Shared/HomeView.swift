import SwiftUI
import BeeboKit

struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    /// The server has Movie Night (GET /api/movie-night/status answered). Hidden on an older server.
    @State private var movieNightShown = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                if let problem = model.homeError {
                    MessageView(
                        systemImage: "exclamationmark.triangle",
                        title: "Couldn't load your home screen",
                        message: problem,
                        actionTitle: "Try again"
                    ) {
                        Task { await model.refreshHome() }
                    }
                    .frame(maxWidth: .infinity)
                }
                if !model.continueItems.isEmpty {
                    ShelfRow(title: "Continue Watching") {
                        ForEach(model.continueItems) { entry in
                            continueCard(entry)
                        }
                    }
                }
                if !model.recentItems.isEmpty {
                    ShelfRow(title: "Recently Added") {
                        ForEach(model.recentItems) { entry in
                            recentCard(entry)
                        }
                    }
                }
                if movieNightShown {
                    ShelfRow(title: "Movie Night") {
                        NavigationLink {
                            MovieNightView()
                        } label: {
                            PosterCard(title: "Movie Night", subtitle: "Games with phones", posterURL: nil)
                        }
                        .posterButtonStyle()
                        .accessibilityLabel("Movie Night, party games with phones")
                    }
                }
                if model.homeLoaded && model.homeError == nil && model.continueItems.isEmpty && model.recentItems.isEmpty {
                    MessageView(
                        systemImage: "film.stack",
                        title: "Nothing to show yet",
                        message: "Browse Movies and TV Shows, or add titles to your Beebo library."
                    )
                    .frame(maxWidth: .infinity)
                }
                if !model.homeLoaded {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(Theme.Spacing.xl)
                        .accessibilityLabel("Loading your home screen")
                }
            }
            .padding(.vertical, Theme.Spacing.md)
        }
        .screenTitle("Beebo")
        .task { await model.refreshHome() }
        .task {
            let status = try? await model.api?.movieNightStatus()
            movieNightShown = status != nil
        }
        .refreshableIfAvailable { await model.refreshHome() }
    }

    private func continueCard(_ entry: ContinueEntry) -> some View {
        Button {
            model.play(entry)
        } label: {
            PosterCard(
                title: entry.title,
                subtitle: entry.upNext ? nil : TimeFormat.remaining(position: entry.positionSeconds, duration: entry.durationSeconds),
                posterURL: model.api?.absoluteURL(entry.poster),
                progress: entry.upNext ? nil : entry.fraction,
                badge: entry.upNext ? "Up next" : nil
            )
        }
        .posterButtonStyle()
        .accessibilityLabel(continueLabel(entry))
        .accessibilityHint("Plays it")
    }

    private func recentCard(_ entry: RecentlyAddedEntry) -> some View {
        NavigationLink(value: TitleSummary(ref: entry.ref)) {
            PosterCard(
                title: entry.title,
                subtitle: entry.kind == .tv ? "TV show" : "Movie",
                posterURL: model.api?.absoluteURL(entry.poster)
            )
        }
        .posterButtonStyle()
        .accessibilityLabel("\(entry.title), \(entry.kind == .tv ? "TV show" : "movie")")
    }

    private func continueLabel(_ entry: ContinueEntry) -> String {
        if entry.upNext { return "\(entry.title), up next" }
        let left = TimeFormat.remaining(position: entry.positionSeconds, duration: entry.durationSeconds)
        return left.isEmpty ? entry.title : "\(entry.title), \(left)"
    }
}

extension View {
    @ViewBuilder
    func refreshableIfAvailable(_ action: @escaping () async -> Void) -> some View {
        #if os(iOS)
        self.refreshable { await action() }
        #else
        self
        #endif
    }
}
