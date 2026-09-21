import SwiftUI
import AVKit
import BeeboKit

struct PlayerHost: UIViewControllerRepresentable {
    let controller: AVPlayerViewController

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        controller
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {}
}

struct PlayerScreen: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var coordinator: PlayerCoordinator

    init(request: PlaybackRequest, api: BeeboAPI, preferences: PlaybackPreferences) {
        _coordinator = StateObject(wrappedValue: PlayerCoordinator(api: api, preferences: preferences, request: request))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            PlayerHost(controller: coordinator.controller)
                .ignoresSafeArea()
            overlayContent
            #if os(iOS)
            closeButton
            #endif
        }
        .task {
            coordinator.onClose = { model.playbackEnded() }
            await coordinator.start()
        }
        .onDisappear {
            coordinator.stop()
            model.playbackEnded()
        }
    }

    @ViewBuilder
    private var overlayContent: some View {
        switch coordinator.phase {
        case .loading:
            ProgressView("Starting playback")
                .progressViewStyle(.circular)
                .tint(.white)
                .foregroundColor(.white)
        case .failed(let message):
            VStack(spacing: Theme.Spacing.md) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle)
                    .accessibilityHidden(true)
                Text("Couldn't play this")
                    .font(Theme.Fonts.sectionTitle)
                Text(message)
                    .font(Theme.Fonts.body)
                    .multilineTextAlignment(.center)
                HStack(spacing: Theme.Spacing.md) {
                    Button("Try again") { Task { await coordinator.retry() } }
                    Button("Close") { model.playbackEnded() }
                }
            }
            .foregroundColor(.white)
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: 800)
            .background(Color.black.opacity(0.85), in: RoundedRectangle(cornerRadius: Theme.Layout.cornerRadius))
        case .playing:
            EmptyView()
        }
    }

    #if os(iOS)
    private var closeButton: some View {
        VStack {
            HStack {
                Button {
                    model.playbackEnded()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title)
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, Color.black.opacity(0.5))
                        .padding()
                }
                .accessibilityLabel("Close player")
                Spacer()
                if !coordinator.audioChoices.isEmpty || !coordinator.subtitleChoices.isEmpty {
                    trackMenu
                }
            }
            Spacer()
        }
    }

    private var trackMenu: some View {
        Menu {
            if !coordinator.audioChoices.isEmpty {
                Section("Audio") {
                    ForEach(coordinator.audioChoices) { choice in
                        Button {
                            coordinator.chooseAudio(choice.id)
                        } label: {
                            choiceLabel(choice)
                        }
                    }
                }
            }
            if !coordinator.subtitleChoices.isEmpty {
                Section("Subtitles") {
                    ForEach(coordinator.subtitleChoices) { choice in
                        Button {
                            coordinator.chooseSubtitle(choice.id)
                        } label: {
                            choiceLabel(choice)
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "captions.bubble.fill")
                .font(.title)
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, Color.black.opacity(0.5))
                .padding()
        }
        .accessibilityLabel("Audio and subtitles")
    }

    @ViewBuilder
    private func choiceLabel(_ choice: TrackChoice) -> some View {
        if choice.selected {
            Label(choice.title, systemImage: "checkmark")
        } else {
            Text(choice.title)
        }
    }
    #endif
}
