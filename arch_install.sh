#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

echo "Building package..."
cd "$SCRIPT_DIR"
export _srcdir="$SCRIPT_DIR"
# Keep staging separate from the application source, and run prepare()
# to install locked JavaScript dependencies before building.
mkdir -p "$SCRIPT_DIR/.arch-build"
BUILDDIR="$SCRIPT_DIR/.arch-build" makepkg -f --cleanbuild

# Extract version from PKGBUILD
PKGVER=$(grep -m1 '^pkgver=' PKGBUILD | cut -d= -f2)
PKGREL=$(grep -m1 '^pkgrel=' PKGBUILD | cut -d= -f2)
ARCH=$(uname -m)
PKG="tauri-explorer-${PKGVER}-${PKGREL}-${ARCH}.pkg.tar.zst"

echo "Installing ${PKG}..."
sudo pacman -U "$PKG" --noconfirm

echo "Done. Run 'tauri-explorer' to launch."
