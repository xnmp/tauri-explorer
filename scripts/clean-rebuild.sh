#!/usr/bin/env bash
# Clean all caches and rebuild from scratch.
# Usage: ./scripts/clean-rebuild.sh [--no-rust]
#
# Clears: node_modules, Vite cache, SvelteKit output, Svelte preprocessor
# cache, TypeScript build info, Playwright browsers cache, Rust target dir
# (unless --no-rust), and then reinstalls + rebuilds everything.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

SKIP_RUST=false
for arg in "$@"; do
  case "$arg" in
    --no-rust) SKIP_RUST=true ;;
  esac
done

echo "=== Cleaning all caches ==="

# Frontend caches
rm -rf node_modules
rm -rf node_modules/.vite
rm -rf .svelte-kit
rm -rf build
rm -rf .vite
rm -rf tsconfig.tsbuildinfo

# Vite / Svelte temp files
rm -rf .svelte-kit/output
rm -rf .svelte-kit/generated

# Vitest cache
rm -rf node_modules/.vitest

# Playwright cache (local)
rm -rf test-results
rm -rf playwright-report

# Rust / Tauri
if [ "$SKIP_RUST" = false ] && [ -d src-tauri ]; then
  echo "Cleaning Rust target (use --no-rust to skip)..."
  cargo clean --manifest-path src-tauri/Cargo.toml 2>/dev/null || true
fi

echo "=== Installing dependencies ==="
bun install

echo "=== Syncing SvelteKit ==="
npx svelte-kit sync

echo "=== Type-checking ==="
npx svelte-check --tsconfig ./tsconfig.json || true

echo "=== Building frontend ==="
npx vite build

if [ "$SKIP_RUST" = false ] && [ -d src-tauri ]; then
  echo "=== Checking Rust compilation ==="
  cargo check --manifest-path src-tauri/Cargo.toml
fi

echo "=== Running unit tests ==="
bun run test

echo ""
echo "Done. Everything rebuilt from scratch."
