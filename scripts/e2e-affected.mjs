#!/usr/bin/env node
// e2e-affected.mjs — select the E2E specs affected by a diff.
//
// Usage:  node scripts/e2e-affected.mjs [--strict | --webkit | --view-modes] [--impact-map=PATH [--impact-level=file|hunk]]
//                                        [--json] [--max-files N] [base] [head]
//         node scripts/e2e-affected.mjs --list-view-mode-specs
//   base defaults to "origin/dev", head to "HEAD".
//   --json: print a test-selection.mjs Selection (mode, reason, items) instead.
//   --max-files N (CI): also apply the escalations every CI tier shares —
//   more than N changed files, an unusual path or an unknown file type -> ALL.
//   Diff is `git diff --name-only --no-renames <base>...<head>`.
//   --strict (CI): any src/ change runs everything. Keyword clusters miss specs
//   that exercise a component incidentally (#1131 review), so they only advise
//   local runs; CI narrows only for changes that never ship in the frontend.
//   This is the Chromium selection.
//   --webkit (CI, #1367): the strict selection when it is narrow; otherwise
//   cluster-mapped specs plus the curated engine-specific set (specs that
//   branch on browserName or carry @webkit), or ALL for a WKWebView-sensitive
//   change (WEBKIT_SENSITIVE paths, component styling) or anything the
//   clusters cannot place. Dev pushes always run full WebKit.
//   --view-modes (CI, #1367): the specs that iterate VIEW_MODES/VIEW_VARIANTS
//   reached through a changed view-mode component or spec, run on Chromium
//   with ALL_VIEW_MODES=1; ALL means every such spec.
//   --list-view-mode-specs: print every spec that iterates the view modes.
//   --impact-map=<path> (CI, #1368): with --strict, --webkit or --view-modes,
//   select src/ changes through the coverage-based test-impact map instead
//   (scripts/impact-select.mjs, built nightly by e2e-impact-map.yml):
//   the tests that entered the function around each changed hunk (the
//   default) or every spec that loaded the file (--impact-level=file). Chromium runs those specs;
//   WebKit adds the curated engine-specific set and runs everything for
//   WEBKIT_SENSITIVE paths, component styling, engine detection or code no
//   Chromium test ran; view modes keep the view-mode specs among them. A new
//   file, a file no spec loaded or an asset no spec fetched selects ALL; a
//   changed e2e support module selects the specs importing it; every
//   escalation below except clusters and hubs still applies. A missing,
//   malformed or stale map selects as without it.
//   A release version bump (scripts/version-only.mjs) selects none.
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
//   2. Changed mock backend core (MOCK_CORE: dispatcher, control surface,
//      shared fixtures)                -> ALL (the test backend).
//      Changed mock command family (other src/lib/api/mock-*.ts) -> ALL
//      without a test-impact map; with one, selected like any src/ file.
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
//      e2e-affected.mjs, test-selection.mjs, version-only.mjs) or the
//      test-result cache wiring (turbo.json, test-cache.mjs, ci-test-e2e.sh) -> ALL.
//      A map-feature.md change selects the union of what the base and head
//      maps select (#1367), so moving a file between clusters cannot drop it.
//   7. Anything else (an unknown top-level file)  -> ALL.
//   If map-feature.md is missing -> ALL (+ warning).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";
import { allOf, gitBlobReader, gitChangedFiles, parseArgs, sharedEscalation, versionOnlyChange } from "./test-selection.mjs";
import { loadImpactMap } from "./impact-coverage.mjs";
import { changedBetween, directBlobReader, gatherChanged, trackedAt } from "./impact-git.mjs";
import { selectFromImpact, withDrift } from "./impact-select.mjs";
import { resolveSpecifier } from "./impact-regions.mjs";
import { discoverSpecs, SPEC_FILE } from "./e2e-shards.mjs";

/**
 * A file Playwright runs as a spec: its default testMatch under testDir
 * `e2e/`, at any depth (e2e-shards.mjs discovers specs the same way).
 * @param {string} file repo-relative path
 */
export const isSpecFile = (file) => file.startsWith("e2e/") && SPEC_FILE.test(file) && !file.split("/").includes("node_modules");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_REL = "docs/code-map/map-feature.md";
const MAP_PATH = join(ROOT, MAP_REL);
const E2E_DIR = join(ROOT, "e2e");

