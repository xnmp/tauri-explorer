cask "tauri-explorer" do
  version "1.3.1"
  sha256 "4631713e2cd9db143017718fba9d40159c37cf0f5e1da5bf1b36ac86b442bef2"

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
