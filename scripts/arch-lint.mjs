#!/usr/bin/env node
/**
 * arch-lint — greppable architectural layering linter (#304). No dependencies.
 *
 * Usage:
 *   node scripts/arch-lint.mjs [--warn|--strict] [file ...]
 *
 *   No file args      lint the whole repo (src/lib + src-tauri/src).
 *   file args         lint just those files (hook single-file mode).
 *   --warn (default)  print warnings, ALWAYS exit 0 — for the PostToolUse hook.
 *   --strict          exit 1 if any warning fired — for CI / `bun run lint:arch`.
 *
 * Rules (see GitHub issue #304):
 *   domain-imports-layer        src/lib/domain must not import $lib/state or $lib/api
 *   component-direct-invoke     components must not import `invoke` (use api/ wrappers)
 *   component-raw-localstorage  components must not touch localStorage directly
 *   state-imports-component     src/lib/state must not import .svelte components
 *   plugin-core-orchestration   plugins must not import windowTabsManager / dialogStore /
 *                               performFileTransfer modules (route through PluginContext)
 *   plugin-state-import         plugin feature dirs must not import $lib/state/* unless
 *                               allowlisted below with a documented justification
 *   api-files-export-star       src/lib/api/files.ts must not use `export *`
 *   rust-command-error-type     #[tauri::command] fns should return Result<_, AppError>,
 *                               not Result<_, String> or bare bool (probes excepted)
 *
 * Precision beats recall here: this is a warner people must not learn to
 * ignore, so every check is scoped tightly and unresolvable imports are skipped.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Documented exceptions ────────────────────────────────────────────────────
// plugin-state-import allowlist: file → $lib/state modules it may import.
// Every entry must cite a justification (in-code comment or issue):
// - theme-from-image/index.ts (#291): purpose-built theme-engine extension —
//   justification comment sits directly above the imports in that file.
// - ai-rename/index.ts (#291): fills the single-slot rename-suggestion
//   extension point — justification comment sits above the import.
// - ai-organize/index.ts (#304): read-only bookmarksStore.list as organize
//   targets; single-subsystem read per the PluginContext docstring convention.
// - nano-banana/index.ts (#304): one-time legacy geminiApiKey migration must
//   rewrite the core settings.json; ctx.storage is plugin-scoped, so it can't.
const PLUGIN_STATE_ALLOW = new Map([
  ["src/lib/plugins/theme-from-image/index.ts", ["src/lib/state/theme.svelte", "src/lib/state/settings.svelte"]],
  ["src/lib/plugins/ai-rename/index.ts", ["src/lib/state/rename-suggestion.svelte"]],
  ["src/lib/plugins/ai-organize/index.ts", ["src/lib/state/bookmarks.svelte"]],
  ["src/lib/plugins/nano-banana/index.ts", ["src/lib/state/persisted"]],
]);

// state-imports-component allowlist: file → .svelte modules it may import.
// - git-warm.ts (#287, allowlisted in #304): infrastructure wiring that imports
//   only the `warmGraphSnapshot` module-context export (a cache warmer), never
//   the component instance. Proper fix is moving the graph snapshot cache out
//   of GitGraphView.svelte into state/ — out of scope for the linter issue.
const STATE_COMPONENT_ALLOW = new Map([
  ["src/lib/state/git-warm.ts", ["src/lib/components/GitGraphView.svelte"]],
]);

// rust-command-error-type bool allowlist (#304): warm_pool_begin_spawn returns
// a CAS "slot reserved?" flag — success/failure is data, not an error, so
// Result<_, AppError> would be the wrong shape.
const RUST_BOOL_ALLOW = new Set(["warm_pool_begin_spawn"]);

// Modules that export the core-orchestration symbols windowTabsManager,
// dialogStore and performFileTransfer (rule plugin-core-orchestration).
const CORE_ORCHESTRATION_MODULES = [
  "src/lib/state/window-tabs.svelte",
  "src/lib/state/dialogs.svelte",
  "src/lib/state/file-transfer",
];

// ── Small helpers (pure) ─────────────────────────────────────────────────────

const toPosix = (p) => p.split(path.sep).join("/");
const relToRepo = (p) => toPosix(path.relative(REPO_ROOT, path.resolve(p)));
const inDir = (rel, dir) => rel === dir || rel.startsWith(dir + "/");

/** Resolve an import specifier to a repo-relative posix path, or null. */
function resolveSpec(fileRel, spec) {
  if (spec.startsWith("$lib/")) return "src/lib/" + spec.slice(5);
  if (spec.startsWith(".")) {
    return toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), spec)));
  }
  return null; // bare module (npm package, node builtin, @tauri-apps/…)
}