/** @typedef {{ title: string, files: string[], phrases: Set<string> }} Cluster */
/** @typedef {{ hubs: string[], clusters: Cluster[] }} CodeMap */
/** @typedef {{ rel: string, content: string }} SpecEntry */
/** @typedef {"dev-server" | "selection" | "shared-e2e" | "mock" | "mock-family" | "hub" | "strict" | "unmapped" | "no-spec" | "config" | "unknown"} TriggerKind */
/** @typedef {{ kind: TriggerKind, reason: string }} Trigger */
/** @typedef {import("./test-selection.mjs").Selection} Selection */

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
  for (const name of discoverSpecs(E2E_DIR)) {
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

/** @param {string} file */
const isMockBackend = (file) => /^src\/lib\/api\/mock-[\w.-]+\.ts$/.test(file);

/**
 * The mock backend's shared core (#1372): the dispatcher every command goes
 * through, the window control surface specs drive, and the fixture data every
 * family reads. A change here reaches every spec, so it always selects ALL.
 * The per-family command modules (mock-git.ts, mock-files.ts, ...) are not
 * listed: with a test-impact map they select the tests that entered them.
 */
export const MOCK_CORE = new Set([
  "src/lib/api/mock-invoke.ts",
  "src/lib/api/mock-dispatch.ts",
  "src/lib/api/mock-control.ts",
  "src/lib/api/mock-fixtures.ts",
]);

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
  /** @type {Trigger[]} */
  const triggers = [];
  let all = false;
  /** @param {string} reason @param {TriggerKind} kind */
  const triggerAll = (reason, kind) => { all = true; warnings.push(reason); triggers.push({ kind, reason }); };

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
    if (devServerInputs.has(f)) { triggerAll(`dev-server input change: ${f}`, "dev-server"); continue; }
    // A change to how CI selects or shards specs must prove itself on the full suite.
    if (SELECTION_INPUTS.has(f)) {
      triggerAll(`CI test-selection change: ${f}`, "selection");
      continue;
    }
    // A spec that names this file reads it directly (fixtures outside e2e/).
    const lower = f.toLowerCase();
    for (const s of specs) if (s.content.includes(lower)) selected.add(s.rel);
    if (/^vitest\.[\w.-]*config\.(ts|js|mjs|cjs)$/.test(f)) continue;
    if (isSpecFile(f)) {
      if (existsSync(join(ROOT, f))) selected.add(f);
      continue;
    }
    if (f.startsWith("e2e/")) { triggerAll(`shared e2e support change: ${f}`, "shared-e2e"); continue; }
    if (MOCK_CORE.has(f)) { triggerAll(`mock backend core change: ${f}`, "mock"); continue; }
    if (isMockBackend(f)) { triggerAll(`mock command family change: ${f}`, "mock-family"); continue; }
    if (map.hubs.some((h) => fileMatchesToken(f, h))) { triggerAll(`central-hub change: ${f}`, "hub"); continue; }

    if (f.startsWith("src/")) {
      if (strict) { triggerAll(`frontend source change (strict): ${f}`, "strict"); continue; }
      const matched = map.clusters.filter((c) => c.files.some((t) => fileMatchesToken(f, t)));
      if (matched.length === 0) { triggerAll(`unmapped src file (no cluster): ${f}`, "unmapped"); continue; }
      const clusterSpecs = [];
      for (const c of matched) clusterSpecs.push(...specsForCluster(c, specs));
      if (clusterSpecs.length === 0) {
        triggerAll(`cluster(s) [${matched.map((c) => c.title).join(", ")}] matched ${f} but resolved to no spec`, "no-spec");
        continue;
      }
      for (const s of clusterSpecs) selected.add(s);
      continue;
    }

    if (isIgnored(f)) continue;
    if (isConfig(f)) { triggerAll(`build/config change: ${f}`, "config"); continue; }
    // Unknown top-level file — do not risk silent under-selection.
    triggerAll(`unrecognized change: ${f}`, "unknown");
  }

  return { all, selected, warnings, triggers };
}

