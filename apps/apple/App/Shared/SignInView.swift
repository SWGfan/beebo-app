import SwiftUI
import BeeboKit

struct SignInView: View {
    @EnvironmentObject private var model: AppModel

    @State private var address = ""
    @State private var username = ""
    @State private var password = ""
    @State private var isBusy = false
    @State private var errorText: String?
    @State private var showingPairing = false

    private enum Field: Hashable {
        case address
        case username
        case password
    }

    @FocusState private var focus: Field?

    private var canSubmit: Bool {
        !address.trimmingCharacters(in: .whitespaces).isEmpty
            && !username.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
            && !isBusy
    }

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                Image(systemName: "play.tv")
                    .font(.system(size: 56))
                    .foregroundColor(Theme.Palette.accent)
                    .accessibilityHidden(true)
                Text("Beebo")
                    .font(Theme.Fonts.screenTitle)
                    .accessibilityAddTraits(.isHeader)
                Text("Connect to your Beebo server")
                    .font(Theme.Fonts.sectionTitle)
                    .foregroundColor(Theme.Palette.textSecondary)
                if let notice = model.notice {
                    Text(notice)
                        .font(Theme.Fonts.body)
                        .foregroundColor(Theme.Palette.textPrimary)
                        .multilineTextAlignment(.center)
                }
                fields
                connectButton
                if let errorText {
                    Text(errorText)
                        .font(Theme.Fonts.body)
                        .foregroundColor(Theme.Palette.danger)
                        .multilineTextAlignment(.center)
                        .accessibilityLabel("Error. \(errorText)")
                }
                pairingEntry
                Text("Your Beebo computer needs to be switched on and on the same home network. Use its IP address, like 192.168.1.20, or your home address, like nick.home.beebo.tv.")
                    .font(Theme.Fonts.cardSubtitle)
                    .foregroundColor(Theme.Palette.textSecondary)
                    .multilineTextAlignment(.center)
                Text(AppConfig.managedAtText)
                    .font(Theme.Fonts.cardSubtitle)
                    .foregroundColor(Theme.Palette.textSecondary)
            }
            .frame(maxWidth: Theme.Layout.formMaxWidth)
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity)
        }
        .onAppear(perform: prefill)
        #if os(tvOS)
        .fullScreenCover(isPresented: $showingPairing) { PairingView() }
        #endif
    }

    private var fields: some View {
        VStack(spacing: Theme.Spacing.sm) {
            TextField("Server address", text: $address)
                .addressFieldTraits()
                .focused($focus, equals: .address)
                .onSubmit { focus = .username }
                .accessibilityLabel("Server address")
                .accessibilityHint("The IP address or name of your Beebo computer")
            TextField("Username", text: $username)
                .plainFieldTraits()
                .focused($focus, equals: .username)
                .onSubmit { focus = .password }
                .accessibilityLabel("Username")
            SecureField("Password", text: $password)
                .focused($focus, equals: .password)
                .onSubmit { Task { await connect() } }
                .accessibilityLabel("Password")
        }
    }

    private var connectButton: some View {
        Button {
            Task { await connect() }
        } label: {
            HStack(spacing: Theme.Spacing.sm) {
                if isBusy { ProgressView() }
                Text(isBusy ? "Connecting" : "Connect")
                    .font(Theme.Fonts.button)
            }
            .frame(maxWidth: .infinity)
        }
        .primaryActionStyle()
        .disabled(!canSubmit)
        .accessibilityHint("Signs in to your Beebo server")
    }

    @ViewBuilder
    private var pairingEntry: some View {
        #if os(tvOS)
        if AppConfig.phonePairingEnabled {
            Button(PairingMessages.primaryAction) { showingPairing = true }
                .accessibilityHint("Shows a code to enter on your phone")
        }
        #endif
    }

    private func prefill() {
        if address.isEmpty {
            address = model.suggestedAddress ?? model.settings.lastServerAddress ?? ""
        }
        if let server = DebugLaunch.server, let user = DebugLaunch.username, let pass = DebugLaunch.password {
            address = server
            username = user
            password = pass
            Task { await connect() }
        }
    }

    private func connect() async {
        guard canSubmit else { return }
        isBusy = true
        errorText = nil
        do {
            try await model.signIn(address: address, username: username, password: password)
            password = ""
        } catch {
            errorText = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
        isBusy = false
    }
}
