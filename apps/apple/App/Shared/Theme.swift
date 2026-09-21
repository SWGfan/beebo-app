import SwiftUI
import UIKit

enum Theme {
    enum Palette {
        static let accent = Color.accentColor
        static let background = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.05, green: 0.06, blue: 0.09, alpha: 1)
                : UIColor(red: 0.96, green: 0.96, blue: 0.98, alpha: 1)
        })
        static let surface = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.12, green: 0.13, blue: 0.18, alpha: 1)
                : UIColor(red: 1, green: 1, blue: 1, alpha: 1)
        })
        static let textPrimary = Color.primary
        static let textSecondary = Color.secondary
        static let onImage = Color.white
        static let scrim = Color.black.opacity(0.55)
        static let posterPlaceholder = Color.gray.opacity(0.25)
        static let progressTrack = Color.white.opacity(0.3)
        static let danger = Color.red
        static let success = Color.green
    }

    enum Fonts {
        static let screenTitle = Font.largeTitle.weight(.bold)
        static let sectionTitle = Font.title3.weight(.semibold)
        static let cardTitle = Font.callout.weight(.medium)
        static let cardSubtitle = Font.caption
        static let body = Font.body
        static let metadata = Font.subheadline
        static let button = Font.headline
        static let subtitle = Font.title3.weight(.semibold)
        #if os(tvOS)
        static let pairingCode = Font.system(size: 110, weight: .bold, design: .monospaced)
        #else
        static let pairingCode = Font.system(size: 44, weight: .bold, design: .monospaced)
        #endif
    }

    enum Spacing {
        #if os(tvOS)
        static let xs: CGFloat = 8
        static let sm: CGFloat = 16
        static let md: CGFloat = 32
        static let lg: CGFloat = 48
        static let xl: CGFloat = 80
        static let screenEdge: CGFloat = 80
        #else
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 16
        static let lg: CGFloat = 24
        static let xl: CGFloat = 40
        static let screenEdge: CGFloat = 16
        #endif
    }

    enum Layout {
        #if os(tvOS)
        static let posterWidth: CGFloat = 250
        static let cornerRadius: CGFloat = 16
        static let gridSpacing: CGFloat = 48
        static let backdropHeight: CGFloat = 440
        static let episodeThumbHeight: CGFloat = 120
        static let formMaxWidth: CGFloat = 900
        static let qrSize: CGFloat = 360
        #else
        static let posterWidth: CGFloat = 120
        static let cornerRadius: CGFloat = 10
        static let gridSpacing: CGFloat = 16
        static let backdropHeight: CGFloat = 260
        static let episodeThumbHeight: CGFloat = 64
        static let formMaxWidth: CGFloat = 480
        static let qrSize: CGFloat = 200
        #endif
        static let posterAspect: CGFloat = 2.0 / 3.0
        static let progressBarHeight: CGFloat = 6
    }
}
