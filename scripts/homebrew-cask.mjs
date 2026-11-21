#!/usr/bin/env node
// homebrew-cask.mjs — render the Homebrew cask for a release (#1876).
//
// Usage:  node scripts/homebrew-cask.mjs <version> <path-to-aarch64.dmg>
//
// Prints Casks/tauri-explorer.rb for the tap (xnmp/homebrew-tap), so
// `brew install --cask xnmp/tap/tauri-explorer` installs that release.
// release.yml's `homebrew` job runs it after the release is published and
// writes the result to the tap.
//
// The DMG is Developer ID signed and notarized (#1671), so the cask needs no
// quarantine caveat. The app updates itself (#1679): `auto_updates true`
// keeps `brew upgrade` from fighting the in-app updater, and the cask only
// has to be current for new installs.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const IDENTIFIER = "io.github.xnmp.tauri-explorer";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The cask for one release. Throws on a version or digest that would make a
 * cask Homebrew rejects or that points at the wrong file.
 * @param {{ version: string, sha256: string }} release
 * @returns {string}
 */
export function renderCask({ version, sha256 }) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`Not a release version: ${JSON.stringify(version)}`);
  }
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    throw new Error(`Not a lowercase hex SHA-256 digest: ${JSON.stringify(sha256)}`);
  }
  return `cask "tauri-explorer" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/xnmp/tauri-explorer/releases/download/v#{version}/tauri-explorer_#{version}_aarch64.dmg"
  name "Tauri Explorer"
  desc "Keyboard-first file manager with fuzzy quick-open and a command palette"
  homepage "https://github.com/xnmp/tauri-explorer"

  # The app updates itself; brew upgrade leaves it to the in-app updater.
  auto_updates true
  depends_on arch: :arm64

  app "tauri-explorer.app"

  zap trash: [
    "~/Library/Application Support/${IDENTIFIER}",
    "~/Library/Application Support/tauri-explorer",
    "~/Library/Caches/${IDENTIFIER}",
    "~/Library/Logs/${IDENTIFIER}",
    "~/Library/Preferences/${IDENTIFIER}.plist",
    "~/Library/Saved Application State/${IDENTIFIER}.savedState",
    "~/Library/WebKit/${IDENTIFIER}",
  ]
end
`;
}

/**
 * Lowercase hex SHA-256 of a file's bytes.
 * @param {string} path
 * @returns {string}
 */
export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, dmg] = process.argv.slice(2);
  if (!version || !dmg) {
    console.error("Usage: node scripts/homebrew-cask.mjs <version> <path-to-aarch64.dmg>");
    process.exit(2);
  }
  process.stdout.write(renderCask({ version, sha256: sha256File(dmg) }));
}
