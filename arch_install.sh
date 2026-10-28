#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)

export _arch_reuse_frontend=1
export _arch_rebuild_frontend=0
PLUGIN_LOCATION=${TRACE_EXPLORER_PLUGIN_PATH:-"$HOME/Repos/TraceExplorer/package"}
MODE=full
set_mode() {
  if [[ $MODE != full && $MODE != "$1" ]]; then echo "--build-only and --install-only are mutually exclusive" >&2; exit 2; fi
  MODE=$1
}
while (($#)); do
  arg=$1
  case "$arg" in
    --rebuild) export _arch_rebuild_frontend=1 ;;
    --build-only) set_mode build ;;
    --install-only) set_mode install ;;
    --plugin-path)
      if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then echo "--plugin-path requires a file or directory" >&2; exit 2; fi
      PLUGIN_LOCATION=$2
      shift ;;
    -h|--help)
      echo "Usage: $0 [--rebuild] [--build-only | --install-only] [--plugin-path FILE_OR_DIRECTORY]"
      echo "Reuse unchanged frontend assets by default; --rebuild forces their rebuild."
      echo "--build-only builds the package without sudo; a later --install-only installs it without rebuilding."
      echo "Queue TraceExplorer for installation on the next app launch when its package exists."
      echo "Plugin location: TRACE_EXPLORER_PLUGIN_PATH (default: \$HOME/Repos/TraceExplorer/package)."
      echo "Per-user copies of the launcher, desktop entry or portal files are moved aside so /usr is the only install."
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

# Identifies the checkout a package was built from, so a later --install-only
# can say when the source has moved on since the build.
source_identity() {
  if [[ "$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" != "$SCRIPT_DIR" ]]; then
    echo unknown
    return
  fi
  local head changes
  head=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null) || { echo unknown; return; }
  # Fingerprint uncommitted tracked edits so an unchanged dirty tree still matches.
  changes=$(git -C "$SCRIPT_DIR" diff HEAD --binary 2>/dev/null) || { echo unknown; return; }
  if [[ -n $changes ]]; then
    head+="+$(printf '%s' "$changes" | sha256sum | cut -c1-12)"
  fi
  echo "$head"
}
PACKAGE_RECORD="$SCRIPT_DIR/.arch-build/package-source"

SUDO_KEEPALIVE_PID=
trap 'if [[ -n $SUDO_KEEPALIVE_PID ]]; then kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true; wait "$SUDO_KEEPALIVE_PID" 2>/dev/null || true; fi; if [[ -n ${PLUGIN_STAGING:-} ]]; then rm -f -- "$PLUGIN_STAGING"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$SCRIPT_DIR"
ARCH=$(uname -m)
# Resolve a prebuilt package before asking for credentials.
if [[ $MODE == install ]]; then
  if [[ ! -f $PACKAGE_RECORD ]]; then
    echo "No built package recorded; run $0 --build-only (or without --install-only) first." >&2
    exit 1
  fi
  { read -r PKG; read -r BUILT_FROM; } < "$PACKAGE_RECORD"
  if [[ ! -f $PKG ]]; then
    echo "Recorded package $PKG is missing; run $0 --build-only first." >&2
    exit 1
  fi
  CURRENT=$(source_identity)
  if [[ $BUILT_FROM == unknown || $CURRENT == unknown ]]; then
    echo "Warning: cannot confirm $PKG matches this checkout (no Git revision)." >&2
  elif [[ $BUILT_FROM != "$CURRENT" ]]; then
    echo "Warning: $PKG was built from $BUILT_FROM, but this checkout is now at $CURRENT; installing that earlier build." >&2
  fi
fi

if [[ $MODE != build ]]; then
  echo "Authenticating sudo..."
  sudo -v
fi

if [[ $MODE == full ]]; then
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
fi

if [[ $MODE != install ]]; then
  echo "Building package..."
  BUILT_FROM=$(source_identity)
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
  PKG="tauri-explorer-${PKGVER}-${PKGREL}-${ARCH}.pkg.tar.zst"
  printf '%s\n%s\n' "$PKG" "$BUILT_FROM" > "$PACKAGE_RECORD"

  if [[ $MODE == build ]]; then
    echo "Built ${PKG}. Install it with: $0 --install-only"
    exit 0
  fi
fi

echo "Installing ${PKG}..."
sudo -n pacman -U "$PKG" --noconfirm

# The package is the only install. Per-user copies of the files it ships
# (left by manual or development setups) take precedence over /usr and would
# keep launching an older build, so move them aside once the package is in.
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
RETIRED="${XDG_STATE_HOME:-$HOME/.local/state}/tauri-explorer/retired-overrides/$(date +%Y%m%d-%H%M%S)"
for shadow in \
  "$HOME/.local/bin/tauri-explorer" \
  "$DATA_HOME/applications/tauri-explorer.desktop" \
  "$DATA_HOME/dbus-1/services/org.freedesktop.impl.portal.desktop.tauri_explorer.service" \
  "$DATA_HOME/xdg-desktop-portal/portals/tauri-explorer.portal"; do
  if [[ -e "$shadow" || -L "$shadow" ]]; then
    mkdir -p "$RETIRED"
    mv -- "$shadow" "$RETIRED/"
    echo "Moved per-user override $shadow to $RETIRED/ (it shadowed the installed package)."
  fi
done
RESOLVED=$(command -v tauri-explorer || true)
if [[ "$RESOLVED" != /usr/bin/tauri-explorer ]]; then
  echo "Warning: 'tauri-explorer' resolves to ${RESOLVED:-nothing}, not /usr/bin/tauri-explorer; remove it to launch this install." >&2
fi

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

# A running instance (a window or the file-chooser portal) keeps the previous
# build and receives new launches, so queued plugins wait until it exits.
RUNNING=$(pgrep -x tauri-explorer | paste -sd ' ' || true)
if [[ -n "$RUNNING" ]]; then
  echo "Tauri Explorer is still running the previous build (PID $RUNNING); quit it so the next launch uses this install."
fi

echo "Done. Run 'tauri-explorer' to launch."
