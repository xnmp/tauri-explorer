#!/usr/bin/env bash
# Run a command under eatmydata when the disk backing the repo has slow FLUSH
# handling (DRAM-less SSDs: no cache to absorb fsync, so every flush persists
# FTL state — measured ~10-70ms each on such drives). Browser test runs fsync
# at every test boundary, and those flushes stall the whole desktop.
# Test state is throwaway, so dropping fsync durability here is safe.
#
# Detection is behavioral, not by drive model: lifetime avg flush latency from
# /proc/diskstats (fields 18/19: flushes completed, ms flushing). Threshold
# 5ms — drives with DRAM ack flushes well under that.
#
# Usage: scripts/fsync-safe.sh <command...>
set -euo pipefail

wrap=""
if command -v eatmydata >/dev/null 2>&1; then
  src=$(findmnt -nv -o SOURCE --target "$PWD" 2>/dev/null | head -1 || true)
  base=$(lsblk -no PKNAME "$src" 2>/dev/null | head -1 || true)
  [ -n "$base" ] || base=$(basename "${src:-}")
  if [ -n "$base" ]; then
    stats=$(awk -v d="$base" 'NF==20 && $3==d {print $19, $20}' /proc/diskstats)
    if [ -n "$stats" ]; then
      read -r flushes flush_ms <<<"$stats"
      # Slow-flush device: enough samples and >5ms average per flush.
      if awk -v f="$flushes" -v t="$flush_ms" 'BEGIN{exit !(f>100 && t/f>5)}'; then
        wrap="eatmydata"
        echo "fsync-safe: $base averages $(( flush_ms / flushes ))ms/flush (DRAM-less?) — running under eatmydata" >&2
      fi
    fi
  fi
elif [ "$(uname)" = "Linux" ]; then
  echo "fsync-safe: eatmydata not installed — running without it (install libeatmydata to cut SSD flush stalls during test runs)" >&2
fi

exec ${wrap:+$wrap} "$@"
