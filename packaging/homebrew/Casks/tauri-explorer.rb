cask "tauri-explorer" do
  version "1.4.1"
  sha256 "c795efa771bea18504dfb5b582f600d9724d13e390e7996f365880e67541504e"

  url "https://github.com/xnmp/tauri-explorer/releases/download/v#{version}/tauri-explorer_#{version}_aarch64.dmg"
  name "Tauri Explorer"
  desc "Keyboard-first file manager with fuzzy quick-open and a command palette"
  homepage "https://github.com/xnmp/tauri-explorer"

  depends_on arch: :arm64

  app "tauri-explorer.app"

  zap trash: [
    "~/Library/Application Support/tauri-explorer",
    "~/Library/Caches/tauri-explorer",
    "~/Library/WebKit/com.explorer.app",
    "~/Library/WebKit/io.github.xnmp.tauri-explorer",
  ]

  caveats <<~EOS
    The app is not yet code-signed or notarized, so macOS will report it
    as "damaged" on first launch (right-click → Open does NOT bypass this
    on macOS 15+, and Homebrew no longer offers --no-quarantine). Clear
    the quarantine flag after installing:
      xattr -r -d com.apple.quarantine /Applications/tauri-explorer.app
  EOS
end
