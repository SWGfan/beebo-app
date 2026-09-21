import SwiftUI
import BeeboKit

private struct LanguageChoice: Identifiable {
    let code: String
    let name: String
    var id: String { code }
}

private let languageChoices: [LanguageChoice] = [
    LanguageChoice(code: "en", name: "English"),
    LanguageChoice(code: "es", name: "Spanish"),
    LanguageChoice(code: "fr", name: "French"),
    LanguageChoice(code: "de", name: "German"),
    LanguageChoice(code: "it", name: "Italian"),
    LanguageChoice(code: "pt", name: "Portuguese"),
    LanguageChoice(code: "nl", name: "Dutch"),
    LanguageChoice(code: "sv", name: "Swedish"),
    LanguageChoice(code: "ja", name: "Japanese"),
    LanguageChoice(code: "ko", name: "Korean"),
    LanguageChoice(code: "zh", name: "Chinese"),
    LanguageChoice(code: "ru", name: "Russian"),
    LanguageChoice(code: "ar", name: "Arabic"),
    LanguageChoice(code: "hi", name: "Hindi"),
]

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirmingSignOut = false
    @State private var showingLink = false

    var body: some View {
        Form {
            Section("Server") {
                LabeledContent("Connected to", value: model.serverAddress)
                LabeledContent("Signed in as", value: model.userName)
            }
            Section("Playback") {
                Picker("Video quality", selection: $model.preferences.quality) {
                    ForEach(QualityPreference.allCases) { quality in
                        Text(quality.label).tag(quality)
                    }
                }
                Picker("Preferred audio language", selection: $model.preferences.audioLanguage) {
                    Text("Server default").tag("")
                    ForEach(languageChoices) { language in
                        Text(language.name).tag(language.code)
                    }
                }
                Toggle("Show subtitles", isOn: $model.preferences.subtitlesEnabled)
                Picker("Subtitle language", selection: $model.preferences.subtitleLanguage) {
                    ForEach(languageChoices) { language in
                        Text(language.name).tag(language.code)
                    }
                }
            }
            Section {
                Button("Sign out", role: .destructive) { confirmingSignOut = true }
                #if os(iOS)
                if AppConfig.phonePairingEnabled {
                    Button("Link a TV") { showingLink = true }
                }
                #endif
            } header: {
                Text("Account")
            } footer: {
                Text("Beebo signs in to your own server. It doesn't create accounts.")
            }
            Section("About") {
                LabeledContent("Version", value: AppConfig.versionString)
                Text(AppConfig.managedAtText)
                Text("Beebo doesn't collect analytics and doesn't track you. Everything you watch and browse stays between this device and your Beebo server.")
                    .font(Theme.Fonts.cardSubtitle)
                    .foregroundColor(Theme.Palette.textSecondary)
            }
        }
        .screenTitle("Settings")
        .confirmationDialog("Sign out of Beebo?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { model.signOut() }
            Button("Cancel", role: .cancel) {}
        }
        #if os(iOS)
        .sheet(isPresented: $showingLink) { LinkTVView() }
        #endif
    }
}
