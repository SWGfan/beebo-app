import SwiftUI
import BeeboKit

#if os(tvOS)
struct PairingView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var state: PairingState = .starting
    @State private var message: String?
    @State private var attempt = 0
    @State private var isSigningIn = false

    var body: some View {
        VStack(spacing: Theme.Spacing.lg) {
            Text(PairingMessages.primaryAction)
                .font(Theme.Fonts.screenTitle)
                .accessibilityAddTraits(.isHeader)
            stateView
            if let message {
                Text(message)
                    .font(Theme.Fonts.body)
                    .foregroundColor(Theme.Palette.danger)
                    .multilineTextAlignment(.center)
            }
            if message != nil {
                Button("Get a new code") { message = nil; attempt += 1 }
            }
            Button(PairingMessages.typeInstead) { dismiss() }
        }
        .padding(Theme.Spacing.screenEdge)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Palette.background.ignoresSafeArea())
        .task(id: attempt) { await run() }
    }

    @ViewBuilder
    private var stateView: some View {
        if isSigningIn {
            ProgressView("Signing in")
        } else {
            codeContent
        }
    }

    @ViewBuilder
    private var codeContent: some View {
        switch state {
        case .starting:
            ProgressView()
                .accessibilityLabel("Getting a code")
        case .showCode(let code, let uri, let complete, let offline):
            HStack(alignment: .center, spacing: Theme.Spacing.xl) {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    Text(code)
                        .font(Theme.Fonts.pairingCode)
                        .accessibilityLabel("Your code is \(code.map(String.init).joined(separator: " "))")
                    Text(PairingMessages.steps(address: uri))
                        .font(Theme.Fonts.body)
                        .foregroundColor(Theme.Palette.textSecondary)
                        .frame(maxWidth: 800, alignment: .leading)
                    if offline {
                        Text(PairingMessages.offlineBanner)
                            .font(Theme.Fonts.body)
                            .foregroundColor(Theme.Palette.danger)
                    }
                }
                QRCodeView(text: complete, size: Theme.Layout.qrSize)
            }
        case .waiting(let failure, let retryIn):
            Text(PairingMessages.problem(failure, retryIn: retryIn))
                .font(Theme.Fonts.body)
                .multilineTextAlignment(.center)
        }
    }

    private func run() async {
        let controller = PairingController(
            service: PairingHTTP(),
            deviceName: AppConfig.deviceName,
            deviceModel: AppConfig.deviceModel
        )
        controller.onState = { state = $0 }
        switch await controller.run() {
        case .approved(let name, let token, _):
            isSigningIn = true
            let result = await model.completePairing(houseName: name, viewerToken: token)
            isSigningIn = false
            switch result {
            case .signedIn:
                dismiss()
            case .notSupported:
                model.notice = PairingMessages.serverNotSupported
                dismiss()
            case .failed(let text):
                message = text
            }
        case .denied(let reason):
            message = PairingMessages.denied(reason)
        case .unavailable:
            model.notice = PairingMessages.unavailable
            dismiss()
        case .cancelled:
            break
        }
    }
}
#endif
