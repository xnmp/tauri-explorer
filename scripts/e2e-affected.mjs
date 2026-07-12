#!/usr/bin/env node
// e2e-affected.mjs — select the E2E specs affected by a diff.
//
// Usage:  node scripts/e2e-affected.mjs [base]
//   base defaults to "origin/dev". Diff is `git diff --name-only <base>...HEAD`.
//
// Output (stdout): newline-separated spec paths (e.g. "e2e/foo.spec.ts"),
//   OR the literal string "ALL" when the whole suite must run.
// Diagnostics go to stderr.
//
// Selection rules (over-selection is safe; silent under-selection is not):
//   1. Changed e2e/*.spec.ts            -> the spec itself.
//   2. Changed src-tauri/src/**         -> ALL (backend affects everything).
//      Changed src/lib/api/mock-invoke.ts -> ALL (it is the test backend).
//      Changed a "central hub" file       -> ALL (map says: affects almost anything).
//   3. Other changed src/** files       -> map to feature clusters via
//      docs/code-map/map-feature.md, then to specs by scanning spec contents
//      for cluster-derived keyword phrases. If a src file matches no cluster,
//      or a matched cluster resolves to no spec -> ALL (+ warning).
//   4. Build/config files (package.json, lockfile, *.config.*, tsconfig) -> ALL.
//   5. Everything else (docs, screenshots, scripts, .claude, e2e-tauri) -> ignored.
//   If map-feature.md is missing -> ALL (+ warning).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_PATH = join(ROOT, "docs/code-map/map-feature.md");
const E2E_DIR = join(ROOT, "e2e");

const warn = (m) => process.stderr.write(`[e2e-affected] ${m}\n`);

// --- helpers -------------------------------------------------------------

// Ubiquitous, non-distinctive phrases that would over-match every spec.
const STOP = new Set([
  "files", "file", "api", "index", "page", "path", "lib", "mod", "use",
  "view", "list", "item", "items", "store", "state", "bar", "menu",
  "panel", "dialog", "modal", "common", "shared", "helpers", "mock-invoke",
  "config", "utils", "types", "core", "main", "app", "svelte",
]);
// Short tokens we still trust as distinctive.
const SHORT_ALLOW = new Set(["scm", "git", "zip", "ai", "pty", "dnd"]);

const toKebab = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .toLowerCase();

const okPhrase = (p) =>
  p && !STOP.has(p) && (p.length >= 4 || SHORT_ALLOW.has(p));

// Strip a repo path down to a comparable basename (no dirs, no extensions).
function baseName(token) {
  let t = token.replace(/\/+$/, "");
  const seg = t.slice(t.lastIndexOf("/") + 1);
  return seg.replace(/\.(svelte\.ts|svelte|ts|rs|css|js|mjs)$/i, "");
}

// Does a changed repo file correspond to a map file token? Map tokens for the
// frontend omit the src/lib (or src/) prefix, so suffix matching is the workhorse.
function fileMatchesToken(file, token) {
  const t = token.replace(/\/+$/, "");
  if (token.endsWith("/")) return file.includes(t + "/") || file.startsWith(t + "/");
  return file === t || file.endsWith("/" + t) || file.endsWith(t);
}

// --- parse map-feature.md ------------------------------------------------

