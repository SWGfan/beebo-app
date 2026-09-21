import SwiftUI
import BeeboKit

#if os(iOS)
@MainActor
final class LinkTVModel: ObservableObject {
    enum Step: Equatable {
        case account
        case code
        case review(TVRequest)
        case done(approved: Bool)
    }

    @Published var step: Step = .account
    @Published var email = ""
    @Published var password = ""
    @Published var code = ""
    @Published private(set) var busy = false
    @Published private(set) var errorText: String?

    private var accountToken: String?
    private let service: PairingHTTP

    init(service: PairingHTTP = PairingHTTP(), prefilledCode: String? = nil) {
        self.service = service
        if let prefilledCode, !prefilledCode.isEmpty { code = prefilledCode }
    }

    func signIn() async {
        busy = true
        errorText = nil
        defer { busy = false }
        switch await service.findHome(email: email.trimmingCharacters(in: .whitespaces).lowercased(), password: password) {
        case .found(_, let token):
            accountToken = token
            password = ""
            step = .code
        case .failed(let error):
            errorText = TVLinkMessages.message(for: error)
        }
    }

    func lookUp() async {
        guard let token = accountToken else { step = .account; return }
        guard let normalized = PairingCodes.normalize(code) else {
            errorText = TVLinkMessages.message(for: .invalidCode)
            return
        }
        busy = true
        errorText = nil
        defer { busy = false }
        switch await service.lookup(token: token, userCode: normalized) {
        case .ok(let request):
            step = .review(request)
        case .refused(let error, let retryAfter):
            errorText = TVLinkMessages.message(for: error, retryAfter: retryAfter)
        }
    }

    func decide(_ decision: TVDecision) async {
        guard let token = accountToken, let normalized = PairingCodes.normalize(code) else { return }
        busy = true
        errorText = nil
        defer { busy = false }
        switch await service.decide(token: token, userCode: normalized, decision: decision) {
        case .ok:
            step = .done(approved: decision == .approve)
        case .refused(let error, let retryAfter):
            errorText = TVLinkMessages.message(for: error, retryAfter: retryAfter)
        }
    }
}

struct LinkTVView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var link = LinkTVModel()

    var body: some View {
        NavigationStack {
            Form {
                switch link.step {
                case .account: accountSection
                case .code: codeSection
                case .review(let request): reviewSection(request)
                case .done(let approved): doneSection(approved)
                }
                if let error = link.errorText {
                    Section {
                        Text(error).foregroundColor(Theme.Palette.danger)
                    }
                }
            }
            .navigationTitle("Link a TV")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .disabled(link.busy)
            .onAppear {
                if let code = model.pendingLinkCode, !code.isEmpty { link.code = code }
                model.pendingLinkCode = nil
            }
        }
    }

    private var accountSection: some View {
        Section {
            TextField("Beebo account email", text: $link.email)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.emailAddress)
            SecureField("Password", text: $link.password)
            Button("Continue") { Task { await link.signIn() } }
                .disabled(link.email.isEmpty || link.password.isEmpty)
        } header: {
            Text("Sign in")
        } footer: {
            Text("Use the email and password you use at beebo.tv. This is only used to approve the TV and isn't stored.")
        }
    }

    private var codeSection: some View {
        Section {
            TextField("Code shown on the TV", text: $link.code)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            Button("Look up") { Task { await link.lookUp() } }
                .disabled(PairingCodes.normalize(link.code) == nil)
        } header: {
            Text("Enter the code")
        }
    }

    private func reviewSection(_ request: TVRequest) -> some View {
        Section {
            LabeledContent("TV", value: request.deviceName)
            if !request.deviceModel.isEmpty {
                LabeledContent("Model", value: request.deviceModel)
            }
            LabeledContent("Asked", value: TVLinkMessages.ago(minutes: request.requestedMinutesAgo))
            Button("Approve") { Task { await link.decide(.approve) } }
            Button("Deny", role: .destructive) { Task { await link.decide(.deny) } }
        } header: {
            Text("Is this your TV?")
        }
    }

    private func doneSection(_ approved: Bool) -> some View {
        Section {
            Text(approved ? "Approved. The TV will sign in in a few seconds." : "Denied. Nothing was signed in.")
            Button("Done") { dismiss() }
        }
    }
}
#endif
