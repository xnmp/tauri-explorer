cask "tauri-explorer" do
  version "1.3.3"
  sha256 "adb41e8534542b752737ed6218dfedfdf58d3c27cfc68dfb7f4390ea3a0835bc"

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
