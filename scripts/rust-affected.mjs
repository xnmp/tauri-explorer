#!/usr/bin/env node
// rust-affected.mjs — select the Cargo packages a diff affects (#1175).
//
// Usage:  node scripts/rust-affected.mjs [--max-files N] [base] [head]
//   Prints a test-selection.mjs Selection as JSON. Its items are workspace
//   member names for `cargo test -p <name>`.
//
// Rules, in order (over-selection is safe; silent under-selection is not):
//   1. Shared escalations (too many files, unusual path, unknown type) -> all.
//   2. CI selection itself (ci.yml, this script, test-selection.mjs) or the
//      test-result cache wiring (turbo.json, test-cache.mjs, ci-test-rust.sh) -> all.
//   3. Cargo.lock, the workspace Cargo.toml, toolchain or .cargo config -> all.
//   4. A Rust source or manifest outside src-tauri/ -> all (no known crate).
//   5. A file under src-tauri/ touches the local package whose directory most
//      deeply contains it; a file elsewhere whose basename ends a string
//      literal in the Rust sources (include_bytes!, fixture paths) touches the
//      package that names it.
//   6. Affected = touched packages plus every local package that depends on
//      them, transitively, from `cargo metadata`'s resolve graph. Workspace
//      members among them are tested; all of them -> all.
//   A release version bump (scripts/version-only.mjs) -> none: no crate's
//   behaviour depends on its version, and native smoke still builds and boots
//   the binary (#1367).
//   `cargo metadata` runs only when some file touches Rust; a failure -> all.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, allOf, baseName, runCli, sharedEscalation } from "./test-selection.mjs";

/** @typedef {import("./test-selection.mjs").Selection} Selection */
/** @typedef {{ name: string, dir: string, id: string }} LocalPackage */
/** @typedef {{ members: string[], packages: LocalPackage[], dependents: Map<string, Set<string>> }} CrateGraph */
/** @typedef {{ rel: string, content: string }} RustSource */

const CRATE_ROOT = "src-tauri";
const MANIFEST = `${CRATE_ROOT}/Cargo.toml`;

const SELECTION_INPUTS = new Set([
  ".github/workflows/ci.yml",
  "scripts/rust-affected.mjs",
  "scripts/test-selection.mjs",
  "scripts/version-only.mjs",
  // How the target runs through the test-result cache (#1176).
  "turbo.json",
  "scripts/test-cache.mjs",
  "scripts/ci-test-rust.sh",
]);

/** @param {string} f */
const isWorkspaceWide = (f) =>
  f === MANIFEST ||
  f === `${CRATE_ROOT}/Cargo.lock` ||
  /(^|\/)rust-toolchain(\.toml)?$/.test(f) ||
  /(^|\/)\.cargo\/config(\.toml)?$/.test(f);

/**
 * Reduce `cargo metadata --format-version 1` to its local (path) packages and
 * the reverse dependency edges between them.
 * @param {any} metadata
 * @param {string} root repository root the package directories are made relative to
 * @returns {CrateGraph}
 */
export function crateGraph(metadata, root = ROOT) {
  /** @type {Map<string, LocalPackage>} */
  const local = new Map();
  for (const p of metadata.packages) {
    if (p.source !== null) continue;
    const dir = relative(root, dirname(p.manifest_path)).split("\\").join("/");
    local.set(p.id, { name: p.name, dir, id: p.id });
  }
  /** @type {Map<string, Set<string>>} */
  const dependents = new Map();
  for (const node of metadata.resolve?.nodes ?? []) {
    if (!local.has(node.id)) continue;
    for (const dep of node.deps ?? []) {
      if (!local.has(dep.pkg)) continue;
      if (!dependents.has(dep.pkg)) dependents.set(dep.pkg, new Set());
      /** @type {Set<string>} */ (dependents.get(dep.pkg)).add(node.id);
    }
  }
  const members = metadata.workspace_members.filter((/** @type {string} */ id) => local.has(id));
  return { members, packages: [...local.values()], dependents };
}

/**
 * @param {string} file repo-relative path
 * @param {LocalPackage[]} packages
 */
