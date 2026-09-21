import SwiftUI
import BeeboKit
#if os(iOS)
import WebKit
#endif

/// Movie Night (docs/MOVIE-NIGHT.md): trivia, a poster-guessing game and a fair vote for tonight's film, made from the person's own
/// library and played from phones. The Beebo server draws the shared screen as a web page.
///  * iPhone / iPad: the page opens here, in a web view restricted to the server the person signed in to.
///  * Apple TV: tvOS has no web view, so this screen says where to open the page (any browser on the home Wi-Fi) and shows it as a QR code.
/// UNVERIFIED on a real device: nothing here has run outside CI.
struct MovieNightView: View {
    @EnvironmentObject private var model: AppModel

    private enum Phase {
        case idle
        case checking
        case unavailable(String)
        #if os(iOS)
        case ready(URL)
        #endif
    }

    @State private var phase: Phase = .idle

    private var browserAddress: String {
        guard let base = model.api?.baseURL else { return "" }
        return MovieNight.browserPage(base: base)
    }

    var body: some View {
        content
            .background(Theme.Palette.background.ignoresSafeArea())
            .screenTitle("Movie Night")
            .task { await prepare() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .idle, .checking:
            ProgressView("Starting Movie Night")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unavailable(let message):
            explanation(message)
        #if os(iOS)
        case .ready(let url):
            if let base = model.api?.baseURL {
                MovieNightWebView(url: url, base: base)
                    .ignoresSafeArea(edges: .bottom)
            }
        #endif
        }
    }

    private func explanation(_ problem: String?) -> some View {
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: "party.popper")
                .font(.largeTitle)
                .accessibilityHidden(true)
            Text("Movie Night")
                .font(Theme.Fonts.sectionTitle)
            if let problem, !problem.isEmpty {
                Text(problem)
                    .font(Theme.Fonts.body)
                    .multilineTextAlignment(.center)
            }
            Text("Trivia, a movie-poster game and a fair group vote for tonight's film, made from your own library. Everyone joins from their phone. No account, and no internet needed.")
                .font(Theme.Fonts.body)
                .foregroundColor(Theme.Palette.textSecondary)
                .multilineTextAlignment(.center)
            #if os(tvOS)
            Text("Apple TV can't show it, because it has no web browser. Open this address in a browser on a laptop, tablet or another TV on your home Wi-Fi:")
                .font(Theme.Fonts.body)
                .multilineTextAlignment(.center)
            if !browserAddress.isEmpty {
                Text(browserAddress)
                    .font(Theme.Fonts.sectionTitle)
                    .foregroundColor(Theme.Palette.accent)
                if let image = QRCode.image(for: browserAddress) {
                    Image(uiImage: image)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .padding(Theme.Spacing.sm)
                        .background(Color.white)
                        .frame(width: 260, height: 260)
                        .accessibilityLabel("QR code for the Movie Night address")
                }
            }
            #endif
            Button("Try again") { Task { await prepare() } }
        }
        .padding(Theme.Spacing.xl)
        .frame(maxWidth: 1100)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func prepare() async {
        guard let api = model.api else { return }
        phase = .checking
        do {
            let status = try await api.movieNightStatus()
            guard status.available else {
                phase = .unavailable(status.message.isEmpty ? "Movie Night is switched off on your Beebo computer (Settings, Movie Night)." : status.message)
                return
            }
            #if os(iOS)
            let room = try await api.movieNightCreateRoom()
            guard let url = MovieNight.tvURL(base: api.baseURL, room: room) else {
                phase = .unavailable("The server sent something this app didn't understand. Update Beebo on the computer and this app.")
                return
            }
            phase = .ready(url)
            #else
            phase = .unavailable("")
            #endif
        } catch {
            phase = .unavailable(MovieNight.explain(error))
        }
    }
}

#if os(iOS)
/// The shared screen in a web view that can only visit pages of the server the person is signed in to. No cookies are kept (an
/// ephemeral data store) and the room ticket is in the address fragment, so nothing is written to disk.
struct MovieNightWebView: UIViewRepresentable {
    let url: URL
    let base: URL

    func makeCoordinator() -> Coordinator {
        Coordinator(base: base)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let base: URL

        init(base: URL) {
            self.base = base
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            decisionHandler(MovieNight.allowsNavigation(base: base, to: navigationAction.request.url) ? .allow : .cancel)
        }
    }
}
#endif
