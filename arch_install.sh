#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

echo "Authenticating sudo..."
sudo -v

# Keep the timestamp valid while makepkg runs as the current user.
(
  KEEPALIVE_CHILD_PID=
  trap 'kill "$KEEPALIVE_CHILD_PID" 2>/dev/null || true; wait "$KEEPALIVE_CHILD_PID" 2>/dev/null || true' EXIT
  trap 'exit 0' INT TERM
  while true; do
    sleep 60 &
    KEEPALIVE_CHILD_PID=$!
    wait "$KEEPALIVE_CHILD_PID"
    sudo -n -v &
    KEEPALIVE_CHILD_PID=$!
    wait "$KEEPALIVE_CHILD_PID" || exit
  done
) &
SUDO_KEEPALIVE_PID=$!
trap 'kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true; wait "$SUDO_KEEPALIVE_PID" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
sudo -n pacman -U "$PKG" --noconfirm

echo "Done. Run 'tauri-explorer' to launch."
