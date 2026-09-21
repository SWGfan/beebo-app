import SwiftUI
import BeeboKit

extension View {
    @ViewBuilder
    func posterButtonStyle() -> some View {
        #if os(tvOS)
        self.buttonStyle(.card)
        #else
        self.buttonStyle(.plain)
        #endif
    }

    @ViewBuilder
    func screenTitle(_ title: String) -> some View {
        #if os(tvOS)
        self
        #else
        self.navigationTitle(title)
        #endif
    }

    @ViewBuilder
    func primaryActionStyle() -> some View {
        #if os(tvOS)
        self
        #else
        self.buttonStyle(.borderedProminent)
        #endif
    }

    @ViewBuilder
    func rowButtonStyle() -> some View {
        #if os(tvOS)
        self.buttonStyle(.plain)
        #else
        self.buttonStyle(.plain).contentShape(Rectangle())
        #endif
    }

    @ViewBuilder
    func addressFieldTraits() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
        #else
        self.autocorrectionDisabled()
        #endif
    }

    @ViewBuilder
    func plainFieldTraits() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        self.autocorrectionDisabled()
        #endif
    }
}

struct RemoteImage: View {
    let url: URL?
    var contentMode: ContentMode = .fill

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().aspectRatio(contentMode: contentMode)
            default:
                ZStack {
                    Theme.Palette.posterPlaceholder
                    if url != nil, case .empty = phase {
                        ProgressView()
                    } else {
                        Image(systemName: "film")
                            .font(.largeTitle)
                            .foregroundColor(Theme.Palette.textSecondary)
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }
}

struct ProgressBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.Palette.progressTrack)
                Capsule()
                    .fill(Theme.Palette.accent)
                    .frame(width: geometry.size.width * CGFloat(min(1, max(0, fraction))))
            }
        }
        .frame(height: Theme.Layout.progressBarHeight)
        .accessibilityHidden(true)
    }
}

struct PosterCard: View {
    let title: String
    let subtitle: String?
    let posterURL: URL?
    var progress: Double?
    var badge: String?

    private var posterHeight: CGFloat { Theme.Layout.posterWidth / Theme.Layout.posterAspect }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            RemoteImage(url: posterURL)
                .frame(width: Theme.Layout.posterWidth, height: posterHeight)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.cornerRadius, style: .continuous))
                .overlay(alignment: .bottom) {
                    if let progress {
                        ProgressBar(fraction: progress)
                            .padding(Theme.Spacing.sm)
                    }
                }
                .overlay(alignment: .topLeading) {
                    if let badge {
                        Text(badge)
                            .font(Theme.Fonts.cardSubtitle.weight(.bold))
                            .foregroundColor(Theme.Palette.onImage)
                            .padding(.horizontal, Theme.Spacing.sm)
                            .padding(.vertical, Theme.Spacing.xs)
                            .background(Theme.Palette.accent, in: Capsule())
                            .padding(Theme.Spacing.sm)
                    }
                }
            Text(title)
                .font(Theme.Fonts.cardTitle)
                .foregroundColor(Theme.Palette.textPrimary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(Theme.Fonts.cardSubtitle)
                    .foregroundColor(Theme.Palette.textSecondary)
                    .lineLimit(1)
            }
        }
        .frame(width: Theme.Layout.posterWidth, alignment: .topLeading)
    }
}

struct ShelfRow<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(Theme.Fonts.sectionTitle)
                .foregroundColor(Theme.Palette.textPrimary)
                .padding(.horizontal, Theme.Spacing.screenEdge)
                .accessibilityAddTraits(.isHeader)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: Theme.Layout.gridSpacing) {
                    content()
                }
                .padding(.horizontal, Theme.Spacing.screenEdge)
                .padding(.vertical, Theme.Spacing.md)
            }
        }
    }
}

struct MessageView: View {
    let systemImage: String
    let title: String
    var message: String?
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: systemImage)
                .font(.largeTitle)
                .foregroundColor(Theme.Palette.textSecondary)
                .accessibilityHidden(true)
            Text(title)
                .font(Theme.Fonts.sectionTitle)
                .multilineTextAlignment(.center)
            if let message {
                Text(message)
                    .font(Theme.Fonts.body)
                    .foregroundColor(Theme.Palette.textSecondary)
                    .multilineTextAlignment(.center)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(Theme.Fonts.button)
            }
        }
        .frame(maxWidth: 700)
        .padding(Theme.Spacing.lg)
        .accessibilityElement(children: .contain)
    }
}
