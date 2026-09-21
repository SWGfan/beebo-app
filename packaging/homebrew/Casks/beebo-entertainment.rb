# DRAFT. There is no macOS build of Beebo Entertainment yet: the asset names, checksums and
# the app bundle name below are guesses that follow electron-builder's mac defaults.
# Do not publish this until a signed and notarised .dmg exists on the GitHub release.
cask "beebo-entertainment" do
  arch arm: "arm64", intel: "x64"

  version "0.1.57"
  # TODO: sha256 of each published .dmg (shasum -a 256 <file>)
  sha256 arm:   "REPLACE_WITH_SHA256_OF_THE_ARM64_DMG",
         intel: "REPLACE_WITH_SHA256_OF_THE_X64_DMG"

  # TODO: confirm the real asset names once the mac build exists (set mac.artifactName in package.json).
  url "https://github.com/SWGfan/beebotv/releases/download/Beebo-#{version}/BeeboEntertainment-#{version}-#{arch}.dmg",
      verified: "github.com/SWGfan/beebotv/"
  name "Beebo Entertainment"
  desc "Home media server and player for your own movies, TV, music and photos"
  homepage "https://beeboentertainment.com/"

  livecheck do
    url :url
    regex(/^Beebo[._-]v?(\d+(?:\.\d+)+)$/i)
    strategy :github_latest
  end

  depends_on macos: ">= :catalina"

  app "Beebo Entertainment.app"

  zap trash: [
    "~/Library/Application Support/Beebo Entertainment",
    "~/Library/Preferences/com.beeboentertainment.desktop.plist",
    "~/Library/Saved Application State/com.beeboentertainment.desktop.savedState",
  ]
end
