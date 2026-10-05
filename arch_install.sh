#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)

export _arch_reuse_frontend=1
export _arch_rebuild_frontend=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) export _arch_rebuild_frontend=1 ;;
    -h|--help)
      echo "Usage: $0 [--rebuild]"
      echo "Reuse unchanged frontend assets by default; --rebuild forces their rebuild."
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# makepkg otherwise exports a new SOURCE_DATE_EPOCH on every invocation, which
# changes the frontend build environment even when the source is identical.
# Follow reproducible-build practice; preserve an explicitly supplied epoch.
if [[ -z ${SOURCE_DATE_EPOCH:-} ]]; then
  SOURCE_DATE_EPOCH=$(
    if [[ "$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" == "$SCRIPT_DIR" ]]; then
      git -C "$SCRIPT_DIR" log -1 --format=%ct 2>/dev/null \
        || stat -c %Y "$SCRIPT_DIR/package.json"
    else
      stat -c %Y "$SCRIPT_DIR/package.json"
    fi
  )
  export SOURCE_DATE_EPOCH
fi

# Own staging, frontend assets and the native package until installation ends.
# Advisory locks disappear on process exit, including cancellation.
mkdir -p "$SCRIPT_DIR/.arch-build"
exec {INSTALL_LOCK_FD}>"$SCRIPT_DIR/.arch-build/install.lock"
if ! flock -n "$INSTALL_LOCK_FD"; then
  echo "Another Arch installation is running in this checkout." >&2
  exit 1
fi

echo "Authenticating sudo..."
sudo -v

# Keep the timestamp valid while makepkg runs as the current user.
(
  # Credential refresh is not installation work and must not retain its lock
  # if the installer is killed while a real build child is still finishing.
  exec {INSTALL_LOCK_FD}>&-
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
# A new frontend timestamp otherwise forces an expensive Rust release relink
# on every invocation. Reuse verified assets; retain the release profile and
# always let Cargo check native sources and makepkg refresh package metadata.
# Keep staging separate from the application source, and run prepare()
# to install locked JavaScript dependencies before building.
BUILDDIR="$SCRIPT_DIR/.arch-build" makepkg -f --cleanbuild

# Extract version from PKGBUILD
PKGVER=$(grep -m1 '^pkgver=' PKGBUILD | cut -d= -f2)
PKGREL=$(grep -m1 '^pkgrel=' PKGBUILD | cut -d= -f2)
ARCH=$(uname -m)
PKG="tauri-explorer-${PKGVER}-${PKGREL}-${ARCH}.pkg.tar.zst"

echo "Installing ${PKG}..."
sudo -n pacman -U "$PKG" --noconfirm

echo "Done. Run 'tauri-explorer' to launch."