function owningPackage(file, packages) {
  let best = null;
  for (const p of packages) {
    if ((file === p.dir || file.startsWith(`${p.dir}/`)) && (!best || p.dir.length > best.dir.length)) best = p;
  }
  return best;
}

/** Rust sources, manifests and build scripts that may name external inputs. */
export function loadRustSources(root = ROOT) {
  /** @type {RustSource[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "target" && entry.name !== "node_modules") walk(child);
      } else if (/\.(rs|toml|json)$/.test(entry.name)) {
        out.push({ rel: child, content: readFileSync(join(root, child), "utf8") });
      }
    }
  };
  walk(CRATE_ROOT);
  return out;
}

/**
 * @param {string[]} changed
 * @param {RustSource[]} sources
 * @param {{ maxFiles: number, metadata: () => any, root?: string, versionOnly?: boolean }} options
 *   metadata is called only when some changed file reaches Rust; root is the
 *   repository directory its manifest paths are relative to; versionOnly: the
 *   diff only bumps release versions (scripts/version-only.mjs).
 * @returns {Selection}
 */
export function selectRust(changed, sources, { maxFiles, metadata, root = ROOT, versionOnly = false }) {
  if (changed.length === 0) return { mode: "none", reason: "no changed files", items: [] };
  const shared = sharedEscalation(changed, maxFiles);
  if (shared) return allOf([shared]);
  if (versionOnly) {
    return { mode: "none", reason: "version-only change; native smoke still builds and boots the binary", items: [] };
  }

  /** @type {string[]} */
  const reasons = [];
  /** Changed file -> the files whose package it touches. */
  const touching = [];
  for (const f of changed) {
    if (SELECTION_INPUTS.has(f)) { reasons.push(`CI test-selection change: ${f}`); continue; }
    if (isWorkspaceWide(f)) { reasons.push(`workspace-wide Cargo change: ${f}`); continue; }
    if (f.startsWith(`${CRATE_ROOT}/`)) { touching.push(f); continue; }
    if (/\.rs$|(^|\/)Cargo\.(toml|lock)$/.test(f)) { reasons.push(`Rust file outside ${CRATE_ROOT}/: ${f}`); continue; }
    // Only string literals ending in the name, so comments mentioning
    // CLAUDE.md or a doc do not count as inputs.
    const name = baseName(f);
    for (const s of sources) {
      if (s.content.includes(`"${name}"`) || s.content.includes(`/${name}"`)) touching.push(s.rel);
    }
  }
  if (reasons.length > 0) return allOf(reasons);
  if (touching.length === 0) return { mode: "none", reason: `none of ${changed.length} changed file(s) feeds a Rust crate`, items: [] };

  const graph = crateGraph(metadata(), root);
  /** @type {Set<string>} */
  const touched = new Set();
  for (const f of touching) {
    const owner = owningPackage(f, graph.packages);
    if (!owner) return allOf([`changed file belongs to no known crate: ${f}`]);
    touched.add(owner.id);
  }
  const affected = new Set(touched);
  const queue = [...touched];
  while (queue.length > 0) {
    for (const parent of graph.dependents.get(/** @type {string} */ (queue.pop())) ?? []) {
      if (!affected.has(parent)) { affected.add(parent); queue.push(parent); }
    }
  }
  const byId = new Map(graph.packages.map((p) => [p.id, p.name]));
  const touchedNames = [...touched].map((id) => byId.get(id)).sort().join(", ");
  const tested = graph.members.filter((id) => affected.has(id));
  if (tested.length === 0) return { mode: "none", reason: `changed crate(s) ${touchedNames} have no dependent workspace member`, items: [] };
  if (tested.length === graph.members.length) {
    return allOf([`changed crate(s) ${touchedNames} affect every workspace member`]);
  }
  const items = tested.map((id) => /** @type {string} */ (byId.get(id))).sort();
  return { mode: "selected", reason: `changed crate(s) ${touchedNames} and their dependents`, items };
}

function cargoMetadata() {
  const out = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--manifest-path", join(ROOT, MANIFEST)],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(out);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli("rust-affected", (changed, maxFiles, { versionOnly }) =>
    selectRust(changed, loadRustSources(), { maxFiles, metadata: cargoMetadata, versionOnly }));
}
