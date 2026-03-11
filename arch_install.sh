#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

echo "Building package..."
cd "$SCRIPT_DIR"
export _srcdir="$SCRIPT_DIR"
makepkg -ef

echo "Installing..."
sudo pacman -U tauri-explorer-*.pkg.tar.zst --noconfirm

echo "Done. Run 'tauri-explorer' to launch."
