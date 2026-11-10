#!/usr/bin/env bash
# Agent self-validation: take a screenshot of the running dev server.
#
# Usage: ./scripts/validate.sh [URL_PATH]
#   URL_PATH  Optional path to navigate to (default: /)
#
# Prerequisites:
#   - Dev server running (via scripts/dev.sh or bun run dev)
#   - Playwright browsers installed
#
# Outputs a screenshot to test-screenshots/validate-<timestamp>.png
# and prints the path so agents can read it.
#
# Issue: tauri-explorer-ip9f

set -euo pipefail
cd "$(dirname "$0")/.."

URL_PATH="${1:-/}"
SCREENSHOT_DIR="test-screenshots"
mkdir -p "$SCREENSHOT_DIR"

# Determine dev server port
if [[ -f .dev-port ]]; then
  PORT=$(cat .dev-port)
elif [[ -n "${DEV_PORT:-}" ]]; then
  PORT="$DEV_PORT"
else
  PORT=1420
fi

BASE_URL="http://localhost:${PORT}"

# Wait for dev server to be ready (up to 30 seconds)
echo "Waiting for dev server at ${BASE_URL}..."
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w '%{http_code}' "$BASE_URL" 2>/dev/null | grep -q '200'; then
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "ERROR: Dev server not ready after 30s at ${BASE_URL}" >&2
    exit 1
  fi
  sleep 1
done

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SCREENSHOT_PATH="${SCREENSHOT_DIR}/validate-${TIMESTAMP}.png"

# Use Playwright to take a screenshot
npx playwright test --reporter=list -g "NOOP" 2>/dev/null || true  # ensure browsers ready

node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('${BASE_URL}${URL_PATH}', { waitUntil: 'networkidle', timeout: 15000 });
  // Wait a moment for any animations/transitions
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '${SCREENSHOT_PATH}', fullPage: false });
  await browser.close();
})();
"

echo "Screenshot saved: ${SCREENSHOT_PATH}"
