import SwiftUI
import BeeboKit

struct SearchView: View {
    @EnvironmentObject private var model: AppModel

    @State private var query = ""
    @State private var movies: [MovieSummary] = []
    @State private var shows: [ShowSummary] = []
    @State private var isSearching = false
    @State private var failure: String?

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var columns: [GridItem] {
        [GridItem(.adaptive(minimum: Theme.Layout.posterWidth), spacing: Theme.Layout.gridSpacing, alignment: .top)]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                if trimmed.isEmpty {
                    MessageView(
                        systemImage: "magnifyingglass",
                        title: "Search your library",
                        message: "Type a movie or TV show title."
                    )
                    .frame(maxWidth: .infinity)
                } else if let failure {
                    MessageView(systemImage: "wifi.exclamationmark", title: "Search failed", message: failure)
                        .frame(maxWidth: .infinity)
                } else {
                    results
                }
            }
            .padding(.vertical, Theme.Spacing.md)
        }
        .screenTitle("Search")
        .searchable(text: $query, prompt: "Movies and TV shows")
        .task(id: trimmed) { await runSearch() }
    }

    @ViewBuilder
    private var results: some View {
        if !movies.isEmpty {
            section("Movies") {
                ForEach(movies) { movie in
                    link(TitleSummary(movie), subtitle: movie.year.map { String($0) })
                }
            }
        }
        if !shows.isEmpty {
            section("TV Shows") {
                ForEach(shows) { show in
                    link(TitleSummary(show), subtitle: show.year.map { String($0) })
                }
            }
        }
        if isSearching {
            ProgressView()
                .frame(maxWidth: .infinity)
                .accessibilityLabel("Searching")
        } else if movies.isEmpty && shows.isEmpty {
            MessageView(systemImage: "questionmark.folder", title: "No results for \u{201C}\(trimmed)\u{201D}")
                .frame(maxWidth: .infinity)
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(Theme.Fonts.sectionTitle)
                .padding(.horizontal, Theme.Spacing.screenEdge)
                .accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: columns, alignment: .leading, spacing: Theme.Layout.gridSpacing) {
                content()
            }
            .padding(.horizontal, Theme.Spacing.screenEdge)
        }
    }

    private func link(_ summary: TitleSummary, subtitle: String?) -> some View {
        NavigationLink(value: summary) {
            PosterCard(title: summary.title, subtitle: subtitle, posterURL: model.api?.absoluteURL(summary.poster))
        }
        .posterButtonStyle()
        .accessibilityLabel("\(summary.title), \(summary.kind == .tv ? "TV show" : "movie")")
    }

    private func runSearch() async {
        guard let api = model.api else { return }
        let text = trimmed
        guard !text.isEmpty else {
            movies = []
            shows = []
            failure = nil
            isSearching = false
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        if Task.isCancelled { return }
        isSearching = true
        failure = nil
        do {
            async let foundMovies = api.movies(query: text, offset: 0, limit: 30)
            async let foundShows = api.shows(query: text, offset: 0, limit: 30)
            let (m, s) = try await (foundMovies, foundShows)
            if Task.isCancelled { return }
            movies = m.items
            shows = s.items
        } catch let error as APIError where error.isUnauthorized {
            model.sessionExpired()
        } catch {
            if Task.isCancelled { return }
            failure = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
        isSearching = false
    }
}
