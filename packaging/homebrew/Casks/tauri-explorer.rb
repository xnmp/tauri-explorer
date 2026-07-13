cask "tauri-explorer" do
  version "1.3.2"
  sha256 "4f8513cb8262c2c7173a912b19ad0a974cd492e21e209bfff9ff5259731a0964"

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
    on macOS 15+). Either install with the quarantine flag disabled:
      brew install --cask --no-quarantine xnmp/tap/tauri-explorer
    or clear the flag after installing:
      xattr -rd com.apple.quarantine "#{appdir}/tauri-explorer.app"
  EOS
end
