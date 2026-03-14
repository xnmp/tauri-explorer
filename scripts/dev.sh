#!/usr/bin/env bash
# Run the Tauri dev server with auto port selection.
#
# Usage: ./scripts/dev.sh [OPTIONS]
#   (default)     Nuke frontend caches before starting
#   --clean       Also reinstall node_modules
#   --clean-all   Nuke everything (frontend + node_modules + Rust)
#   --port PORT   Use a specific port (default: deterministic per worktree)
#   --vite-only   Start only the Vite dev server (no Tauri/Rust)
#
# Worktree support: each git worktree gets a deterministic port derived from
# its directory name, so multiple agents can run independent dev servers
# concurrently without port conflicts.
#
# Issue: tauri-jsn1.8, tauri-explorer-z3bz

set -euo pipefail
cd "$(dirname "$0")/.."

PORT=""
CLEAN="default"
VITE_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN="clean" ;;
    --clean-all) CLEAN="full" ;;
    --vite-only) VITE_ONLY=true ;;
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

# Clean caches
if [[ "$CLEAN" == "full" ]]; then
  echo "=== Nuking all caches (frontend + node_modules + Rust) ==="
  bash scripts/clean-rebuild.sh
elif [[ "$CLEAN" == "clean" ]]; then
  echo "=== Nuking frontend caches + reinstalling node_modules ==="
  bash scripts/clean-rebuild.sh --no-rust
else
  echo "=== Nuking frontend caches ==="
  bash scripts/clean-rebuild.sh --no-rust --keep-node-modules
fi

# Derive a deterministic port from the worktree directory name.
# Primary repo (tauri-explorer) → 1420, worktree-2 → 1422, worktree-3 → 1423, etc.
worktree_port() {
  local dir_name
  dir_name="$(basename "$(pwd)")"
  # Extract worktree suffix number (e.g., "worktree-2" → 2)
  if [[ "$dir_name" =~ -([0-9]+)$ ]]; then
    echo $(( 1420 + ${BASH_REMATCH[1]} ))
  else
    echo 1420
  fi
}

# Find an available port starting from a given base
find_free_port() {
  local p=$1
  while ss -tlnp 2>/dev/null | grep -q ":${p} " || lsof -iTCP:"${p}" -sTCP:LISTEN &>/dev/null; do
    ((p++))
  done
  echo "$p"
}

if [[ -z "$PORT" ]]; then
  BASE_PORT=$(worktree_port)
  PORT=$(find_free_port "$BASE_PORT")
fi

# Write port to .dev-port so scripts/validate.sh can find the running server
echo "$PORT" > .dev-port

echo "=== Starting dev server on port $PORT ($(basename "$(pwd)")) ==="

export DEV_PORT="$PORT"

if [[ "$VITE_ONLY" == true ]]; then
  exec bun run dev -- --port "$PORT"
else
  exec bunx tauri dev --config "{\"build\":{\"devUrl\":\"http://localhost:${PORT}\",\"beforeDevCommand\":\"DEV_PORT=${PORT} bun run dev\"}}"
fi
