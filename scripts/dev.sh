#!/usr/bin/env bash
# Run the Tauri dev server with auto port selection.
#
# Usage: ./scripts/dev.sh [OPTIONS]
#   --clean       Nuke all caches before starting (frontend + Rust)
#   --clean-fast  Nuke frontend caches only
#   --port PORT   Use a specific port (default: auto-find from 1420)
#
# Issue: tauri-jsn1.8

set -euo pipefail
cd "$(dirname "$0")/.."

PORT=""
CLEAN=""

for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN="full" ;;
    --clean-fast) CLEAN="fast" ;;
    --port)
      # handled below with shift
      ;;
    --port=*)
      PORT="${arg#--port=}"
      ;;
    *)
      # capture value after --port
      if [[ "${PREV_ARG:-}" == "--port" ]]; then
        PORT="$arg"
      fi
      ;;
  esac
  PREV_ARG="$arg"
done

# Clean caches if requested
if [[ "$CLEAN" == "full" ]]; then
  echo "=== Nuking all caches ==="
  bash scripts/clean-rebuild.sh
elif [[ "$CLEAN" == "fast" ]]; then
  echo "=== Nuking frontend caches ==="
  bash scripts/clean-rebuild.sh --no-rust
fi

# Find an available port starting from 1420
find_free_port() {
  local p=$1
  while ss -tlnp 2>/dev/null | grep -q ":${p} " || lsof -iTCP:"${p}" -sTCP:LISTEN &>/dev/null; do
    ((p++))
  done
  echo "$p"
}

if [[ -z "$PORT" ]]; then
  PORT=$(find_free_port 1420)
fi

echo "=== Starting dev server on port $PORT ==="

export DEV_PORT="$PORT"
exec bunx tauri dev --config "{\"build\":{\"devUrl\":\"http://localhost:${PORT}\",\"beforeDevCommand\":\"DEV_PORT=${PORT} bun run dev\"}}"
