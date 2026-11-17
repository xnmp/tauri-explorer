#!/usr/bin/env bash
# Bounded, cached apt installs for CI jobs that need Tauri's Linux system
# libraries (#1371). The hosted runners' mirror has taken 17–35 minutes to
# deliver these packages; an unbounded install then ran into the job timeout,
# where the automatic re-run (scripts/ci-jobs.mjs SETUP_STEP) cannot see it.
#
#   apt.sh update   refresh the package index
#   apt.sh key      print the cache key and restore prefix (GITHUB_OUTPUT lines)
#   apt.sh install  install APT_PACKAGES, reusing the .debs in APT_ARCHIVES
#
# A package written as `a|b` installs the first alternative that has an
# install candidate in the refreshed index. Runner images rename packages
# between Ubuntu releases (24.04's webkit2gtk-driver is 26.04's
# webkitgtk-webdriver), and `ubuntu-latest` can resolve to either image while
# GitHub rolls a new one out, so one list has to install on both.
#
# Every apt command runs in attempts of APT_ATTEMPT_TIMEOUT seconds (index
# refreshes APT_UPDATE_ATTEMPT_TIMEOUT), at most APT_ATTEMPTS times, so a stalled mirror fails in this setup step. apt checks
# each reused .deb against the refreshed index's hashes and downloads any that
# do not match, so a stale or damaged cache costs time, never correctness.
#
# If every index refresh fails, the Ubuntu sources are pointed at each of
# APT_FALLBACK_MIRRORS in turn (the canonical archive, then a mirror outside
# ubuntu.com DNS) and the refresh is retried, APT_FALLBACK_ATTEMPTS per mirror:
# the image's Azure mirror and archive.ubuntu.com have both been unreachable
# from runners for hours, failing every Linux job in setup (#1647). Every
# mirror's InRelease is still verified against the Ubuntu archive keyring.
set -euo pipefail

attempts=${APT_ATTEMPTS:-3}
attempt_timeout=${APT_ATTEMPT_TIMEOUT:-240}
update_attempt_timeout=${APT_UPDATE_ATTEMPT_TIMEOUT:-120}
packages=${APT_PACKAGES:-}
archives=${APT_ARCHIVES:-}
fallback_mirrors=${APT_FALLBACK_MIRRORS:-http://archive.ubuntu.com/ubuntu/ https://mirrors.edge.kernel.org/ubuntu/}
fallback_attempts=${APT_FALLBACK_ATTEMPTS:-2}
apt_etc=${APT_ETC_DIR:-/etc/apt}
# Failure annotation level; a recoverable refresh failure only warns.
fail_level=error

# bounded <label> <command...>: run as root with a per-attempt timeout and
# retries. timeout runs inside sudo: the runners' sudo (use_pty) puts the
# command in its own session and ignores a signal sent to its own process
# group, so `timeout sudo apt-get` killed only sudo and left apt-get/dpkg
# holding the dpkg lock, refusing every retry (#1520).
bounded() {
  local label=$1 n status reason
  shift
  for ((n = 1; n <= attempts; n++)); do
    status=0
    sudo timeout --kill-after=10 "$attempt_timeout" "$@" || status=$?
    [ "$status" -eq 0 ] && return 0
    case $status in
      124 | 137) reason="timed out after ${attempt_timeout}s" ;;
      *) reason="exited with status $status" ;;
    esac
    echo "::warning title=${label} attempt ${n}/${attempts}::${label} ${reason}"
    # An interrupted install can leave packages unpacked but unconfigured.
    sudo dpkg --configure -a || true
  done
  echo "::${fail_level} title=${label} failed::${label} failed ${attempts} attempts of ${attempt_timeout}s"
  return 1
}

# use_mirror <from-regex> <to>: rewrite matching Ubuntu source URIs. Returns 1
# when no source matches, so a failure unrelated to the mirror is not retried
# against another one.
use_mirror() {
  local from=$1 to=$2 files
  files=$(grep -rlE "$from" "$apt_etc/sources.list" "$apt_etc/sources.list.d" 2>/dev/null || true)
  [ -n "$files" ] || return 1
  echo "::warning title=apt mirror fallback::switching Ubuntu sources to ${to}"
  # `-i.orig` (a suffix) is the form GNU and BSD sed share; BSD sed would read
  # a bare `-i -E` as the suffix `-E`. apt ignores `*.list.orig`, but drop the
  # backups so the next mirror pass does not rewrite them too.
  # shellcheck disable=SC2086 # one path per line, none contain spaces.
  sudo sed -i.orig -E "s#${from}#${to}#g" $files
  local file
  for file in $files; do sudo rm -f "${file}.orig"; done
}

