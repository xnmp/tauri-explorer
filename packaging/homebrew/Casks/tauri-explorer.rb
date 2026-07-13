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
    The app is not yet code-signed or notarized, so macOS will block the
    first launch. To open it: right-click the app in Finder and choose
    "Open", or run:
      xattr -d com.apple.quarantine "#{appdir}/tauri-explorer.app"
  EOS
end
