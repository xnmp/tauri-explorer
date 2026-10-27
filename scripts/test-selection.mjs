// test-selection.mjs — shared rules for CI's per-tier PR test selection (#1175).
//
// unit-affected.mjs, rust-affected.mjs and e2e-affected.mjs each narrow one
// tier to what a PR diff can affect. They share the input (the git diff, never
// PR text), the escalations that force a full run, and one result shape:
//   { mode: "all" | "selected" | "none", reason: string, items: string[] }
// Over-selection is safe; silent under-selection is not, so any doubt is "all".

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyVersionOnly, onlyVersionFiles } from "./version-only.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Default cap on changed files; ci.yml passes TEST_SELECTION_MAX_FILES. */
export const DEFAULT_MAX_FILES = 50;

/** @typedef {{ mode: "all" | "selected" | "none", reason: string, items: string[] }} Selection */

// Paths are echoed into logs and step outputs, so anything outside this set
// (spaces, quotes, newlines, git's quoted escapes) escalates without echoing.
const SAFE_PATH = /^[A-Za-z0-9_.\/@+,=-]+$/;

/**
 * File types every tier knows how to judge. A file of any other type means the
 * selectors cannot reason about it, so each tier runs in full.
 */
const MODULE_EXT = /\.(ts|js|mjs|cjs|svelte|css)$/;
const DATA_EXT =
  /\.(md|json|jsonc|ya?ml|toml|rs|lock|txt|html|xml|plist|svg|png|jpe?g|gif|webp|ico|icns|avif|heic|bmp|tiff?|pdf|mp4|webm|mp3|wav|ogg|zip|tar|gz|sh|ps1|nix|desktop|portal|mountinfo|snap|csv|wasm|ttf|otf|woff2?|gitignore|gitattributes|gitkeep|editorconfig|npmrc|example|patch|conf|cfg|ini|env)$/i;
const KNOWN_NAMES = new Set(["PKGBUILD", "LICENSE", ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".prettierrc", ".prettierignore", ".nvmrc"]);

/** @param {string} file */
export const isModule = (file) => MODULE_EXT.test(file);

/** @param {string} file */
export const isKnownType = (file) => {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return MODULE_EXT.test(name) || DATA_EXT.test(name) || KNOWN_NAMES.has(name);
};

/** @param {string} file */
export const baseName = (file) => file.slice(file.lastIndexOf("/") + 1);

/**
 * Escalations shared by every tier: a diff too large to trust a narrow
 * selection, a path the selectors cannot safely echo, or a file type they do
 * not recognise. Returns the reason to run everything, or null.
 * @param {string[]} changed
 * @param {number} maxFiles
 */
export function sharedEscalation(changed, maxFiles) {
  if (changed.length > maxFiles) {
    return `${changed.length} changed files exceed the selection limit of ${maxFiles}`;
  }
  if (changed.some((f) => !SAFE_PATH.test(f))) return "a changed path contains unusual characters";
  const unknown = changed.find((f) => !isKnownType(f));
  if (unknown) return `unknown file type: ${unknown}`;
  return null;
}

/**
 * @param {string[]} reasons escalation reasons, first one most relevant
 * @returns {Selection}
 */
export function allOf(reasons) {
  const extra = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : "";
  return { mode: "all", reason: `${reasons[0]}${extra}`, items: [] };
}

/**
 * Files changed between the merge base of `base` and `head`. Renames are
 * reported as delete + add, so the old path's tests are selected too.
 * @param {string} base
 * @param {string} head
 */
export function gitChangedFiles(base, head, root = ROOT) {
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", `${base}...${head}`], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * Read files on both sides of `base...head`: "base" is their merge base (what
 * the diff compares against), "head" the head commit. Absent files read null.
 * @param {string} base
 * @param {string} head
 * @returns {import("./version-only.mjs").BlobReader}
 */
export function gitBlobReader(base, head, root = ROOT) {
  /** @type {string | undefined} */
  let mergeBase;
  return (side, path) => {
    if (side === "base") {
      mergeBase ??= execFileSync("git", ["merge-base", base, head], { cwd: root, encoding: "utf8" }).trim();
    }
    const rev = side === "base" ? mergeBase : head;
    try {
      return execFileSync("git", ["show", `${rev}:${path}`], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
}

/**
 * Whether the diff is a release version bump (scripts/version-only.mjs).
 * Blobs are read only when every changed path is a version file.
 * @param {string[]} changed
 * @param {import("./version-only.mjs").BlobReader} read
 */
export const versionOnlyChange = (changed, read) =>
  onlyVersionFiles(changed) && classifyVersionOnly(changed, read).versionOnly;

/**
 * Parse `[--max-files N] [base] [head]` shared by the selector CLIs.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const rest = [];
  let maxFiles = DEFAULT_MAX_FILES;
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-files") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--max-files needs a non-negative integer, got ${argv[i]}`);
      maxFiles = n;
    } else if (a.startsWith("--")) {
      flags.add(a);
    } else {
      rest.push(a);
    }
  }
  const [base = "origin/dev", head = "HEAD"] = rest;
  return { base, head, maxFiles, flags };
}

/**
 * Run a selector against the git diff and print its Selection as JSON. Any
 * failure, including in git or the selector itself, prints a full run.
 * @param {string} tier label for diagnostics
 * @param {(changed: string[], maxFiles: number, context: { versionOnly: boolean }) => Selection} select
 */
export function runCli(tier, select) {
  /** @type {Selection} */
  let result;
  try {
    const { base, head, maxFiles } = parseArgs(process.argv.slice(2));
    const changed = gitChangedFiles(base, head);
    result = select(changed, maxFiles, { versionOnly: versionOnlyChange(changed, gitBlobReader(base, head)) });
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
    process.stderr.write(`[${tier}] selection failed: ${message}\n`);
    result = { mode: "all", reason: "selection failed", items: [] };
  }
  process.stderr.write(`[${tier}] ${result.mode}: ${result.reason}\n`);
  process.stdout.write(JSON.stringify(result) + "\n");
}