// Files that decide which specs run; changing them must run everything.
const SELECTION_INPUTS = new Set([
  ".github/workflows/ci.yml",
  "scripts/e2e-shards.mjs",
  "scripts/e2e-affected.mjs",
  "scripts/test-selection.mjs",
  "scripts/version-only.mjs",
  // Coverage-based selection with the test-impact map (#1368).
  "scripts/impact-coverage.mjs",
  "scripts/impact-git.mjs",
  "scripts/impact-regions.mjs",
  "scripts/impact-select.mjs",
  // How the map is recorded: a change here can make later maps under-report.
  "scripts/impact-collect.mjs",
  "scripts/impact-lines.mjs",
  "e2e/impact-coverage.ts",
  ".github/workflows/e2e-impact-map.yml",
  // How the target runs through the test-result cache (#1176).
  "turbo.json",
  "scripts/test-cache.mjs",
  "scripts/ci-test-e2e.sh",
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

// --- per-engine PR selections (#1367) ------------------------------------

/**
 * WKWebView-sensitive frontend areas: a change here runs the full WebKit
 * suite on a PR, because engine-specific layout, zoom and input differences
 * show up in specs that never name the changed file.
 * @type {[RegExp, string][]}
 */
export const WEBKIT_SENSITIVE = [
  [/\.css$/, "stylesheet"],
  [/^src\/lib\/themes\//, "theme"],
  [/zoom|overlay|context-?menu|popover|tooltip/i, "zoom or fixed overlay"],
  [/file-?list|file-?item/i, "FileList/FileItem"],
  [/marquee/i, "marquee"],
  [/preview/i, "preview"],
  [/drag|drop|dnd/i, "drag and drop"],
  [/peek/i, "peek"],
];

/**
 * Components whose rendering differs between Details, List and Tiles; PR
 * specs selected through them also run with ALL_VIEW_MODES=1 on Chromium.
 */
export const VIEW_MODE_COMPONENT = /file-?list|file-?item|tile|list-?(view|card|columns)|details-?view|peek|view-?mode/i;

/**
 * App-wide presentation inputs: stylesheets, themes and the global document
 * markup restyle every view mode without naming one, so a PR touching them
 * runs every view-mode spec.
 * @type {[RegExp, string][]}
 */
export const VIEW_MODE_GLOBAL = [
  [/^(?!website\/).*\.css$/, "stylesheet"],
  [/^src\/lib\/themes\//, "theme"],
  [/^(src\/app\.html|index\.html|src\/routes\/\+layout\.(svelte|ts))$/, "global markup"],
];

/** Specs that branch on the engine or carry an explicit `@webkit` tag. */
const WEBKIT_CURATED = /browsername|@webkit\b/;

/** A spec (or support module) that iterates the configurable view modes. */
const USES_VIEW_MODES = /(?<!all_)view_(modes|variants)\b|process\.env\.all_view_modes/i;

/** @param {string} text */
const styleBlocks = (text) => [...text.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]);

/**
 * Whether a Svelte component's change can alter styling: its `<style>` blocks
 * differ, or an added/removed line mentions `style` or `class`. A missing side
 * (added or deleted file) counts as styling.
 * @param {string | null} before
 * @param {string | null} after
 */
export function svelteStyleChanged(before, after) {
  if (before === null || after === null) return true;
  const a = styleBlocks(before);
  const b = styleBlocks(after);
  if (a.length !== b.length || a.some((block, i) => block !== b[i])) return true;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of after.split("\n")) counts.set(line, (counts.get(line) ?? 0) - 1);
  return [...counts].some(([line, n]) => n !== 0 && /\b(style|class)\b|style:|class:/.test(line));
}

/**
 * Why a changed file needs the full WebKit suite, or null.
 * @param {string} file
 * @param {import("./version-only.mjs").BlobReader} read
 */
export function webkitSensitivity(file, read) {
  if (!file.startsWith("src/")) return null;
  for (const [pattern, label] of WEBKIT_SENSITIVE) if (pattern.test(file)) return label;
  if (file.endsWith(".svelte") && svelteStyleChanged(read("base", file), read("head", file))) return "component styling";
  return null;
}

/**
 * Specs whose tests iterate VIEW_MODES/VIEW_VARIANTS (directly or through an
 * e2e support module that does), so ALL_VIEW_MODES=1 changes what they run.
 * @param {SpecEntry[]} specs
 * @param {SpecEntry[]} support e2e/ modules that are not specs, except helpers.ts
 */
export function viewModeSpecs(specs, support = []) {
  const modules = support
    .filter((m) => m.rel !== "e2e/helpers.ts" && USES_VIEW_MODES.test(m.content))
    .map((m) => m.rel.slice("e2e/".length).replace(/\.ts$/, ""));
  return specs
    .filter((s) => USES_VIEW_MODES.test(s.content) ||
      modules.some((m) => s.content.includes(`"./${m}"`) || s.content.includes(`'./${m}'`) ||
        s.content.includes(`"./${m}.ts"`) || s.content.includes(`'./${m}.ts'`)))
    .map((s) => s.rel)
    .sort();
}

/** Trigger kinds that make a change's reach across the suite unknowable. */
const GLOBAL_KINDS = new Set(["dev-server", "selection", "shared-e2e", "mock", "mock-family", "hub", "config", "unknown"]);

/**
 * @param {string[]} items
 * @param {number} changedCount
 * @param {string} [what]
 * @returns {Selection}
 */
const listed = (items, changedCount, what = "spec(s)") => items.length
  ? { mode: "selected", reason: `${items.length} ${what} from ${changedCount} changed file(s)`, items }
  : { mode: "none", reason: `none of ${changedCount} changed file(s) reaches a browser spec`, items: [] };

/**
 * @typedef {{ changed: string[], map: CodeMap, specs: SpecEntry[], devServerInputs?: Set<string>,
 *   read?: import("./version-only.mjs").BlobReader, support?: SpecEntry[] }} SelectionInput
 */

/**
 * Chromium on PRs: every spec for any frontend source change (strict), so
 * keyword clusters only narrow changes that never ship in the frontend.
 * @param {SelectionInput} input
 * @returns {Selection}
 */
export function selectChromium({ changed, map, specs, devServerInputs = new Set() }) {
  const { all, selected, warnings } = classify(changed, map, specs, devServerInputs, { strict: true });
  return all ? allOf(warnings) : listed([...selected].sort(), changed.length);
}

/**
 * WebKit on PRs: the Chromium selection when that is already narrow;
 * otherwise the cluster-mapped specs plus the curated engine-specific set,
 * escalating to every spec for a WKWebView-sensitive change or anything the
 * clusters cannot place (mock backend, helpers, config, hubs, unmapped files).
 * @param {SelectionInput} input
 * @returns {Selection}
 */
export function selectWebkit({ changed, map, specs, devServerInputs = new Set(), read = () => null }) {
  const strict = classify(changed, map, specs, devServerInputs, { strict: true });
  if (!strict.all) return listed([...strict.selected].sort(), changed.length);
  const loose = classify(changed, map, specs, devServerInputs, { strict: false });
  if (loose.all) return allOf(loose.warnings);
  const sensitive = changed.flatMap((f) => {
    const label = webkitSensitivity(f, read);
    return label ? [`WKWebView-sensitive change (${label}): ${f}`] : [];
  });
  if (sensitive.length > 0) return allOf(sensitive);
  const curated = specs.filter((s) => WEBKIT_CURATED.test(s.content)).map((s) => s.rel);
  const items = [...new Set([...loose.selected, ...curated])].sort();
  return listed(items, changed.length, "cluster-mapped or curated WebKit spec(s)");
}

/**
 * ALL_VIEW_MODES=1 Chromium on PRs: the view-mode specs reached through a
 * changed view-mode component (FileList, FileItem, List, Tiles, peek) or a
 * changed view-mode spec; every view-mode spec ("all") for a global trigger
 * or an app-wide presentation change (VIEW_MODE_GLOBAL).
 * @param {SelectionInput} input
 * @returns {Selection}
 */
export function selectViewModes({ changed, map, specs, devServerInputs = new Set(), support = [] }) {
  const loose = classify(changed, map, specs, devServerInputs, { strict: false });
  const global = loose.triggers.filter((t) => GLOBAL_KINDS.has(t.kind));
  if (global.length > 0) return allOf(global.map((t) => t.reason));
  const presentation = changed.flatMap((f) => {
    const hit = VIEW_MODE_GLOBAL.find(([pattern]) => pattern.test(f));
    return hit ? [`app-wide presentation change (${hit[1]}): ${f}`] : [];
  });
  if (presentation.length > 0) return allOf(presentation);
  const vm = new Set(viewModeSpecs(specs, support));
  const components = changed.filter((f) => f.startsWith("src/") && VIEW_MODE_COMPONENT.test(f));
  const reached = new Set(changed.filter((f) => vm.has(f)));
  if (components.length > 0) {
    const mapped = classify(components, map, specs, devServerInputs, { strict: false });
    if (mapped.all) return allOf(mapped.warnings.map((w) => `view-mode component: ${w}`));
    for (const spec of mapped.selected) reached.add(spec);
  }
  const items = [...reached].filter((spec) => vm.has(spec)).sort();
  return listed(items, changed.length, "view-mode spec(s)");
}

/**
 * Combine selections made with different code maps: any "all" wins, else the
 * union of their specs.
 * @param {Selection[]} selections
 * @param {number} changedCount
 * @returns {Selection}
 */
export function unionSelections(selections, changedCount) {
  if (selections.length === 1) return selections[0];
  const all = selections.find((s) => s.mode === "all");
  if (all) return all;
  const items = [...new Set(selections.flatMap((s) => s.items))].sort();
  if (items.length === 0) return selections[0];
  return { mode: "selected", reason: `${items.length} spec(s) from ${changedCount} changed file(s), with the base and head code maps`, items };
}

// --- coverage-based selection (#1368) ------------------------------------

/**
 * Trigger kinds the test-impact map replaces: keyword clusters and hubs
 * (coverage places every src/ file), mock command families (coverage records
 * which tests entered each handler) and e2e support modules (the static
 * import graph places them).
 */
const IMPACT_REPLACES = new Set(["strict", "hub", "unmapped", "no-spec", "shared-e2e", "mock-family"]);

/**
 * src/ files the test-impact map decides: every src/ change except the mock
 * backend core, which escalates to ALL on its own.
 * @param {string[]} changed
 */
export const impactCandidates = (changed) => changed.filter((f) => f.startsWith("src/") && !MOCK_CORE.has(f));

/**
 * Specs that import a changed e2e support module, directly or through other
 * support modules (relative `./x` imports). Null when a changed e2e/ file is
 * not a TypeScript module the graph can follow.
 * @param {string[]} changedSupport e2e/ files that are not specs
 * @param {SpecEntry[]} specs
 * @param {SpecEntry[]} support
 * @returns {string[] | null}
 */
export function e2eImporters(changedSupport, specs, support) {
  if (changedSupport.some((f) => !/^e2e\/[\w.-]+\.ts$/.test(f))) return null;
  /** @param {string} content */
  const imports = (content) => new Set([...content.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']\.\/([\w.-]+?)(?:\.ts)?["']/g)]
    .map((m) => `e2e/${m[1]}.ts`));
  const supportImports = new Map(support.map((m) => [m.rel, imports(m.content)]));
  /** @type {Set<string>} */
  const reached = new Set(changedSupport);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [rel, deps] of supportImports) {
      if (!reached.has(rel) && [...deps].some((d) => reached.has(d))) { reached.add(rel); grew = true; }
    }
  }
  return specs.filter((s) => [...imports(s.content)].some((d) => reached.has(d))).map((s) => s.rel);
}

