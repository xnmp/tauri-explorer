#!/usr/bin/env node
// bump-version.mjs — set the release version in every file that carries it (#1800).
//
// package.json is the single source: tauri.conf.json reads it
// (`"version": "../package.json"`) and the PKGBUILD's pkgver() derives from
// it at build time. Cargo still needs its own copy, and the PKGBUILD keeps a
// literal fallback for tooling that reads it without running makepkg. This
// script edits exactly those version tokens, byte for byte, and checks each
// edit with the version-only comparators CI uses to classify a release diff.
//
// Usage: bun run bump-version <version>    (or node scripts/bump-version.mjs <version>)
//   Refuses a version that is not SemVer, one equal to the current version,
//   and one without a dated `## v<version> — YYYY-MM-DD` CHANGELOG.md section
//   (the heading release.yml turns into the release notes).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cargoLockVersionOnly,
  cargoTomlVersionOnly,
  jsonVersionOnly,
  pkgbuildVersionOnly,
} from "./version-only.mjs";

/** Repository-relative files the bump edits, keyed by role. */
export const BUMP_FILES = /** @type {const} */ ({
  packageJson: "package.json",
  cargoToml: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
  pkgbuild: "PKGBUILD",
});

export const CHANGELOG = "CHANGELOG.md";

/** The application's own crate, whose Cargo.lock entry carries its version. */
const CRATE = "tauri-explorer";

/** @typedef {{ packageJson: string, cargoToml: string, cargoLock: string, pkgbuild: string }} VersionSources */

// SemVer 2.0.0 (semver.org's recommended expression, without a `v` prefix).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** @param {string} version */
export const isSemver = (version) => SEMVER.test(version);

/** @param {string} text */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether CHANGELOG.md has a dated section for `version`, in the form
 * release.yml parses: `## v<version> — YYYY-MM-DD`.
 * @param {string} changelog
 * @param {string} version
 */
export const hasDatedChangelogSection = (changelog, version) =>
  new RegExp(`^## v${escape(version)} — \\d{4}-\\d{2}-\\d{2}\\r?$`, "m").test(changelog);

/**
 * One regex match, or an error naming the file.
 * @param {string} text
 * @param {RegExp} pattern a global pattern whose groups are (prefix)(version)(suffix)
 * @param {string} file
 */
function single(text, pattern, file) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${file}: expected one version, found ${matches.length}`);
  return /** @type {RegExpMatchArray & { index: number }} */ (matches[0]);
}

/**
 * Replace the version group of the single match.
 * @param {string} text
 * @param {RegExpMatchArray & { index: number }} match
 * @param {string} version
 */
const splice = (text, match, version) => {
  const start = match.index + match[1].length;
  return text.slice(0, start) + version + text.slice(start + match[2].length);
};

/** Locators for each file's version token: (prefix)(version)(suffix). */
const LOCATORS = {
  // The first "version" key at two-space indentation: package.json's top level.
  packageJson: /^( {2}"version": ")([^"\n]*)(")/gm,
  pkgbuild: /^(pkgver=)(\S+)()$/gm,
  cargoLock: new RegExp(`^(\\[\\[package\\]\\]\\r?\\nname = "${CRATE}"\\r?\\nversion = ")([^"\\n]*)(")`, "gm"),
};

/**
 * The `[package]` section's version line in Cargo.toml.
 * @param {string} text
 */
function cargoTomlMatch(text) {
  const header = /^\[package\]\r?$/m.exec(text);
  if (!header) throw new Error(`${BUMP_FILES.cargoToml}: no [package] section`);
  const bodyStart = header.index + header[0].length;
  const next = /^\[/m.exec(text.slice(bodyStart));
  const body = text.slice(bodyStart, next ? bodyStart + next.index : text.length);
  const match = single(body, /^(version = ")([^"\n]*)(")/gm, BUMP_FILES.cargoToml);
  return Object.assign(match, { index: bodyStart + match.index });
}

/**
 * The version each source carries.
 * @param {VersionSources} sources
 * @returns {VersionSources}
 */
export function readVersions(sources) {
  return {
    packageJson: single(sources.packageJson, LOCATORS.packageJson, BUMP_FILES.packageJson)[2],
    cargoToml: cargoTomlMatch(sources.cargoToml)[2],
    cargoLock: single(sources.cargoLock, LOCATORS.cargoLock, BUMP_FILES.cargoLock)[2],
    pkgbuild: single(sources.pkgbuild, LOCATORS.pkgbuild, BUMP_FILES.pkgbuild)[2],
  };
}

/** Each source's version-only comparator (scripts/version-only.mjs). */
const VERIFIERS = {
  packageJson: jsonVersionOnly,
  cargoToml: cargoTomlVersionOnly,
  cargoLock: cargoLockVersionOnly,
  pkgbuild: pkgbuildVersionOnly,
};

/**
 * Set `version` in every source. Pure: returns the edited texts.
 * @param {VersionSources} sources
 * @param {string} changelog CHANGELOG.md's text
 * @param {string} version SemVer, without a `v` prefix
 * @returns {VersionSources}
 */
export function bumpVersion(sources, changelog, version) {
  if (!isSemver(version)) throw new Error(`Not a SemVer version (no "v" prefix): ${version}`);
  if (!hasDatedChangelogSection(changelog, version)) {
    throw new Error(`${CHANGELOG} has no "## v${version} — YYYY-MM-DD" section; add the release notes first`);
  }
  const current = readVersions(sources);
  if (Object.values(current).every((v) => v === version)) throw new Error(`Already at version ${version}`);
  const next = {
    packageJson: splice(sources.packageJson, single(sources.packageJson, LOCATORS.packageJson, BUMP_FILES.packageJson), version),
    cargoToml: splice(sources.cargoToml, cargoTomlMatch(sources.cargoToml), version),
    cargoLock: splice(sources.cargoLock, single(sources.cargoLock, LOCATORS.cargoLock, BUMP_FILES.cargoLock), version),
    pkgbuild: splice(sources.pkgbuild, single(sources.pkgbuild, LOCATORS.pkgbuild, BUMP_FILES.pkgbuild), version),
  };
  for (const key of /** @type {(keyof VersionSources)[]} */ (Object.keys(next))) {
    // An already-aligned file stays byte-identical; any other edit must be
    // exactly the version change CI classifies as version-only.
    if (current[key] === version) continue;
    if (!VERIFIERS[key](sources[key], next[key])) {
      throw new Error(`${BUMP_FILES[key]}: the edit would change more than its version`);
    }
  }
  if (JSON.parse(next.packageJson).version !== version) {
    throw new Error(`${BUMP_FILES.packageJson}: the top-level version was not the one edited`);
  }
  return next;
}

function main() {
  const [version, ...rest] = process.argv.slice(2);
  if (!version || rest.length > 0) throw new Error("Usage: bump-version.mjs <version>");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (/** @type {string} */ rel) => readFileSync(join(root, rel), "utf8");
  const sources = /** @type {VersionSources} */ (Object.fromEntries(
    Object.entries(BUMP_FILES).map(([key, rel]) => [key, read(rel)]),
  ));
  const before = readVersions(sources);
  const next = bumpVersion(sources, read(CHANGELOG), version);
  for (const [key, rel] of Object.entries(BUMP_FILES)) {
    const k = /** @type {keyof VersionSources} */ (key);
    if (next[k] !== sources[k]) writeFileSync(join(root, rel), next[k]);
    console.log(`${rel}: ${before[k]} -> ${version}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`bump-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
