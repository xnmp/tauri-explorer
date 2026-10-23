// impact-git.mjs — read what impact-select.mjs needs from git (#1368).
// Everything here shells out; the selection itself stays pure.

import { execFileSync } from "node:child_process";
import { parseHunks, resolveSpecifier } from "./impact-regions.mjs";
import { invertHunks, lineTranslator } from "./impact-select.mjs";

/** @param {string[]} args @param {string} root */
const git = (args, root) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
/** @param {string[]} args @param {string} root */
const gitOrNull = (args, root) => { try { return git(args, root); } catch { return null; } };

/**
 * @param {{ base: string, head: string, files: string[], root: string,
 *   read: import("./version-only.mjs").BlobReader, impact: import("./impact-coverage.mjs").ImpactMap }} input
 * @returns {import("./impact-select.mjs").ChangedFile[]}
 */
export function gatherChanged({ base, head, files, root, read, impact }) {
  const mergeBase = git(["merge-base", base, head], root).trim();
  const mapCommit = /^[0-9a-f]{7,40}$/.test(impact.commit) && gitOrNull(["cat-file", "-e", `${impact.commit}^{commit}`], root) !== null
    ? impact.commit : null;
  return files.map((path) => {
    const baseText = read("base", path);
    const headText = read("head", path);
    const status = baseText === null ? "added" : headText === null ? "deleted" : "modified";
    if (status !== "modified") return { path, status, baseText, headText };
    const hunks = parseHunks(git(["diff", "-U0", "--no-renames", "--no-color", mergeBase, head, "--", path], root));
    const baseBlob = gitOrNull(["rev-parse", `${mergeBase}:${path}`], root)?.trim() ?? null;
    const entry = impact.lines?.[path];
    /** @type {((line: number) => number | null) | null} */
    let toMapLine = null;
    if (entry && baseBlob && entry.blob !== baseBlob && mapCommit &&
        gitOrNull(["rev-parse", `${mapCommit}:${path}`], root)?.trim() === entry.blob) {
      // Lines the map's commit and the merge base share keep their data.
      const between = parseHunks(git(["diff", "-U0", "--no-renames", "--no-color", mapCommit, mergeBase, "--", path], root));
      toMapLine = lineTranslator(invertHunks(between));
    }
    return { path, status, baseText, headText, hunks, baseBlob, toMapLine };
  });
}

/**
 * Repo files that some module at `head` imports as a namespace
 * (`import * as`, `export * from`, a dynamic `import()`), followed through
 * `export *` re-exports: their exports can be reached by name at runtime.
 * @param {string} head
 * @param {string} root
 * @returns {{ targets: Set<string>, exists: (path: string) => boolean }}
 */
export function namespaceTargets(head, root) {
  const tracked = new Set(git(["ls-tree", "-r", "--name-only", head, "--", "src"], root).split("\n").filter(Boolean));
  const exists = (/** @type {string} */ p) => tracked.has(p);
  const hits = (gitOrNull(["grep", "-l", "-E", String.raw`import \* as|export \*|import\(`, head, "--", "src"], root) ?? "")
    .split("\n").filter(Boolean).map((l) => l.slice(head.length + 1));
  /** @type {Set<string>} */
  const targets = new Set();
  /** @type {Map<string, string[]>} */
  const reexports = new Map();
  for (const file of hits) {
    const text = gitOrNull(["show", `${head}:${file}`], root) ?? "";
    for (const m of text.matchAll(/import\s*\*\s*as\s+[\w$]+\s+from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const target = resolveSpecifier(file, m[1] ?? m[2], exists);
      if (target) targets.add(target);
    }
    for (const m of text.matchAll(/export\s*\*\s*(?:as\s+[\w$]+\s+)?from\s*["']([^"']+)["']/g)) {
      const target = resolveSpecifier(file, m[1], exists);
      if (target) reexports.set(file, [...(reexports.get(file) ?? []), target]);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, list] of reexports) {
      if (!targets.has(file)) continue;
      for (const t of list) if (!targets.has(t)) { targets.add(t); grew = true; }
    }
  }
  return { targets, exists };
}

/**
 * Whether any tracked file at `rev` mentions identifier `name` as a word.
 * Errors count as a mention, so a failed lookup never proves a name new.
 * @param {string} rev
 * @param {string} root
 * @returns {(name: string) => boolean}
 */
export function mentionedAt(rev, root) {
  /** @type {Map<string, boolean>} */
  const cache = new Map();
  return (name) => {
    let hit = cache.get(name);
    if (hit === undefined) {
      try {
        execFileSync("git", ["grep", "-q", "-w", "-F", "-e", name, rev], { cwd: root, stdio: "ignore" });
        hit = true;
      } catch (e) {
        // git grep exits 1 for no match; anything else is unknown.
        hit = /** @type {{ status?: number }} */ (e).status !== 1;
      }
      cache.set(name, hit);
    }
    return hit;
  };
}