/**
 * Specs whose own code changed in `drift` (files changed since the map's
 * commit): the spec itself, an e2e support module it imports, or any module
 * it evaluates in Node (fixtures under tests/, src/ constants). The map's
 * record of them is out of date, so they run whatever the PR changes. A
 * support file outside the import graph means every spec.
 * @param {string[]} drift
 * @param {Map<string, Set<string>>} nodeImports module -> specs (nodeSideImports)
 * @param {SpecEntry[]} specs
 * @param {SpecEntry[]} support
 * @returns {string[]}
 */
export function specsChangedSince(drift, nodeImports, specs, support) {
  const driftSupport = drift.filter((f) => f.startsWith("e2e/") && !isSpecFile(f));
  const supportImporters = e2eImporters(driftSupport, specs, support) ?? specs.map((s) => s.rel);
  const nodeImporters = drift.flatMap((f) => [...(nodeImports.get(f) ?? [])]);
  return [...new Set([...drift.filter(isSpecFile), ...supportImporters, ...nodeImporters])].sort();
}

/**
 * Repository modules each spec evaluates in the Node test process (not the
 * browser): imports from the spec and its e2e support modules, followed
 * transitively through relative imports. Browser coverage cannot see these,
 * so a changed module here selects the specs that load it.
 * @param {string[]} specFiles e2e/*.spec.ts paths
 * @param {(path: string) => string | null} read raw file text
 * @param {(path: string) => boolean} exists
 * @returns {Map<string, Set<string>>} module -> specs
 */
