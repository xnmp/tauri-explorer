#!/usr/bin/env node
// updater-manifest.mjs — assemble the signed self-update manifest (#1679).
//
// Usage:  node scripts/updater-manifest.mjs --tag v1.26.0 --dir artifacts \
//           --notes release-notes.md --repo owner/name --out latest.json \
//           [--config src-tauri/tauri.conf.json]
//
// Run by release.yml after the build matrix's bundles are downloaded. Every
// updater platform needs exactly one asset and its `.sig` (written by
// `cargo tauri build` with `bundle.createUpdaterArtifacts`). The updater
// plugin validates the whole manifest before choosing a platform, so a
// partial or malformed manifest would break updates everywhere: any missing
// piece fails the release instead.
//
// Every signature is also verified against the public key installed apps
// embed (`plugins.updater.pubkey` in --config). tauri-cli only warns when the
// signing secret does not match it; publishing such a release would make
// every install download the update daily and reject it.
//
// Platform keys are bundle-specific (`linux-x86_64-deb`, not `linux-x86_64`):
// the plugin looks up `{os}-{arch}-{bundle}` first, and an unbundled build
// (no embedded bundle type) then finds nothing, which is the intent.

import { createHash, createPublicKey, verify } from "node:crypto";
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
 * Verify a Tauri updater signature (minisign) over `data`.
 * `signature` is the `.sig` file text and `pubkey` the `plugins.updater.pubkey`
 * value; both are base64 of minisign's text formats. Checks the key id, the
 * Ed25519 signature over the BLAKE2b-512 prehash (`ED`) or the raw data
 * (legacy `Ed`), and the global signature over the trusted comment.
 * @param {{ data: Uint8Array, signature: string, pubkey: string }} input
 * @returns {string | null} null when valid, otherwise why not.
 */
export function updaterSignatureProblem({ data, signature, pubkey }) {
  /** @param {string} text */
  const lines = (text) => Buffer.from(text.trim(), "base64").toString("utf8").split(/\r?\n/);
  try {
    const keyLine = lines(pubkey).find((l) => l && !l.startsWith("untrusted comment:"));
    const key = Buffer.from(keyLine ?? "", "base64");
    if (key.length !== 42 || key.subarray(0, 2).toString("latin1") !== "Ed") {
      return "public key is not a minisign Ed25519 key";
    }
    const sigLines = lines(signature);
    const sigAt = sigLines.findIndex((l) => l && !l.startsWith("untrusted comment:"));
    const sig = Buffer.from(sigLines[sigAt] ?? "", "base64");
    const trusted = sigLines[sigAt + 1] ?? "";
    const globalSig = Buffer.from(sigLines[sigAt + 2] ?? "", "base64");
    if (sig.length !== 74 || !trusted.startsWith("trusted comment: ") || globalSig.length !== 64) {
      return "signature is not in minisign format";
    }
    if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) {
      return "signed with a different key than the embedded public key";
    }
    const algorithm = sig.subarray(0, 2).toString("latin1");
    if (algorithm !== "ED" && algorithm !== "Ed") return `unknown signature algorithm ${algorithm}`;
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key.subarray(10).toString("base64url") },
      format: "jwk",
    });
    const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
    if (!verify(null, message, publicKey, sig.subarray(10))) return "signature does not match the file";
    const comment = Buffer.from(trusted.slice("trusted comment: ".length), "utf8");
    if (!verify(null, Buffer.concat([sig.subarray(10), comment]), publicKey, globalSig)) {
      return "trusted comment signature is invalid";
    }
    return null;
  } catch (error) {
    return `unreadable signature or key: ${error instanceof Error ? error.message : String(error)}`;
  }
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

/**
 * @param {string} name
 * @param {string} fallback
 */
function optionalArg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
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
  const config = JSON.parse(readFileSync(optionalArg("config", "src-tauri/tauri.conf.json"), "utf8"));
  const pubkey = config?.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || !pubkey) throw new Error("No plugins.updater.pubkey in the Tauri config");
  const byName = new Map(files.map((f) => [basename(f), f]));
  const invalid = Object.entries(manifest.platforms).flatMap(([key, { url, signature }]) => {
    const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    const path = byName.get(name);
    const problem = path
      ? updaterSignatureProblem({ data: readFileSync(path), signature, pubkey })
      : "asset file not found";
    return problem ? [`${key} (${name}): ${problem}`] : [];
  });
  if (invalid.length) throw new Error(`Updater signatures fail verification:\n  ${invalid.join("\n  ")}`);
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
