# Maintainer: xnmp <chonw89@gmail.com>
pkgname=tauri-explorer
# Single source of truth: derive the version from package.json so the
# package never drifts from the app (it sat at 0.2.7 while the app was
# 0.3.0). pkgver() updates it automatically during makepkg; the literal
# below is just a fallback for tooling that reads it without running pkgver.
pkgver=1.7.0
pkgrel=1
pkgdesc="A minimalistic, high-performance file explorer"
arch=('x86_64' 'aarch64')
url="https://github.com/xnmp/tauri-explorer"
license=('MIT')
depends=(
  'cairo'
  'dav1d'
  'desktop-file-utils'
  'gdk-pixbuf2'
  'glib2'
  'gtk3'
  'hicolor-icon-theme'
  'libsoup3'
  'pango'
  'webkit2gtk-4.1'
)
makedepends=(
  'librsvg'
  'openssl'
  'rust'
)
options=('!lto')
source=()
sha256sums=()

# When building locally, set _srcdir to the repo root.
# In CI, the repo is copied into $srcdir/tauri-explorer before makepkg runs.
_srcdir="${_srcdir:-$srcdir/$pkgname}"

# Read the version straight from package.json (the app's source of truth).
pkgver() {
  cd "$_srcdir"
  local v
  v=$(grep -m1 '"version"' package.json | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')
  printf '%s' "${v:-0.4.0}"
}

prepare() {
  cd "$_srcdir"
  bun install --frozen-lockfile
}

build() {
  cd "$_srcdir"
  bun run build
  # --features avif: Arch ships a current dav1d, so enable AVIF thumbnails
  # (off in the cross-platform release where dav1d is unavailable/too old).
  cargo tauri build --no-bundle --features avif --config '{"build":{"beforeBuildCommand":""}}'
}

package() {
  cd "$_srcdir"

  install -Dm755 src-tauri/target/release/tauri-explorer "$pkgdir/usr/bin/tauri-explorer"

  # xdg-desktop-portal FileChooser backend (system file picker).
  # Enable by adding to ~/.config/xdg-desktop-portal/portals.conf:
  #   org.freedesktop.impl.portal.FileChooser=tauri-explorer
  install -Dm644 packaging/tauri-explorer.portal \
    "$pkgdir/usr/share/xdg-desktop-portal/portals/tauri-explorer.portal"
  install -Dm644 packaging/org.freedesktop.impl.portal.desktop.tauri_explorer.service \
    "$pkgdir/usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.tauri_explorer.service"

  install -Dm644 src-tauri/icons/32x32.png \
    "$pkgdir/usr/share/icons/hicolor/32x32/apps/tauri-explorer.png"
  install -Dm644 src-tauri/icons/128x128.png \
    "$pkgdir/usr/share/icons/hicolor/128x128/apps/tauri-explorer.png"
  install -Dm644 src-tauri/icons/128x128@2x.png \
    "$pkgdir/usr/share/icons/hicolor/256x256@2/apps/tauri-explorer.png"

  cat > "$srcdir/tauri-explorer.desktop" <<'DESKTOP'
[Desktop Entry]
Name=Tauri Explorer
Comment=A minimalistic, high-performance file explorer
Exec=tauri-explorer
Icon=tauri-explorer
Terminal=false
Type=Application
Categories=System;FileManager;
StartupWMClass=tauri-explorer
DESKTOP
  install -Dm644 "$srcdir/tauri-explorer.desktop" \
    "$pkgdir/usr/share/applications/tauri-explorer.desktop"
}