export function nodeSideImports(specFiles, read, exists) {
  /** @type {Map<string, string[]>} */
  const deps = new Map();
  const depsOf = (/** @type {string} */ file) => {
    let list = deps.get(file);
    if (list) return list;
    const text = read(file) ?? "";
    // Every module-specifier position, anywhere in the text: multi-line and
    // same-line imports included. Type-only imports and comments may
    // over-select; nothing a spec evaluates is missed.
    list = [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"'\n]+)["']|\brequire\(\s*["']([^"'\n]+)["']/g)]
      .map((m) => m[1] ?? m[2])
      .filter((spec) => spec.startsWith("."))
      .map((spec) => resolveSpecifier(file, spec, exists))
      .filter((p) => p !== null);
    deps.set(file, /** @type {string[]} */ (list));
    return /** @type {string[]} */ (list);
  };
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  for (const spec of specFiles) {
    const seen = new Set([spec]);
    const queue = [spec];
    while (queue.length > 0) {
      for (const dep of depsOf(/** @type {string} */ (queue.pop()))) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        queue.push(dep);
        let set = out.get(dep);
        if (!set) out.set(dep, (set = new Set()));
        set.add(spec);
      }
    }
  }
  return out;
}

/**
 * @typedef {import("./impact-select.mjs").ImpactSelection} ImpactSelection
 * @typedef {SelectionInput & { impact: import("./impact-coverage.mjs").ImpactMap,
 *   impactSelection: ImpactSelection, nodeImports?: Map<string, Set<string>> }} CoverageInput
 *   impactSelection: selectFromImpact over the changed src/ files (minus the
 *   mock backend, which escalates on its own).
 *   nodeImports: nodeSideImports for the specs (module -> specs).
 */

/**
 * Chromium on PRs with a test-impact map (#1368). Every shared escalation of
 * the strict selector still selects ALL (mock backend, config and lockfiles,
 * dev-server scripts, selection inputs, unknown files); a changed spec
 * selects itself; a changed e2e support module selects the specs importing
 * it; a changed src/ file selects what the map says reaches it
 * (impact-select.mjs). Specs the map has no coverage for are added to any
 * selection a src/ change makes.
 * @param {CoverageInput} input
 * @returns {Selection}
 */
export function selectCoverage({ changed, map, specs, devServerInputs = new Set(), support = [], impact, impactSelection, nodeImports = new Map() }) {
  const strict = classify(changed, map, specs, devServerInputs, { strict: true });
  const blocking = strict.triggers.filter((t) => !IMPACT_REPLACES.has(t.kind));
  if (blocking.length > 0) return allOf(blocking.map((t) => t.reason));
  const changedSupport = changed.filter((f) => f.startsWith("e2e/") && !isSpecFile(f));
  const importers = e2eImporters(changedSupport, specs, support);
  if (importers === null) return allOf(changedSupport.map((f) => `e2e support file outside the import graph: ${f}`));
  if (impactSelection.all.length > 0) return allOf(impactSelection.all);
  const present = new Set(specs.map((s) => s.rel));
  const selected = new Set([...strict.selected, ...importers, ...impactSelection.specs]);
  for (const file of changed) for (const s of nodeImports.get(file) ?? []) selected.add(s);
  if (changed.some((f) => f.startsWith("src/"))) {
    const mapped = new Set(impact.specs);
    for (const s of present) if (!mapped.has(s)) selected.add(s);
  }
  const items = [...selected].filter((s) => present.has(s)).sort();
  return listed(items, changed.length, "coverage-mapped spec(s)");
}

/**
 * Engine detection in app code: Chromium coverage records only the branch
 * Chromium takes.
 */
export const ENGINE_DETECTION = /navigator\.(userAgent|vendor)|CSS\.supports\(|\bis(WebKit|Webkit|Safari|Chromium)(Engine)?\b/;

/**
 * WebKit on PRs with a test-impact map: the coverage selection plus the
 * curated engine-specific specs, united with the selection without a map
 * (selectWebkit): Chromium coverage cannot see a WebKit-only caller in an
 * unchanged file reaching the changed code. Every spec for a
 * WKWebView-sensitive change, component styling, a file that detects the
 * engine, or a change no Chromium test executed.
 * @param {CoverageInput} input
 * @returns {Selection}
 */
export function selectWebkitCoverage(input) {
  const { changed, specs, read = () => null, impactSelection } = input;
  const coverage = selectCoverage(input);
  if (coverage.mode === "all") return coverage;
  const sensitive = changed.flatMap((f) => {
    const label = webkitSensitivity(f, read) ??
      (f.startsWith("src/") && [read("base", f), read("head", f)].some((t) => t !== null && ENGINE_DETECTION.test(t)) ? "engine detection" : null);
    return label ? [`WKWebView-sensitive change (${label}): ${f}`] : [];
  });
  if (sensitive.length > 0) return allOf(sensitive);
  if (impactSelection.zeroCoverage.length > 0) {
    return allOf(impactSelection.zeroCoverage.map((h) => `change no Chromium test executed (may be WebKit-only): ${h}`));
  }
  const without = selectWebkit(input);
  if (without.mode === "all") return without;
  if (coverage.mode === "none" && without.mode === "none") return coverage;
  const curated = coverage.mode === "none" ? [] : specs.filter((s) => WEBKIT_CURATED.test(s.content)).map((s) => s.rel);
  const items = [...new Set([...coverage.items, ...curated, ...without.items])].sort();
  return listed(items, changed.length, "coverage-mapped, curated or cluster-mapped WebKit spec(s)");
}

/**
 * ALL_VIEW_MODES=1 on PRs with a test-impact map: the view-mode specs among
 * the coverage selection (the map is recorded with ALL_VIEW_MODES=1, so it
 * sees List and Tiles code); every view-mode spec for a global trigger or an
 * app-wide presentation change. When coverage cannot place the change, the
 * component-based selection (selectViewModes) decides, as without a map.
 * @param {CoverageInput} input
 * @returns {Selection}
 */
export function selectViewModesCoverage(input) {
  const { changed, map, specs, devServerInputs = new Set(), support = [] } = input;
  const loose = classify(changed, map, specs, devServerInputs, { strict: false });
  const global = loose.triggers.filter((t) => GLOBAL_KINDS.has(t.kind) && !IMPACT_REPLACES.has(t.kind));
  if (global.length > 0) return allOf(global.map((t) => t.reason));
  const presentation = changed.flatMap((f) => {
    const hit = VIEW_MODE_GLOBAL.find(([pattern]) => pattern.test(f));
    return hit ? [`app-wide presentation change (${hit[1]}): ${f}`] : [];
  });
  if (presentation.length > 0) return allOf(presentation);
  const coverage = selectCoverage(input);
  if (coverage.mode === "all") return selectViewModes(input);
  const vm = new Set(viewModeSpecs(specs, support));
  return listed(coverage.items.filter((s) => vm.has(s)), changed.length, "coverage-mapped view-mode spec(s)");
}

/** Non-spec TypeScript modules under e2e/ (helpers, fixtures, page objects). */
export function loadSupport() {
  return readdirSync(E2E_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && !SPEC_FILE.test(entry.name))
    .map((entry) => posix.join("e2e", posix.relative(E2E_DIR.split("\\").join("/"), join(entry.parentPath, entry.name).split("\\").join("/"))))
    .filter((rel) => !rel.split("/").includes("node_modules"))
    .sort()
    .map((rel) => ({ rel, content: readFileSync(join(ROOT, rel), "utf8").toLowerCase() }));
}

// --- main ----------------------------------------------------------------

async function main() {
  const { base, head, maxFiles, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("--list-view-mode-specs")) {
    process.stdout.write(viewModeSpecs(loadSpecs(), loadSupport()).join("\n") + "\n");
    return;
  }
  const strict = flags.has("--strict");
  const engine = flags.has("--webkit") ? "webkit" : flags.has("--view-modes") ? "view-modes" : strict ? "chromium" : "local";
  // --max-files (CI) also applies the escalations every tier shares (#1175).
  const shared = process.argv.includes("--max-files");
  // head: the merge hook passes the feature branch so the diff is
  // dev...<branch> while checked out on dev.
  /** @param {Selection} result */
  const emit = (result) => {
    warn(`selection (${engine}): ${result.mode}: ${result.reason}`);
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

  const read = gitBlobReader(base, head, ROOT);
  // A release version bump runs no browser spec: the suite's mock backend
  // reports its own version, and the bumped files are not browser inputs.
  if (versionOnlyChange(changed, read)) {
    emit({ mode: "none", reason: `version-only change of ${changed.length} file(s)`, items: [] });
    return;
  }

  if (!existsSync(MAP_PATH)) {
    warn(`missing ${MAP_PATH}; cannot map src changes`);
    emit({ mode: "all", reason: "missing docs/code-map/map-feature.md", items: [] });
    return;
  }

  const maps = [readFileSync(MAP_PATH, "utf8")];
  if (changed.includes(MAP_REL)) {
    const before = read("base", MAP_REL);
    if (before === null) {
      emit({ mode: "all", reason: `${MAP_REL} was added`, items: [] });
      return;
    }
    maps.push(before);
  }
  const specs = loadSpecs();
  const common = { changed, specs, devServerInputs: devServerScripts(), read, support: loadSupport() };
  const coverage = await impactInputs(flags, { base, head, changed, read });
  /** @type {(input: SelectionInput) => Selection} */
  const select = coverage && engine !== "local"
    ? (input) => (engine === "webkit" ? selectWebkitCoverage : engine === "view-modes" ? selectViewModesCoverage : selectCoverage)({ ...input, ...coverage })
    : engine === "webkit" ? selectWebkit
    : engine === "view-modes" ? selectViewModes
    : engine === "chromium" ? selectChromium
    : (input) => {
      const { all, selected, warnings } = classify(changed, input.map, specs, common.devServerInputs, { strict: false });
      for (const w of warnings) warn(w);
      return all ? allOf(warnings) : listed([...selected].sort(), changed.length);
    };
  emit(unionSelections(maps.map((text) => select({ ...common, map: parseMap(text) })), changed.length));
}

/**
 * The test-impact map inputs for selection, or null to select without it.
 * `--impact-map=<path>` names the map (CI downloads the latest nightly one);
 * `--impact-level=file|hunk` picks the layer (default hunk). A missing,
 * unreadable, malformed or stale map falls back to the selection without a
 * map, with a warning.
 * @param {Set<string>} flags
 * @param {{ base: string, head: string, changed: string[], read: import("./version-only.mjs").BlobReader }} diff
 */
async function impactInputs(flags, { base, head, changed, read }) {
  const path = [...flags].find((f) => f.startsWith("--impact-map="))?.slice("--impact-map=".length);
  if (!path) return null;
  const levelFlag = [...flags].find((f) => f.startsWith("--impact-level="))?.slice("--impact-level=".length) ?? "hunk";
  const level = levelFlag === "file" ? "file" : "hunk";
  let text = null;
  try { text = readFileSync(path, "utf8"); } catch { /* reported below */ }
  const loaded = loadImpactMap(text);
  if ("error" in loaded) {
    warn(`impact map unusable (${loaded.error}); selecting without it`);
    return null;
  }
  const impact = loaded.map;
  /** @type {any} */
  let ts = null;
  try { ts = (await import("typescript")).default; } catch { warn("typescript unavailable; using the file level"); }
  const files = impactCandidates(changed);
  const exists = trackedAt(head, ROOT);
  /** @param {string} p */
  const readFile = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return null; } };
  const nodeImports = nodeSideImports(loadSpecs().map((s) => s.rel), readFile, (p) => existsSync(join(ROOT, p)));
  const prSelection = selectFromImpact({
    impact, level, ts, exists,
    changed: gatherChanged({ base, head, files, root: ROOT, read, impact }),
  });
  // Code that changed on dev after the map was recorded can route tests into
  // the PR's change without the map knowing (#1368 review): select those
  // tests too. Without the map's commit the drift is unknown: no map.
  const mergeBase = execFileSync("git", ["merge-base", base, head], { cwd: ROOT, encoding: "utf8" }).trim();
  const drift = changedBetween(impact.commit, mergeBase, ROOT);
  if (drift === null) {
    warn(`impact map commit ${impact.commit.slice(0, 12)} is unavailable; selecting without the map`);
    return null;
  }
  let impactSelection = prSelection;
  if (changed.some((f) => f.startsWith("src/"))) {
    const driftSrc = drift.filter((f) => f.startsWith("src/"));
    const driftSelection = selectFromImpact({
      impact, level, ts, exists: trackedAt(mergeBase, ROOT),
      // The map's commit itself against the merge base: the map can be newer
      // than a PR's base as well as older.
      changed: gatherChanged({ base: impact.commit, head: mergeBase, files: driftSrc, root: ROOT,
        read: directBlobReader(impact.commit, mergeBase, ROOT), impact, direct: true }),
    });
    const driftSpecs = specsChangedSince(drift, nodeImports, loadSpecs(), loadSupport());
    impactSelection = withDrift(prSelection, driftSelection, driftSpecs);
    if (drift.length > 0) {
      warn(`impact map drift: ${drift.length} file(s) changed since the map's commit, ` +
        `${driftSelection.tests.size} test(s) and ${driftSpecs.length} spec(s) re-run for it`);
    }
  }
  warn(`impact map ${impact.commit.slice(0, 12)} (${impact.generatedAt}), ${level} level: ` +
    `${impactSelection.hunkLevel.length} file(s) by function, ${impactSelection.fileLevel.length} by file, ` +
    `${impactSelection.tests.size}/${impact.tests.length} test(s)` +
    (impactSelection.zeroCoverage.length ? `, unexecuted: ${impactSelection.zeroCoverage.join(", ")}` : ""));
  return { impact, impactSelection, nodeImports };
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    warn(`selection failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    const result = { mode: "all", reason: "selection failed", items: [] };
    process.stdout.write(process.argv.includes("--json") ? JSON.stringify(result) + "\n" : "ALL\n");
  });
}
