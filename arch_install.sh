#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)

export _arch_reuse_frontend=1
export _arch_rebuild_frontend=0
PLUGIN_LOCATION=${TRACE_EXPLORER_PLUGIN_PATH:-"$HOME/Repos/TraceExplorer/package"}
MODE=full
FROM_SOURCE=0
ACCEPT_BUILD=0
set_mode() {
  if [[ $MODE != full && $MODE != "$1" ]]; then echo "--build-only and --install-only are mutually exclusive" >&2; exit 2; fi
  MODE=$1
}
while (($#)); do
  arg=$1
  case "$arg" in
    --source) FROM_SOURCE=1 ;;
    --yes) ACCEPT_BUILD=1 ;;
    --rebuild) FROM_SOURCE=1; export _arch_rebuild_frontend=1 ;;
    --build-only) set_mode build ;;
    --install-only) set_mode install ;;
    --plugin-path)
      if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then echo "--plugin-path requires a file or directory" >&2; exit 2; fi
      PLUGIN_LOCATION=$2
      shift ;;
    -h|--help)
      echo "Usage: $0 [--source | --yes] [--rebuild] [--build-only | --install-only] [--plugin-path FILE_OR_DIRECTORY]"
      echo "By default, install the latest GitHub release through pacman, without compiling."
      echo "If no prebuilt package can be used, notify and ask before building from source; --yes accepts that build."
      echo "--source builds this checkout instead. --rebuild, --build-only and --install-only also use the source build."
      echo "Source builds reuse unchanged frontend assets; --rebuild forces their rebuild."
      echo "--build-only builds the package without sudo; a later --install-only installs it without rebuilding."
      echo "Queue TraceExplorer for installation on the next app launch when its package exists."
      echo "Plugin location: TRACE_EXPLORER_PLUGIN_PATH (default: \$HOME/Repos/TraceExplorer/package)."
      echo "Per-user copies of the launcher, desktop entry or portal files are moved aside so /usr is the only install."
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
  shift
done
if [[ $MODE == full && $FROM_SOURCE == 0 ]]; then MODE=release; fi
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

# Ask for the password before any work, so the rest can run unattended.
if [[ $MODE != build ]]; then
  echo "Authenticating sudo..."
  sudo -v
fi

if [[ $MODE == full || $MODE == release ]]; then
  # Keep the timestamp valid through packaging, a build, and any wait at the
  # confirmation prompt; makepkg itself runs as the current user.
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

# The release's .deb is repackaged by the repo's binary recipe: the release
# publishes no Arch package, and its only Linux pacman route is this wrapper.
# Depends on curl and jq; without them the release path reports why it cannot
# run and the source-build confirmation takes over.
RELEASE_API=https://api.github.com/repos/xnmp/tauri-explorer/releases/latest
RELEASE_STAGE="$SCRIPT_DIR/.arch-build/release"
RELEASE_RECIPE="$SCRIPT_DIR/packaging/aur"
BUILD_REASON=
UP_TO_DATE=0
build_needed() { BUILD_REASON=$1; return 1; }

