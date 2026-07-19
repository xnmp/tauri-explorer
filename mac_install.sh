#!/usr/bin/env bash
#
# mac_install.sh — build and install tauri-explorer on macOS from source.
#
# No prebuilt release exists for every Mac (releases only ship an
# aarch64/Apple Silicon DMG, and it isn't notarized), so this installs by
# building locally: it verifies prerequisites (git, cargo/rustup, bun, Xcode
# Command Line Tools), clones the repo (or uses the checkout it's already
# running from), runs the project's real build via the Tauri CLI, then
# installs the resulting tauri-explorer.app into /Applications and clears
# the quarantine flag the un-notarized app would otherwise be blocked by
# ("app is damaged"). Works on both Apple Silicon and Intel Macs.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xnmp/tauri-explorer/main/mac_install.sh | bash
#   # or, from inside an existing checkout:
#   ./mac_install.sh
#
# An optional first argument selects a git tag/branch to build (only applies
# when this script clones a fresh checkout — it's ignored when run from
# inside an existing one; check out the ref yourself first in that case):
#   curl -fsSL .../mac_install.sh | bash -s -- v1.5.0
#
# This compiles Rust in release mode, so expect it to take several minutes
# (the old download-a-DMG flow was faster but depended on a release existing
# and being notarized; this doesn't).
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
echo "Building tauri-explorer for macOS ($ARCH)..."

# ----- Prerequisites -----
missing=()
command -v git >/dev/null 2>&1 || missing+=("git")
command -v cargo >/dev/null 2>&1 || missing+=("cargo/rustup — https://rustup.rs/")
command -v bun >/dev/null 2>&1 || missing+=("bun — https://bun.sh/")
xcode-select -p >/dev/null 2>&1 || missing+=("Xcode Command Line Tools — run: xcode-select --install")

if [ "${#missing[@]}" -gt 0 ]; then
  echo "error: missing prerequisites:" >&2
  for m in "${missing[@]}"; do
    echo "  - $m" >&2
  done
  echo "See https://github.com/$REPO#building and https://v2.tauri.app/start/prerequisites/ for setup." >&2
  exit 1
fi

# ----- Resolve the source checkout: reuse the current one, or clone fresh -----
CLONE_DIR=""
cleanup() {
  if [ -n "$CLONE_DIR" ]; then
    rm -rf "$CLONE_DIR"
  fi
}
trap cleanup EXIT

SCRIPT_SRC="${BASH_SOURCE[0]:-}"
REPO_DIR=""
if [ -n "$SCRIPT_SRC" ] && [ -f "$SCRIPT_SRC" ]; then
  CANDIDATE_DIR="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)"
  if [ -f "$CANDIDATE_DIR/package.json" ] && [ -d "$CANDIDATE_DIR/src-tauri" ]; then
    REPO_DIR="$CANDIDATE_DIR"
    echo "Using existing checkout at $REPO_DIR"
    if [ -n "$TAG" ]; then
      echo "note: ignoring '$TAG' — already running from an existing checkout; 'git checkout $TAG' yourself first if you want a different ref."
    fi
  fi
fi

if [ -z "$REPO_DIR" ]; then
  CLONE_DIR="$(mktemp -d /tmp/tauri-explorer-build.XXXXXX)"
  REPO_DIR="$CLONE_DIR/tauri-explorer"
  if [ -n "$TAG" ]; then
    echo "Cloning $REPO @ $TAG..."
    git clone --depth 1 --branch "$TAG" "https://github.com/$REPO.git" "$REPO_DIR" \
      || fail "could not clone $REPO at ref '$TAG' (bad tag/branch? offline?)"
  else
    echo "Cloning $REPO..."
    git clone --depth 1 "https://github.com/$REPO.git" "$REPO_DIR" \
      || fail "could not clone $REPO (offline?)"
  fi
fi

# ----- Build -----
cd "$REPO_DIR"

echo "Installing JS dependencies..."
bun install

echo "Building (bunx tauri build — compiles Rust in release mode, this takes a while)..."
bunx tauri build

APP_BUNDLE_DIR="$REPO_DIR/src-tauri/target/release/bundle/macos"
SRC_APP="$(find "$APP_BUNDLE_DIR" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
[ -n "$SRC_APP" ] && [ -d "$SRC_APP" ] \
  || fail "build succeeded but no .app bundle found under $APP_BUNDLE_DIR"

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

# The app is not notarized: if a quarantine flag rode along, Gatekeeper
# reports the app as "damaged". Clearing it is the documented workaround
# until notarization.
$SUDO xattr -dr com.apple.quarantine "$DEST/$APP_NAME" 2>/dev/null || true

VERSION="$(defaults read "$DEST/$APP_NAME/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "unknown")"
echo
echo "Installed tauri-explorer $VERSION to $DEST/$APP_NAME"
echo "Launch it with:  open -a tauri-explorer"
echo "If macOS still warns on first launch: right-click the app in Finder and choose Open."
