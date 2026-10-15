#!/usr/bin/env node
// e2e-affected.mjs — select the E2E specs affected by a diff.
//
// Usage:  node scripts/e2e-affected.mjs [--strict] [--json] [--max-files N] [base] [head]
//   base defaults to "origin/dev", head to "HEAD".
//   --json: print a test-selection.mjs Selection (mode, reason, items) instead.
//   --max-files N (CI): also apply the escalations every CI tier shares —
//   more than N changed files, an unusual path or an unknown file type -> ALL.
//   Diff is `git diff --name-only --no-renames <base>...<head>`.
//   --strict (CI): any src/ change runs everything. Keyword clusters miss specs
//   that exercise a component incidentally (#1131 review), so they only advise
//   local runs; CI narrows only for changes that never ship in the frontend.
//
// Output (stdout): newline-separated spec paths (e.g. "e2e/foo.spec.ts"),
//   OR the literal string "ALL" when the whole suite must run.
// Diagnostics go to stderr.
//
// Selection rules (over-selection is safe; silent under-selection is not):
//   0. A spec whose text names a changed file's repo path -> that spec, even
//      when the file is otherwise ignored (e.g. tests/fixtures/*.json read by
//      a spec).
//   1. Changed e2e/*.spec.ts            -> the spec itself.
//   2. Changed src/lib/api/mock-*.ts   -> ALL (the test backend).
//      Changed e2e/ helpers or fixtures  -> ALL (shared by every spec).
//      Changed a "central hub" file       -> ALL (map says: affects almost anything).
//   3. Other changed src/** files       -> map to feature clusters via
//      docs/code-map/map-feature.md, then to specs by scanning spec contents
//      for cluster-derived keyword phrases. If a src file matches no cluster,
//      or a matched cluster resolves to no spec -> ALL (+ warning).
//      Under --strict, every src/** change -> ALL.
//   4. Build/config files (package.json, lockfile, *.config.*, tsconfig) -> ALL,
//      except Vitest configs, which the browser suite never loads. Scripts the
//      dev server runs (named in vite.config.ts, playwright.config.ts or
//      package.json, plus their relative imports) -> ALL.
//   5. Files the browser suite never executes -> ignored: src-tauri/ (the
//      suite runs against mock-invoke, never Rust; e2e-tauri covers the real
//      backend), tests/, evidence/, docs, screenshots, scripts, .claude,
//      e2e-tauri, .github, packaging, e2e-load and e2e-sweep (their own
//      configs), Nix and editor files.
//   6. Changes to CI selection itself (ci.yml, e2e-shards.mjs,
//      e2e-affected.mjs, test-selection.mjs, map-feature.md) -> ALL.
//   7. Anything else (an unknown top-level file)  -> ALL.
//   If map-feature.md is missing -> ALL (+ warning).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";
import { allOf, gitChangedFiles, parseArgs, sharedEscalation } from "./test-selection.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_PATH = join(ROOT, "docs/code-map/map-feature.md");
const E2E_DIR = join(ROOT, "e2e");

/** @typedef {{ title: string, files: string[], phrases: Set<string> }} Cluster */
/** @typedef {{ hubs: string[], clusters: Cluster[] }} CodeMap */
/** @typedef {{ rel: string, content: string }} SpecEntry */

/** @param {string} m */
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

/** @param {string} s */
const toKebab = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .toLowerCase();

/** @param {string} p */
const okPhrase = (p) =>
  p && !STOP.has(p) && (p.length >= 4 || SHORT_ALLOW.has(p));

// Strip a repo path down to a comparable basename (no dirs, no extensions).
/** @param {string} token */
function baseName(token) {
  let t = token.replace(/\/+$/, "");
  const seg = t.slice(t.lastIndexOf("/") + 1);
  return seg.replace(/\.(svelte\.ts|svelte|ts|rs|css|js|mjs)$/i, "");
}

// Does a changed repo file correspond to a map file token? Map tokens for the
// frontend omit the src/lib (or src/) prefix, so suffix matching is the workhorse.
/**
 * @param {string} file
 * @param {string} token
 */
