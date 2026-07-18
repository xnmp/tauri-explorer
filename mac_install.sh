#!/usr/bin/env bash
#
# mac_install.sh — install tauri-explorer on macOS (Apple Silicon).
#
# Downloads the aarch64 DMG from the latest GitHub release (or the tag given
# as the first argument, e.g. `./mac_install.sh v1.5.0`), installs
# tauri-explorer.app into /Applications, and clears the quarantine flag the
# un-notarized app would otherwise be blocked by ("app is damaged").
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xnmp/tauri-explorer/main/mac_install.sh | bash
#
# sudo is only invoked when needed: /Applications (or an existing install
# put there by sudo) isn't writable by non-admin users.

set -euo pipefail

REPO="xnmp/tauri-explorer"
APP_NAME="tauri-explorer.app"
DEST="/Applications"
TAG="${1:-}"

fail() {
  echo "error: $*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS (detected $(uname -s))"

ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
  fail "releases only ship an Apple Silicon (arm64) build; no x86_64 asset exists for this Mac ($ARCH).
Build from source instead: https://github.com/$REPO#building"
fi

# ----- Resolve the DMG asset URL from the GitHub release -----
if [ -n "$TAG" ]; then
  RELEASE_API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
else
  RELEASE_API="https://api.github.com/repos/$REPO/releases/latest"
fi

echo "Resolving ${TAG:-latest} release..."
RELEASE_JSON="$(curl -fsSL "$RELEASE_API")" \
  || fail "could not query $RELEASE_API (offline? bad tag?)"

DMG_URL="$(printf '%s' "$RELEASE_JSON" \
  | grep -o '"browser_download_url": *"[^"]*_aarch64\.dmg"' \
  | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
[ -n "$DMG_URL" ] || fail "no *_aarch64.dmg asset found in the ${TAG:-latest} release"

# ----- Download and mount -----
TMPDIR_INSTALL="$(mktemp -d /tmp/tauri-explorer-install.XXXXXX)"
MOUNT_POINT=""
cleanup() {
  if [ -n "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
  fi
  rm -rf "$TMPDIR_INSTALL"
}
trap cleanup EXIT

DMG_PATH="$TMPDIR_INSTALL/$(basename "$DMG_URL")"
echo "Downloading $(basename "$DMG_URL")..."
curl -fL --progress-bar -o "$DMG_PATH" "$DMG_URL"

echo "Mounting..."
MOUNT_POINT="$(hdiutil attach "$DMG_PATH" -nobrowse -readonly \
  | grep -o '/Volumes/.*' | head -1)"
[ -n "$MOUNT_POINT" ] || fail "hdiutil could not mount $DMG_PATH"

SRC_APP="$MOUNT_POINT/$APP_NAME"
[ -d "$SRC_APP" ] || fail "$APP_NAME not found in the mounted DMG ($MOUNT_POINT)"

# ----- Install (sudo only if the destination demands it) -----
SUDO=""
if [ ! -w "$DEST" ] || { [ -e "$DEST/$APP_NAME" ] && [ ! -w "$DEST/$APP_NAME" ]; }; then
  SUDO="sudo"
  echo "Need administrator rights to write $DEST — you may be asked for your password."
fi

if [ -e "$DEST/$APP_NAME" ]; then
  echo "Removing previous install..."
  $SUDO rm -rf "$DEST/$APP_NAME"
fi

echo "Installing to $DEST/$APP_NAME..."
$SUDO ditto "$SRC_APP" "$DEST/$APP_NAME"

# The app is not notarized: if a quarantine flag rode along (it does when the
# DMG came through a quarantine-aware app), Gatekeeper reports the app as
# "damaged". Clearing it is the documented workaround until notarization.
$SUDO xattr -dr com.apple.quarantine "$DEST/$APP_NAME" 2>/dev/null || true

VERSION="$(defaults read "$DEST/$APP_NAME/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "unknown")"
echo
echo "Installed tauri-explorer $VERSION to $DEST/$APP_NAME"
echo "Launch it with:  open -a tauri-explorer"
echo "If macOS still warns on first launch: right-click the app in Finder and choose Open."