# Regex for the image's own mirror sources: its mirror list or Azure archive.
image_mirror='mirror\+file:[^ ]*apt-mirrors\.txt|https?://azure\.archive\.ubuntu\.com/ubuntu/?'

sha() { sha256sum | cut -c1-16; }

# has_candidate <package>: the refreshed index can install it. Capture the
# output before matching: under pipefail, `apt-cache policy | grep -q` fails
# with SIGPIPE (141) once grep exits on its first match.
has_candidate() {
  local policy
  policy=$(apt-cache policy "$1" 2>/dev/null) || return 1
  [[ $policy =~ Candidate:\ [^\(] ]]
}

# resolve_packages: APT_PACKAGES with each `a|b` replaced by the first
# alternative that has a candidate. Fails, naming every alternative, when none
# does, so a renamed package is reported in this setup step.
resolve_packages() {
  local token alt chosen alts resolved=()
  for token in $packages; do
    if [[ $token != *"|"* ]]; then
      resolved+=("$token")
      continue
    fi
    chosen=
    IFS='|' read -ra alts <<<"$token"
    for alt in "${alts[@]}"; do
      if [ -n "$alt" ] && has_candidate "$alt"; then
        chosen=$alt
        break
      fi
    done
    if [ -z "$chosen" ]; then
      echo "::error title=apt package unavailable::no install candidate for any of: ${token//|/, }" >&2
      for alt in "${alts[@]}"; do apt-cache policy "$alt" >&2 || true; done
      return 1
    fi
    resolved+=("$chosen")
  done
  echo "${resolved[*]}"
}

require() {
  if [ -z "${!1:-}" ]; then
    echo "::error::$1 is required" >&2
    exit 2
  fi
}

case ${1:-} in
  update)
    fail_level=warning
    if attempt_timeout=$update_attempt_timeout bounded "apt index refresh" apt-get update; then
      exit 0
    fi
    from=$image_mirror
    attempts=$fallback_attempts
    for mirror in $fallback_mirrors; do
      if ! use_mirror "$from" "$mirror"; then
        echo "::error title=apt index refresh failed::no Ubuntu mirror source to replace"
        exit 1
      fi
      if attempt_timeout=$update_attempt_timeout bounded "apt index refresh (${mirror})" apt-get update; then
        exit 0
      fi
      from=$(sed 's/[.+?^$|()]/\\&/g' <<<"$mirror")
    done
    echo "::error title=apt index refresh failed::every Ubuntu mirror failed: image mirror ${fallback_mirrors}"
    exit 1
    ;;
  key)
    require APT_PACKAGES
    packages=$(resolve_packages)
    # The package list names the cache; the simulated install (exact versions
    # this runner image and index still need) picks its revision, so an image
    # or archive update saves a new entry that a restore prefix still seeds.
    list=$(tr -s ' \n' '\n' <<<"$packages" | sed '/^$/d' | sort -u | sha)
    # shellcheck disable=SC2086 # APT_PACKAGES is a space-separated list.
    plan=$(apt-get -s install $packages | { grep '^Inst ' || true; } | sort | sha)
    prefix="tauri-apt-v1-${ImageOS:-unknown}-${list}-"
    echo "key=${prefix}${plan}"
    echo "restore-prefix=${prefix}"
    ;;
  install)
    require APT_PACKAGES
    require APT_ARCHIVES
    packages=$(resolve_packages)
    # Create the cache path as the runner: a root-owned ~/.cache would break
    # later tools that write there (the Tauri bundler's ~/.cache/tauri).
    mkdir -p "$archives"
    sudo mkdir -p "$archives/partial"
    before=$(find "$archives" -maxdepth 1 -name '*.deb' | wc -l | tr -d '[:space:]')
    # The cache lives under the runner's home, which apt's _apt download
    # sandbox user cannot write; download as root instead of warning per file.
    # shellcheck disable=SC2086 # APT_PACKAGES is a space-separated list.
    bounded "apt install" env DEBIAN_FRONTEND=noninteractive \
      apt-get install -y \
      -o "Dir::Cache::archives=$archives" \
      -o APT::Keep-Downloaded-Packages=true \
      -o APT::Sandbox::User=root \
      -o DPkg::Lock::Timeout=60 \
      $packages
    # Drop superseded versions so the saved cache holds what installs need.
    sudo apt-get -o "Dir::Cache::archives=$archives" autoclean -qq
    sudo rm -rf "$archives/partial" "$archives/lock"
    sudo chown -R "$(id -u):$(id -g)" "$archives"
    after=$(find "$archives" -maxdepth 1 -name '*.deb' | wc -l | tr -d '[:space:]')
    echo "apt cache: ${before} .debs restored, ${after} after install ($(du -sh "$archives" | cut -f1))"
    ;;
  *)
    echo "usage: apt.sh update|key|install" >&2
    exit 2
    ;;
esac
