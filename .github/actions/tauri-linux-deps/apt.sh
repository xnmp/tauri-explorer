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
# Every apt command runs in attempts of APT_ATTEMPT_TIMEOUT seconds (index
# refreshes APT_UPDATE_ATTEMPT_TIMEOUT), at most APT_ATTEMPTS times, so a stalled mirror fails in this setup step. apt checks
# each reused .deb against the refreshed index's hashes and downloads any that
# do not match, so a stale or damaged cache costs time, never correctness.
set -euo pipefail

attempts=${APT_ATTEMPTS:-3}
attempt_timeout=${APT_ATTEMPT_TIMEOUT:-240}
update_attempt_timeout=${APT_UPDATE_ATTEMPT_TIMEOUT:-120}
packages=${APT_PACKAGES:-}
archives=${APT_ARCHIVES:-}

# bounded <label> <command...>: run with a per-attempt timeout and retries.
bounded() {
  local label=$1 n status reason
  shift
  for ((n = 1; n <= attempts; n++)); do
    status=0
    timeout --kill-after=10 "$attempt_timeout" "$@" || status=$?
    [ "$status" -eq 0 ] && return 0
    case $status in
      124 | 137) reason="timed out after ${attempt_timeout}s" ;;
      *) reason="exited with status $status" ;;
    esac
    echo "::warning title=${label} attempt ${n}/${attempts}::${label} ${reason}"
    # An interrupted install can leave packages unpacked but unconfigured.
    sudo dpkg --configure -a || true
  done
  echo "::error title=${label} failed::${label} failed ${attempts} attempts of ${attempt_timeout}s"
  return 1
}

sha() { sha256sum | cut -c1-16; }

require() {
  if [ -z "${!1:-}" ]; then
    echo "::error::$1 is required" >&2
    exit 2
  fi
}

case ${1:-} in
  update)
    attempt_timeout=$update_attempt_timeout bounded "apt index refresh" sudo apt-get update
    ;;
  key)
    require APT_PACKAGES
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
    # Create the cache path as the runner: a root-owned ~/.cache would break
    # later tools that write there (the Tauri bundler's ~/.cache/tauri).
    mkdir -p "$archives"
    sudo mkdir -p "$archives/partial"
    before=$(find "$archives" -maxdepth 1 -name '*.deb' | wc -l)
    # The cache lives under the runner's home, which apt's _apt download
    # sandbox user cannot write; download as root instead of warning per file.
    # shellcheck disable=SC2086 # APT_PACKAGES is a space-separated list.
    bounded "apt install" sudo env DEBIAN_FRONTEND=noninteractive \
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
    after=$(find "$archives" -maxdepth 1 -name '*.deb' | wc -l)
    echo "apt cache: ${before} .debs restored, ${after} after install ($(du -sh "$archives" | cut -f1))"
    ;;
  *)
    echo "usage: apt.sh update|key|install" >&2
    exit 2
    ;;
esac