// Returns { hubs: string[], clusters: [{title, files, phrases:Set}] }
export function parseMap(text) {
  const lines = text.split("\n");
  const backtickPaths = (line) => {
    const out = [];
    const re = /`([^`]+)`/g;
    let m;
    while ((m = re.exec(line))) {
      const tok = m[1].trim();
      // Path-like: contains a slash, or ends with a known extension.
      if (/\//.test(tok) || /\.(svelte|ts|rs|css|js|mjs)$/i.test(tok)) {
        // Skip obvious function/identifier calls like `createExplorerState`.
        if (/[()]/.test(tok)) continue;
        out.push(tok);
      }
    }
    return out;
  };

  const hubs = [];
  const clusters = [];
  let current = null;
  let inHubs = false;

  for (const line of lines) {
    if (line.startsWith("# ")) continue;
    // "Central hubs" guidance lives in the intro paragraph before the first "## ".
    if (/central hubs/i.test(line)) inHubs = true;
    if (line.startsWith("## ")) {
      inHubs = false;
      current = { title: line.slice(3).trim(), files: [], phrases: new Set() };
      clusters.push(current);
      continue;
    }
    if (line.trim() === "---") { current = null; continue; }

    const paths = backtickPaths(line);
    if (inHubs) hubs.push(...paths);
    else if (current) current.files.push(...paths);
  }

  // Derive keyword phrases per cluster.
  for (const c of clusters) {
    // From the title: kebab bigrams of adjacent words (drops parentheticals).
    const titleWords = c.title
      .replace(/\([^)]*\)/g, " ")
      .split(/[^a-zA-Z0-9]+/)
      .map((w) => w.toLowerCase())
      .filter(Boolean);
    for (let i = 0; i < titleWords.length - 1; i++) {
      const bg = `${titleWords[i]}-${titleWords[i + 1]}`;
      if (bg.length >= 4) c.phrases.add(bg);
    }
    for (const w of titleWords) if (SHORT_ALLOW.has(w)) c.phrases.add(w);
    // From each file basename: kebab, and a suffix-trimmed variant.
    for (const f of c.files) {
      const kb = toKebab(baseName(f));
      if (okPhrase(kb)) c.phrases.add(kb);
      const trimmed = kb.replace(/-(view|panel|dialog|bar|store|svelte)$/i, "");
      if (trimmed !== kb && okPhrase(trimmed)) c.phrases.add(trimmed);
    }
  }
  return { hubs, clusters };
}

// --- spec index ----------------------------------------------------------

export function loadSpecs() {
  const specs = [];
  for (const name of readdirSync(E2E_DIR)) {
    if (!name.endsWith(".spec.ts")) continue;
    const rel = `e2e/${name}`;
    let content = "";
    try { content = readFileSync(join(E2E_DIR, name), "utf8").toLowerCase(); }
    catch { /* ignore */ }
    specs.push({ rel, content });
  }
  return specs;
}

function specsForCluster(cluster, specs) {
  const hits = [];
  for (const s of specs) {
    for (const p of cluster.phrases) {
      if (s.content.includes(p)) { hits.push(s.rel); break; }
    }
  }
  return hits;
}

// --- classification ------------------------------------------------------

export function classify(changed, map, specs) {
  const selected = new Set();
  const warnings = [];
  let all = false;
  const triggerAll = (reason) => { all = true; warnings.push(reason); };

  const isConfig = (f) =>
    /^package\.json$/.test(f) ||
    /^bun\.lock(b)?$/.test(f) ||
    /\.config\.(ts|js|mjs|cjs)$/.test(f) ||
    /^tsconfig.*\.json$/.test(f) ||
    /^svelte\.config\./.test(f);

  const isIgnored = (f) =>
    f.startsWith("docs/") ||
    f.startsWith("screenshots/") ||
    f.startsWith("scripts/") ||
    f.startsWith(".claude/") ||
    f.startsWith("e2e-tauri/") ||
    f.startsWith(".github/") ||
    /(^|\/)(README|CHANGELOG)\.md$/i.test(f) ||
    f.endsWith(".md");

  for (const f of changed) {
    if (/^e2e\/.+\.spec\.ts$/.test(f)) {
      if (existsSync(join(ROOT, f))) selected.add(f);
      continue;
    }
    if (f.startsWith("src-tauri/src/")) { triggerAll(`backend change: ${f}`); continue; }
    if (f === "src/lib/api/mock-invoke.ts") { triggerAll(`mock backend change: ${f}`); continue; }
    if (map.hubs.some((h) => fileMatchesToken(f, h))) { triggerAll(`central-hub change: ${f}`); continue; }

    if (f.startsWith("src/")) {
      const matched = map.clusters.filter((c) => c.files.some((t) => fileMatchesToken(f, t)));
      if (matched.length === 0) { triggerAll(`unmapped src file (no cluster): ${f}`); continue; }
      const clusterSpecs = [];
      for (const c of matched) clusterSpecs.push(...specsForCluster(c, specs));
      if (clusterSpecs.length === 0) {
        triggerAll(`cluster(s) [${matched.map((c) => c.title).join(", ")}] matched ${f} but resolved to no spec`);
        continue;
      }
      for (const s of clusterSpecs) selected.add(s);
      continue;
    }

    if (isConfig(f)) { triggerAll(`build/config change: ${f}`); continue; }
    if (isIgnored(f)) continue;
    // Unknown top-level file — do not risk silent under-selection.
    triggerAll(`unrecognized change: ${f}`);
  }

  return { all, selected, warnings };
}

// --- main ----------------------------------------------------------------

function main() {
  const base = process.argv[2] || "origin/dev";
  // Optional head ref (default HEAD). The merge hook passes the feature branch
  // so the diff is dev...<branch> while checked out on dev.
  const head = process.argv[3] || "HEAD";
  let changed;
  try {
    const out = execSync(`git diff --name-only ${base}...${head}`, {
      cwd: ROOT,
      encoding: "utf8",
    });
    changed = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    warn(`git diff failed for ${base}...${head}: ${e.message}`);
    warn("falling back to ALL");
    process.stdout.write("ALL\n");
    return;
  }

  if (changed.length === 0) {
    warn(`no changes for ${base}...${head}; nothing affected`);
    return; // empty output
  }

  if (!existsSync(MAP_PATH)) {
    warn(`missing ${MAP_PATH}; cannot map src changes — falling back to ALL`);
    process.stdout.write("ALL\n");
    return;
  }

  const map = parseMap(readFileSync(MAP_PATH, "utf8"));
  const specs = loadSpecs();
  const { all, selected, warnings } = classify(changed, map, specs);

  for (const w of warnings) warn(w);

  if (all) {
    warn(`selection: ALL (${warnings.length} escalation reason(s) above)`);
    process.stdout.write("ALL\n");
    return;
  }

  const list = [...selected].sort();
  warn(`selection: ${list.length} spec(s) from ${changed.length} changed file(s)`);
  process.stdout.write(list.join("\n") + (list.length ? "\n" : ""));
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
