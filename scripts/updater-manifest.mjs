#!/usr/bin/env node
// updater-manifest.mjs — assemble the signed self-update manifest (#1679).
//
// Usage:  node scripts/updater-manifest.mjs --tag v1.26.0 --dir artifacts \
//           --notes release-notes.md --repo owner/name --out latest.json
//
// Run by release.yml after the build matrix's bundles are downloaded. Every
// updater platform needs exactly one asset and its `.sig` (written by
// `cargo tauri build` with `bundle.createUpdaterArtifacts`). The updater
// plugin validates the whole manifest before choosing a platform, so a
// partial or malformed manifest would break updates everywhere: any missing
// piece fails the release instead.
//
// Platform keys are bundle-specific (`linux-x86_64-deb`, not `linux-x86_64`):
// the plugin looks up `{os}-{arch}-{bundle}` first, and an unbundled build
// (no embedded bundle type) then finds nothing, which is the intent.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Updater platform key → expected release asset name for a version.
 * The macOS `.app.tar.gz` is renamed to this versioned name by release.yml
 * (the bundler names it after the product only).
 * @type {ReadonlyArray<{ key: string, matches: (name: string, version: string) => boolean }>}
 */
export const UPDATER_PLATFORMS = [
  { key: "linux-x86_64-appimage", matches: (n, v) => n === `tauri-explorer_${v}_amd64.AppImage` },
  { key: "linux-x86_64-deb", matches: (n, v) => n === `tauri-explorer_${v}_amd64.deb` },
  {
    key: "linux-x86_64-rpm",
    matches: (n, v) => new RegExp(`^tauri-explorer-${escapeRegExp(v)}-\\d+\\.x86_64\\.rpm$`).test(n),
  },
  { key: "windows-x86_64-nsis", matches: (n, v) => n === `tauri-explorer_${v}_x64-setup.exe` },
  { key: "windows-x86_64-msi", matches: (n, v) => n === `tauri-explorer_${v}_x64_en-US.msi` },
  { key: "darwin-aarch64-app", matches: (n, v) => n === `tauri-explorer_${v}_aarch64.app.tar.gz` },
];

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the manifest from release asset names and their signatures.
 * @param {{ tag: string, repo: string, notes: string, pubDate: string,
 *           assets: ReadonlyArray<string>, signatures: Readonly<Record<string, string>> }} input
 *   `assets`: release asset file names; `signatures`: asset name → `.sig` text.
 * @returns {{ version: string, notes: string, pub_date: string,
 *             platforms: Record<string, { signature: string, url: string }> }}
 */
export function buildUpdaterManifest({ tag, repo, notes, pubDate, assets, signatures }) {
  const version = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Release tag is not a SemVer version: ${tag}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Invalid repository: ${repo}`);
  if (Number.isNaN(Date.parse(pubDate))) throw new Error(`Invalid publication date: ${pubDate}`);

  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, { signature: string, url: string }>} */
  const platforms = {};
  for (const { key, matches } of UPDATER_PLATFORMS) {
    const found = assets.filter((name) => matches(name, version));
    if (found.length !== 1) {
      problems.push(`${key}: expected exactly one asset, found ${found.length ? found.join(", ") : "none"}`);
      continue;
    }
    const [name] = found;
    const signature = signatures[name]?.trim();
    if (!signature) {
      problems.push(`${key}: missing signature ${name}.sig`);
      continue;
    }
    platforms[key] = {
      signature,
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    };
  }
  if (problems.length) throw new Error(`Cannot build the updater manifest:\n  ${problems.join("\n  ")}`);
  return { version, notes: notes.trim(), pub_date: new Date(pubDate).toISOString(), platforms };
}

/**
 * Recursively list files under `dir` (the merged build-matrix artifacts).
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** @param {string} name */
function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function main() {
  const files = listFiles(arg("dir"));
  const sigFiles = files.filter((f) => f.endsWith(".sig"));
  const signatures = Object.fromEntries(
    sigFiles.map((f) => [basename(f).slice(0, -".sig".length), readFileSync(f, "utf8")]),
  );
  const manifest = buildUpdaterManifest({
    tag: arg("tag"),
    repo: arg("repo"),
    notes: readFileSync(arg("notes"), "utf8"),
    pubDate: new Date().toISOString(),
    assets: files.filter((f) => !f.endsWith(".sig")).map((f) => basename(f)),
    signatures,
  });
  writeFileSync(arg("out"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updater manifest ${manifest.version}: ${Object.keys(manifest.platforms).join(", ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
