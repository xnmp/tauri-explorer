// version-only.mjs — recognise a release version bump in a PR diff (#1367).
//
// A version bump edits the root package.json, which every CI tier otherwise
// treats as a config change that runs everything. This module decides, from
// the file contents on both sides of the diff, whether the only change is the
// version in the files a release aligns (plus CHANGELOG.md). Each file is
// compared structurally with its version removed; anything else differing,
// a file that does not parse, or a missing side means "not version-only",
// so the callers fall back to their ordinary (full) selection.

/** Files a version bump edits, each with a comparator for its format. */
export const VERSION_FILES = {
  "package.json": "json",
  "src-tauri/tauri.conf.json": "json",
  "src-tauri/Cargo.toml": "cargo-toml",
  "src-tauri/Cargo.lock": "cargo-lock",
  PKGBUILD: "pkgbuild",
};

/** Release notes may accompany a bump; they are never read as code. */
const COMPANIONS = new Set(["CHANGELOG.md"]);

/** @typedef {{ versionOnly: boolean, reason: string }} VersionVerdict */
/** @typedef {(side: "base" | "head", path: string) => string | null} BlobReader */

/** True when every changed path could belong to a version bump. */
export const onlyVersionFiles = (/** @type {string[]} */ changed) =>
  changed.length > 0 && changed.every((f) => Object.hasOwn(VERSION_FILES, f) || COMPANIONS.has(f));

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) &&
    deepEqual(/** @type {Record<string, unknown>} */ (a)[k], /** @type {Record<string, unknown>} */ (b)[k]));
}

/**
 * A JSON object whose only difference is its top-level string `version`.
 * @param {string} before
 * @param {string} after
 */
export function jsonVersionOnly(before, after) {
  let a;
  let b;
  try { a = JSON.parse(before); b = JSON.parse(after); } catch { return false; }
  const isObject = (/** @type {unknown} */ v) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(a) || !isObject(b)) return false;
  if (typeof a.version !== "string" || typeof b.version !== "string" || a.version === b.version) return false;
  const { version: _a, ...restA } = a;
  const { version: _b, ...restB } = b;
  return deepEqual(restA, restB);
}

const VERSION_LINE = /^version\s*=\s*"([^"\\\n]+)"\s*$/;

/**
 * Split TOML-like text into header-delimited sections. Line-level comparison
 * is deliberately stricter than TOML semantics: reformatting counts as change.
 * @param {string} text
 * @returns {{ header: string, lines: string[] }[]}
 */
function sections(text) {
  /** @type {{ header: string, lines: string[] }[]} */
  const out = [{ header: "", lines: [] }];
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) out.push({ header: line.trim(), lines: [] });
    else /** @type {{ lines: string[] }} */ (out.at(-1)).lines.push(line);
  }
  return out;
}

/**
 * Remove the single `version = "..."` line of a section.
 * @param {string[]} lines
 * @returns {{ version: string, rest: string[] } | null} null when not exactly one
 */
function takeVersion(lines) {
  const at = lines.flatMap((l, i) => (VERSION_LINE.test(l) ? [i] : []));
  if (at.length !== 1) return null;
  const version = /** @type {RegExpExecArray} */ (VERSION_LINE.exec(lines[at[0]]))[1];
  return { version, rest: lines.filter((_, i) => i !== at[0]) };
}

/**
 * Sections pairwise identical, except that `editable(section)` sections may
 * differ in their one version line, and at least one version changed.
 * @param {string} before
 * @param {string} after
 * @param {(header: string, lines: string[]) => boolean} editable
 */
function sectionVersionOnly(before, after, editable) {
  const a = sections(before);
  const b = sections(after);
  if (a.length !== b.length) return false;
  let changed = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].header !== b[i].header) return false;
    const same = a[i].lines.length === b[i].lines.length && a[i].lines.every((l, j) => l === b[i].lines[j]);
    if (same) continue;
    if (!editable(a[i].header, a[i].lines) || !editable(b[i].header, b[i].lines)) return false;
    const va = takeVersion(a[i].lines);
    const vb = takeVersion(b[i].lines);
    if (!va || !vb || va.version === vb.version) return false;
    if (va.rest.length !== vb.rest.length || va.rest.some((l, j) => l !== vb.rest[j])) return false;
    changed = true;
  }
  return changed;
}

/**
 * Cargo.toml whose only difference is `[package] version`.
 * @param {string} before
 * @param {string} after
 */
export const cargoTomlVersionOnly = (before, after) =>
  sectionVersionOnly(before, after, (header) => header === "[package]");

/**
 * Cargo.lock whose only differences are the versions of local packages
 * (entries with no `source`, i.e. this workspace's own crates).
 * @param {string} before
 * @param {string} after
 */
export const cargoLockVersionOnly = (before, after) =>
  sectionVersionOnly(before, after, (header, lines) =>
    header === "[[package]]" && !lines.some((l) => /^source\s*=/.test(l)));

/**
 * PKGBUILD whose only difference is its literal `pkgver=` line.
 * @param {string} before
 * @param {string} after
 */
export function pkgbuildVersionOnly(before, after) {
  const PKGVER = /^pkgver=\S+$/;
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) return false;
  let changed = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!PKGVER.test(a[i]) || !PKGVER.test(b[i])) return false;
    changed = true;
  }
  return changed && a.filter((l) => PKGVER.test(l)).length === 1;
}

/** @type {Record<string, (before: string, after: string) => boolean>} */
const COMPARATORS = {
  json: jsonVersionOnly,
  "cargo-toml": cargoTomlVersionOnly,
  "cargo-lock": cargoLockVersionOnly,
  pkgbuild: pkgbuildVersionOnly,
};

/**
 * Whether a diff changes only release versions.
 * @param {string[]} changed repo-relative paths
 * @param {BlobReader} read file content at the merge base ("base") or the head;
 *   null when the file is absent on that side
 * @returns {VersionVerdict}
 */
export function classifyVersionOnly(changed, read) {
  if (!onlyVersionFiles(changed)) return { versionOnly: false, reason: "not a version-file-only diff" };
  const versioned = changed.filter((f) => Object.hasOwn(VERSION_FILES, f));
  if (versioned.length === 0) return { versionOnly: false, reason: "no version file changed" };
  for (const file of versioned) {
    const before = read("base", file);
    const after = read("head", file);
    if (before === null || after === null) return { versionOnly: false, reason: `${file} was added or deleted` };
    const kind = VERSION_FILES[/** @type {keyof typeof VERSION_FILES} */ (file)];
    if (!COMPARATORS[kind](before, after)) return { versionOnly: false, reason: `${file} changes more than its version` };
  }
  return { versionOnly: true, reason: `version-only change: ${versioned.join(", ")}` };
}