# Sets PKG (or UP_TO_DATE=1), or returns 1 with BUILD_REASON. A digest mismatch
# exits instead: tampered or corrupt bytes are never a reason to fall back.
package_latest_release() {
  [[ $ARCH == x86_64 ]] || build_needed "releases have no prebuilt $ARCH Linux package" || return
  local tool
  for tool in curl jq; do
    command -v "$tool" >/dev/null || build_needed "$tool is not installed" || return
  done

  local release version deb digest installed actual
  release=$(curl -fsSL --retry 2 --max-time 30 "$RELEASE_API") \
    || build_needed "could not reach the GitHub release" || return
  version=$(jq -r '.tag_name // empty' <<<"$release" | sed 's/^v//') \
    || build_needed "the GitHub release response was unreadable" || return
  # The version reaches sed and file names, and pacman forbids a hyphen in it.
  [[ $version =~ ^[0-9]+(\.[0-9]+)+$ ]] \
    || build_needed "the latest release has an unusable version '$version'" || return
  deb="tauri-explorer_${version}_amd64.deb"
  digest=$(jq -r --arg name "$deb" '.assets[]? | select(.name == $name) | .digest // empty' <<<"$release") \
    || build_needed "the GitHub release response was unreadable" || return
  [[ $digest == sha256:* ]] \
    || build_needed "release $version has no verifiable $deb" || return

  # Resolves through provides, so this covers source and binary packages alike.
  installed=$(pacman -Q tauri-explorer 2>/dev/null || true)
  installed=${installed##* }
  if [[ -n $installed && $(vercmp "${installed%-*}" "$version") -ge 0 ]]; then
    echo "Tauri Explorer $installed is already up to date (latest release: $version)."
    UP_TO_DATE=1
    return 0
  fi

  [[ -f $RELEASE_RECIPE/PKGBUILD ]] || build_needed "$RELEASE_RECIPE/PKGBUILD is missing" || return
  echo "Packaging release ${version}..."
  rm -rf -- "$RELEASE_STAGE"
  mkdir -p "$RELEASE_STAGE"
  cp -- "$RELEASE_RECIPE/PKGBUILD" "$RELEASE_RECIPE/tauri-explorer-bin.install" "$RELEASE_STAGE/"
  # The checked-in recipe pins an older release. Fresh checksums are appended
  # rather than edited in: the later assignment wins, and nothing else in the
  # recipe is at risk. The .deb is then held to GitHub's digest, below.
  sed -i "s/^pkgver=.*/pkgver=$version/" "$RELEASE_STAGE/PKGBUILD"
  (cd "$RELEASE_STAGE" && SRCDEST="$RELEASE_STAGE" makepkg -g >sums) \
    || build_needed "could not download release $version" || return
  cat "$RELEASE_STAGE/sums" >> "$RELEASE_STAGE/PKGBUILD"

  actual=$(sha256sum "$RELEASE_STAGE/$deb")
  if [[ sha256:${actual%% *} != "$digest" ]]; then
    echo "$deb does not match GitHub's published $digest; nothing was installed." >&2
    exit 1
  fi

  # Dependencies are for pacman -U to resolve, not for repackaging.
  (cd "$RELEASE_STAGE" && SRCDEST="$RELEASE_STAGE" PKGDEST="$RELEASE_STAGE" \
    BUILDDIR="$RELEASE_STAGE/build" PKGEXT=.pkg.tar.zst makepkg -f --nodeps --noconfirm) \
    || build_needed "could not repackage release $version" || return
  PKG="$RELEASE_STAGE/tauri-explorer-bin-${version}-1-x86_64.pkg.tar.zst"
  # makepkg succeeds on an empty package(), and pacman would install it.
  bsdtar -tf "$PKG" usr/bin/tauri-explorer >/dev/null 2>&1 \
    || build_needed "repackaging release $version produced no application" || return
}

# Compiling takes minutes and may interrupt whatever else the machine is doing,
# so it is never started silently. Unanswerable means no.
confirm_source_build() {
  local summary="A prebuilt package is unavailable: $1."
  echo "$summary" >&2
  # notify-send is optional: terminals without a desktop session still get the prompt.
  if command -v notify-send >/dev/null; then
    notify-send --app-name="Tauri Explorer installer" "Tauri Explorer needs a source build" "$1" 2>/dev/null || true
  fi
  if [[ $ACCEPT_BUILD == 1 ]]; then return; fi
  local reply=
  if ! ( : </dev/tty ) 2>/dev/null; then
    echo "Cannot ask for confirmation here; rerun with --yes or --source to build from source." >&2
    exit 1
  fi
  read -r -p "Build from source instead? This takes several minutes. [y/N] " reply </dev/tty || true
  if [[ $reply != [yY]* ]]; then
    echo "Nothing was installed." >&2
    exit 1
  fi
}

if [[ $MODE == release ]]; then
  if ! package_latest_release; then
    confirm_source_build "$BUILD_REASON"
    MODE=full
  fi
fi

if [[ $MODE == full || $MODE == build ]]; then
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

if [[ $UP_TO_DATE == 0 ]]; then
  echo "Installing ${PKG}..."
  # The source and binary packages conflict, and --noconfirm alone takes
  # pacman's default "no" on replacing one with the other. --ask=4 inverts that
  # one question (ALPM_QUESTION_CONFLICT_PKG), so either can follow the other.
  sudo -n pacman -U "$PKG" --noconfirm --ask=4
fi

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
