import SwiftUI
import BeeboKit

@main
struct BeeboApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        content
            .background(Theme.Palette.background.ignoresSafeArea())
            .fullScreenCover(item: $model.playback) { request in
                if let api = model.api {
                    PlayerScreen(request: request, api: api, preferences: model.preferences)
                        .environmentObject(model)
                }
            }
            .task { await model.restore() }
            .onOpenURL { model.handle(url: $0) }
            .onReceive(model.$phase) { phase in
                if phase == .signedIn, let ref = DebugLaunch.ref(from: DebugLaunch.playTitle) {
                    model.play(ref)
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .launching:
            ProgressView()
                .accessibilityLabel("Loading")
        case .signedOut:
            SignInView()
        case .signedIn:
            MainTabs()
        }
    }
}

enum AppTab: String, Hashable {
    case home
    case movies
    case shows
    case search
    case settings
}

struct MainTabs: View {
    @State private var selection: AppTab = AppTab(rawValue: DebugLaunch.tab ?? "") ?? .home

    var body: some View {
        TabView(selection: $selection) {
            tab(.home, "Home", systemImage: "house") { HomeView() }
            tab(.movies, "Movies", systemImage: "film") { MoviesView() }
            tab(.shows, "TV Shows", systemImage: "tv") { ShowsView() }
            tab(.search, "Search", systemImage: "magnifyingglass") { SearchView() }
            tab(.settings, "Settings", systemImage: "gearshape") { SettingsView() }
        }
    }

    private func tab<Content: View>(_ tab: AppTab, _ title: String, systemImage: String, @ViewBuilder content: @escaping () -> Content) -> some View {
        TabStack(opening: tab == selection ? DebugLaunch.ref(from: DebugLaunch.openTitle).map(TitleSummary.init(ref:)) : nil) {
            content()
        }
        .tabItem { Label(title, systemImage: systemImage) }
        .tag(tab)
    }
}

struct TabStack<Content: View>: View {
    let opening: TitleSummary?
    @ViewBuilder let content: () -> Content

    @State private var path = NavigationPath()
    @State private var opened = false

    var body: some View {
        NavigationStack(path: $path) {
            content()
                .navigationDestination(for: TitleSummary.self) { DetailView(summary: $0) }
        }
        .onAppear {
            if let opening, !opened {
                opened = true
                path.append(opening)
            }
        }
    }
}