function fileMatchesToken(file, token) {
  const t = token.replace(/\/+$/, "");
  if (token.endsWith("/")) return file.includes(t + "/") || file.startsWith(t + "/");
  return file === t || file.endsWith("/" + t) || file.endsWith(t);
}

// --- parse map-feature.md ------------------------------------------------

// Returns { hubs: string[], clusters: [{title, files, phrases:Set}] }
/**
 * @param {string} text
 * @returns {CodeMap}
 */
export function parseMap(text) {
  const lines = text.split("\n");
  /** @param {string} line */
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

  /** @type {string[]} */
  const hubs = [];
  /** @type {Cluster[]} */
  const clusters = [];
  /** @type {Cluster | null} */
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

/**
 * @param {Cluster} cluster
 * @param {SpecEntry[]} specs
 */
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

/**
 * @param {string[]} changed
 * @param {CodeMap} map
 * @param {SpecEntry[]} specs
 * @param {Set<string>} [devServerInputs]
 * @param {{ strict?: boolean }} [options]
 */
export function classify(changed, map, specs, devServerInputs = new Set(), { strict = false } = {}) {
  const selected = new Set();
  /** @type {string[]} */
  const warnings = [];
  let all = false;
  /** @param {string} reason */
  const triggerAll = (reason) => { all = true; warnings.push(reason); };

  /** @param {string} f */
  const isConfig = (f) =>
    /^package\.json$/.test(f) ||
    /^bun\.lock(b)?$/.test(f) ||
    /\.config\.(ts|js|mjs|cjs)$/.test(f) ||
    /^tsconfig.*\.json$/.test(f) ||
    /^svelte\.config\./.test(f);

  /** @param {string} f */
  const isIgnored = (f) =>
    f.startsWith("docs/") ||
    f.startsWith("src-tauri/") ||
    f.startsWith("tests/") ||
    f.startsWith("evidence/") ||
    f.startsWith("screenshots/") ||
    f.startsWith("scripts/") ||
    f.startsWith(".claude/") ||
    f.startsWith("e2e-tauri/") ||
    f.startsWith(".github/") ||
    f.startsWith("packaging/") ||
    f.startsWith("e2e-load/") ||
    f.startsWith("e2e-sweep/") ||
    f.startsWith(".vscode/") ||
    f === "playwright.load.config.ts" ||
    f === "playwright.sweep.config.ts" ||
    f === "PKGBUILD" ||
    /^flake\.(nix|lock)$/.test(f) ||
    /(^|\/)(README|CHANGELOG)\.md$/i.test(f) ||
    f.endsWith(".md");

  for (const f of changed) {
    if (devServerInputs.has(f)) { triggerAll(`dev-server input change: ${f}`); continue; }
    // A change to how CI selects or shards specs must prove itself on the full suite.
    if (SELECTION_INPUTS.has(f)) {
      triggerAll(`CI test-selection change: ${f}`);
      continue;
    }
    // A spec that names this file reads it directly (fixtures outside e2e/).
    const lower = f.toLowerCase();
    for (const s of specs) if (s.content.includes(lower)) selected.add(s.rel);
    if (/^vitest\.[\w.-]*config\.(ts|js|mjs|cjs)$/.test(f)) continue;
    if (/^e2e\/.+\.spec\.ts$/.test(f)) {
      if (existsSync(join(ROOT, f))) selected.add(f);
      continue;
    }
    if (f.startsWith("e2e/")) { triggerAll(`shared e2e support change: ${f}`); continue; }
    if (/^src\/lib\/api\/mock-[\w.-]+\.ts$/.test(f)) { triggerAll(`mock backend change: ${f}`); continue; }
    if (map.hubs.some((h) => fileMatchesToken(f, h))) { triggerAll(`central-hub change: ${f}`); continue; }

    if (f.startsWith("src/")) {
      if (strict) { triggerAll(`frontend source change (strict): ${f}`); continue; }
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

    if (isIgnored(f)) continue;
    if (isConfig(f)) { triggerAll(`build/config change: ${f}`); continue; }
    // Unknown top-level file — do not risk silent under-selection.
    triggerAll(`unrecognized change: ${f}`);
  }

  return { all, selected, warnings };
}

// Files that decide which specs run; changing them must run everything.
const SELECTION_INPUTS = new Set([
  ".github/workflows/ci.yml",
  "scripts/e2e-shards.mjs",
  "scripts/e2e-affected.mjs",
  "scripts/test-selection.mjs",
  "docs/code-map/map-feature.md",
]);

/**
 * Repository scripts the Playwright dev server can execute: those named by
 * vite.config.ts, playwright.config.ts or package.json (e.g. `prepare:pdf`,
 * the release-hook guard), and the scripts they import relatively.
 */
export function devServerScripts(root = ROOT) {
  /** @type {Set<string>} */
  const inputs = new Set();
  /** @param {string} file */
  const read = (file) => { try { return readFileSync(join(root, file), "utf8"); } catch { return ""; } };
  const pending = [];
  for (const file of ["vite.config.ts", "playwright.config.ts", "package.json"]) {
    for (const m of read(file).matchAll(/scripts\/[\w./-]+\.(?:mjs|cjs|js|ts|sh)/g)) pending.push(m[0]);
  }
  while (pending.length > 0) {
    const script = /** @type {string} */ (pending.pop());
    if (inputs.has(script)) continue;
    inputs.add(script);
    for (const m of read(script).matchAll(/(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = posix.normalize(posix.join(posix.dirname(script), m[1]));
      if (target.startsWith("scripts/")) pending.push(target);
    }
  }
  return inputs;
}

// --- main ----------------------------------------------------------------

function main() {
  const { base, head, maxFiles, flags } = parseArgs(process.argv.slice(2));
  const strict = flags.has("--strict");
  // --max-files (CI) also applies the escalations every tier shares (#1175).
  const shared = process.argv.includes("--max-files");
  // head: the merge hook passes the feature branch so the diff is
  // dev...<branch> while checked out on dev.
  /** @param {{ mode: "all" | "selected" | "none", reason: string, items: string[] }} result */
  const emit = (result) => {
    warn(`selection: ${result.mode}: ${result.reason}`);
    if (flags.has("--json")) process.stdout.write(JSON.stringify(result) + "\n");
    else if (result.mode === "all") process.stdout.write("ALL\n");
    else process.stdout.write(result.items.join("\n") + (result.items.length ? "\n" : ""));
  };
  let changed;
  try {
    changed = gitChangedFiles(base, head, ROOT);
  } catch (e) {
    warn(`git diff failed for ${base}...${head}: ${e instanceof Error ? e.message : String(e)}`);
    emit({ mode: "all", reason: "selection failed: git diff", items: [] });
    return;
  }

  if (changed.length === 0) {
    emit({ mode: "none", reason: `no changes for ${base}...${head}`, items: [] });
    return;
  }

  const escalation = shared ? sharedEscalation(changed, maxFiles) : null;
  if (escalation) {
    emit(allOf([escalation]));
    return;
  }

  if (!existsSync(MAP_PATH)) {
    warn(`missing ${MAP_PATH}; cannot map src changes`);
    emit({ mode: "all", reason: "missing docs/code-map/map-feature.md", items: [] });
    return;
  }

  const map = parseMap(readFileSync(MAP_PATH, "utf8"));
  const specs = loadSpecs();
  const { all, selected, warnings } = classify(changed, map, specs, devServerScripts(), { strict });

  for (const w of warnings) warn(w);

  if (all) {
    emit(allOf(warnings));
    return;
  }

  const list = [...selected].sort();
  emit(list.length
    ? { mode: "selected", reason: `${list.length} spec(s) from ${changed.length} changed file(s)`, items: list }
    : { mode: "none", reason: `none of ${changed.length} changed file(s) reaches a browser spec`, items: [] });
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