/** Same module? Tolerates the omitted .ts/.js extension. */
const sameModule = (resolved, target) =>
  resolved === target || resolved === target + ".ts" || resolved === target + ".js";

const isCommentLine = (line) => {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

/**
 * Extract import/re-export statements line-by-line.
 * Returns [{ line, spec, clause }] where `clause` is the full statement text
 * (joined across lines for multiline imports) and `spec` the module string.
 * Also yields dynamic import("...") specifiers.
 */
function parseImports(source) {
  const out = [];
  const lines = source.split("\n");
  let pending = null; // { line, clause } for a multiline import/export …{ … } from "x"

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;

    for (const m of line.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      out.push({ line: i + 1, spec: m[1], clause: line.trim() });
    }

    if (pending) {
      pending.clause += " " + line.trim();
      const m = line.match(/\bfrom\s*["']([^"']+)["']/);
      if (m) {
        out.push({ line: pending.line, spec: m[1], clause: pending.clause });
        pending = null;
      } else if (/;\s*$/.test(line) || i - pending.start > 40) {
        pending = null; // statement ended without a from-clause (e.g. export {…};)
      }
      continue;
    }

    const single = line.match(/^\s*(?:import|export)\b[^"'`]*?\bfrom\s*["']([^"']+)["']/);
    if (single) {
      out.push({ line: i + 1, spec: single[1], clause: line.trim() });
      continue;
    }
    const bare = line.match(/^\s*import\s*["']([^"']+)["']/);
    if (bare) {
      out.push({ line: i + 1, spec: bare[1], clause: line.trim() });
      continue;
    }
    // Opens a multiline import/export statement (no string literal on this line).
    if (/^\s*(?:import|export)\b/.test(line) && !/["']/.test(line) && !/;\s*$/.test(line)) {
      pending = { line: i + 1, start: i, clause: line.trim() };
    }
  }
  return out;
}

// ── Frontend rules ───────────────────────────────────────────────────────────

function lintFrontendFile(fileRel, source) {
  const warnings = [];
  const warn = (line, rule, msg) => warnings.push({ file: fileRel, line, rule, msg });
  const imports = parseImports(source);

  if (inDir(fileRel, "src/lib/domain")) {
    for (const imp of imports) {
      const r = resolveSpec(fileRel, imp.spec);
      if (!r) continue;
      for (const layer of ["src/lib/state", "src/lib/api"]) {
        if (inDir(r, layer)) {
          warn(imp.line, "domain-imports-layer",
            `domain/ must stay pure — imports ${imp.spec} (${layer}/); move the logic or pass data in`);
        }
      }
    }
  }

  if (inDir(fileRel, "src/lib/components")) {
    for (const imp of imports) {
      if (imp.spec === "@tauri-apps/api/core" && /\binvoke\b/.test(imp.clause)) {
        warn(imp.line, "component-direct-invoke",
          "components must not call invoke() directly — add/use a wrapper in src/lib/api/");
      }
    }
    source.split("\n").forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (/__TAURI_INTERNALS__\s*\.\s*invoke\b/.test(line)) {
        warn(i + 1, "component-direct-invoke",
          "components must not call invoke() directly — add/use a wrapper in src/lib/api/");
      }
      if (/\blocalStorage\b/.test(line)) {
        warn(i + 1, "component-raw-localstorage",
          "components must not touch localStorage — use state/persisted or usePersistedPanelWidth");
      }
    });
  }

  if (inDir(fileRel, "src/lib/state")) {
    const allowed = STATE_COMPONENT_ALLOW.get(fileRel) ?? [];
    for (const imp of imports) {
      const r = resolveSpec(fileRel, imp.spec);
      if (!r || allowed.some((m) => sameModule(r, m))) continue;
      if (inDir(r, "src/lib/components")) {
        warn(imp.line, "state-imports-component",
          `state/ must not import components — imports ${imp.spec}; invert via a callback or event`);
        continue;
      }
      if (r.endsWith(".svelte")) {
        const abs = path.join(REPO_ROOT, r);
        // `foo.svelte` resolving to `foo.svelte.ts` is a runes module — fine.
        if (existsSync(abs + ".ts") || existsSync(abs + ".js")) continue;
        if (existsSync(abs)) {
          warn(imp.line, "state-imports-component",
            `state/ must not import .svelte components — imports ${imp.spec}`);
        }
      }
    }
  }

  if (inDir(fileRel, "src/lib/plugins") && fileRel !== "src/lib/plugins/api.ts") {
    const inFeatureDir = /^src\/lib\/plugins\/[^/]+\//.test(fileRel);
    const allowed = PLUGIN_STATE_ALLOW.get(fileRel) ?? [];
    for (const imp of imports) {
      const r = resolveSpec(fileRel, imp.spec);
      if (!r) continue;
      if (CORE_ORCHESTRATION_MODULES.some((m) => sameModule(r, m))) {
        warn(imp.line, "plugin-core-orchestration",
          `plugins must not import ${imp.spec} (windowTabsManager/dialogStore/performFileTransfer) — route through PluginContext`);
        continue;
      }
      if (inFeatureDir && inDir(r, "src/lib/state") && !allowed.some((m) => sameModule(r, m))) {
        warn(imp.line, "plugin-state-import",
          `plugins access core state via PluginContext — imports ${imp.spec}; if a documented single-subsystem exception applies, allowlist it in scripts/arch-lint.mjs`);
      }
    }
  }

  if (fileRel === "src/lib/api/files.ts") {
    source.split("\n").forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (/^\s*export\s*\*/.test(line)) {
        warn(i + 1, "api-files-export-star",
          "no `export *` re-exports from api/files.ts — re-export named symbols explicitly");
      }
    });
  }

  return warnings;
}

