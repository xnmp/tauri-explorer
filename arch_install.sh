#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)

export _arch_reuse_frontend=1
export _arch_rebuild_frontend=0
PLUGIN_LOCATION=${TRACE_EXPLORER_PLUGIN_PATH:-"$HOME/Repos/TraceExplorer/package"}
while (($#)); do
  arg=$1
  case "$arg" in
    --rebuild) export _arch_rebuild_frontend=1 ;;
    --plugin-path)
      if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then echo "--plugin-path requires a file or directory" >&2; exit 2; fi
      PLUGIN_LOCATION=$2
      shift ;;
    -h|--help)
      echo "Usage: $0 [--rebuild] [--plugin-path FILE_OR_DIRECTORY]"
      echo "Reuse unchanged frontend assets by default; --rebuild forces their rebuild."
      echo "Queue TraceExplorer for installation on the next app launch when its package exists."
      echo "Plugin location: TRACE_EXPLORER_PLUGIN_PATH (default: \$HOME/Repos/TraceExplorer/package)."
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
  shift
done
PLUGIN_LOCATION=$(realpath -m -- "$PLUGIN_LOCATION")

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
trap 'kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true; wait "$SUDO_KEEPALIVE_PID" 2>/dev/null || true; if [[ -n ${PLUGIN_STAGING:-} ]]; then rm -f -- "$PLUGIN_STAGING"; fi' EXIT
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

PLUGIN_FILE=
if [[ -f "$PLUGIN_LOCATION" ]]; then
  PLUGIN_FILE=$PLUGIN_LOCATION
elif [[ -d "$PLUGIN_LOCATION" ]]; then
  case "$ARCH" in
    x86_64|aarch64)
      mapfile -d '' PLUGIN_PACKAGES < <(find "$PLUGIN_LOCATION" -maxdepth 1 -type f -name "TraceExplorer-*-${ARCH}-unknown-linux-gnu.teplugin" -print0 | sort -zV)
      if ((${#PLUGIN_PACKAGES[@]})); then PLUGIN_FILE=${PLUGIN_PACKAGES[-1]}; fi ;;
  esac
fi

if [[ -n "$PLUGIN_FILE" ]]; then
  PLUGIN_QUEUE="${XDG_CONFIG_HOME:-$HOME/.config}/tauri-explorer/pending-plugins"
  if [[ -L "$PLUGIN_QUEUE" ]]; then echo "Plugin queue must not be a symlink: $PLUGIN_QUEUE" >&2; exit 1; fi
  mkdir -p -m 700 "$PLUGIN_QUEUE"
  PLUGIN_STAGING=$(mktemp "$PLUGIN_QUEUE/.stage-XXXXXXXX")
  # Publish complete bytes. Distinct content names preserve newer requests
  # when the application is processing an older one.
  if ! cp -- "$PLUGIN_FILE" "$PLUGIN_STAGING"; then rm -f -- "$PLUGIN_STAGING"; exit 1; fi
  PLUGIN_DIGEST=$(sha256sum "$PLUGIN_STAGING")
  PLUGIN_DIGEST=${PLUGIN_DIGEST%% *}
  mv -f -- "$PLUGIN_STAGING" "$PLUGIN_QUEUE/$PLUGIN_DIGEST.teplugin"
  echo "Queued $(basename "$PLUGIN_FILE") for validated installation on the next app launch."
else
  echo "No TraceExplorer package at $PLUGIN_LOCATION; skipping plugin installation."
fi

echo "Done. Run 'tauri-explorer' to launch."