// ── Rust rule ────────────────────────────────────────────────────────────────

/** Error type of `Result<T, E>` within a return type, or null (depth-aware). */
function resultErrorType(retType) {
  const m = /\bResult\s*</.exec(retType);
  if (!m) return null;
  let depth = 1;
  let comma = -1;
  const start = m.index + m[0].length;
  for (let i = start; i < retType.length; i++) {
    const c = retType[i];
    if (c === "<") depth++;
    else if (c === ">") {
      depth--;
      if (depth === 0) return comma === -1 ? null : retType.slice(comma + 1, i).trim();
    } else if (c === "," && depth === 1) comma = i;
  }
  return null;
}

const isProbeName = (name) => /(^|_)(is|has|can|should)_/.test(name);

function lintRustFile(fileRel, source) {
  const warnings = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[tauri::command/.test(lines[i])) continue;

    // Skip trailing attributes / doc comments, then collect the fn signature
    // up to the body brace (or `;`).
    let j = i + 1;
    while (j < lines.length && /^\s*(#\[|\/\/)/.test(lines[j])) j++;
    let sig = "";
    let sigEnd = j;
    for (; sigEnd < lines.length && sigEnd < j + 30; sigEnd++) {
      sig += " " + lines[sigEnd];
      if (/[{;]/.test(lines[sigEnd])) break;
    }
    const fnMatch = /\bfn\s+(\w+)/.exec(sig);
    if (!fnMatch) continue;
    const name = fnMatch[1];
    const arrow = /->\s*([^{;]+)/.exec(sig);
    if (!arrow) continue; // returns ()
    const retType = arrow[1].trim();

    if (resultErrorType(retType) === "String") {
      warnings.push({
        file: fileRel, line: j + 1, rule: "rust-command-error-type",
        msg: `command ${name} returns Result<_, String> — return Result<_, AppError> (see src-tauri/src/error.rs)`,
      });
    } else if (retType === "bool" && !isProbeName(name) && !RUST_BOOL_ALLOW.has(name)) {
      warnings.push({
        file: fileRel, line: j + 1, rule: "rust-command-error-type",
        msg: `command ${name} returns bare bool — return Result<_, AppError> (or allowlist a genuine flag in scripts/arch-lint.mjs)`,
      });
    }
  }
  return warnings;
}

// ── Driver ───────────────────────────────────────────────────────────────────

function lintFile(absPath) {
  const fileRel = relToRepo(absPath);
  let source;
  try {
    source = readFileSync(absPath, "utf8");
  } catch {
    return []; // deleted/unreadable — nothing to lint
  }
  if (inDir(fileRel, "src-tauri/src") && fileRel.endsWith(".rs")) {
    return lintRustFile(fileRel, source);
  }
  if (inDir(fileRel, "src/lib") && /\.(ts|js|svelte)$/.test(fileRel)) {
    return lintFrontendFile(fileRel, source);
  }
  return [];
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

function main(argv) {
  const strict = argv.includes("--strict");
  const files = argv.filter((a) => a !== "--strict" && a !== "--warn");

  const targets = files.length
    ? files.map((f) => path.resolve(f))
    : ["src/lib", "src-tauri/src"]
        .map((d) => path.join(REPO_ROOT, d))
        .filter(existsSync)
        .flatMap((d) => [...walk(d)]);

  const warnings = targets.flatMap(lintFile);
  for (const w of warnings) {
    console.log(`${w.file}:${w.line}  ${w.rule}  ${w.msg}`);
  }
  if (files.length === 0) {
    console.error(warnings.length ? `arch-lint: ${warnings.length} warning(s)` : "arch-lint: clean");
  }
  process.exit(strict && warnings.length > 0 ? 1 : 0);
}

main(process.argv.slice(2));
