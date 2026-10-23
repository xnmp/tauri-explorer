// impact-collect.mjs — reduce one test's raw browser coverage to the record
// the test-impact map merges (#1368). Used by e2e/impact-coverage.ts.
//
// Record (one JSON file per test attempt):
//   { v, id, spec, title, location, retry, status, failures,
//     loaded:    [repo files whose module evaluated],
//     exercised: [repo files with a non-top-level function that ran],
//     lines:     { file: [[start, end], ...] }   covered original lines,
//     requests:  [repo files the pages fetched (static assets, fixtures)] }
// Per file version, a meta record (written once, keyed by path + git blob):
//   { path, blob, aligned, mapped: [[s, e]...], blocks: [[s, e]...] }
// `aligned` is false when the served module's source map embeds text that
// differs from the checkout's file, so its lines cannot be trusted.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoPathFromUrl, scriptExercised, toRuns } from "./impact-coverage.mjs";
import { scriptLines } from "./impact-lines.mjs";

export const RECORD_VERSION = 1;

/** Git's blob id for file content. @param {Buffer | string} content */
export function gitBlobId(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/**
 * Repo file a same-origin request fetched: a /src module or asset, or a file
 * under static/ (SvelteKit serves it at the site root). Null otherwise.
 * @param {string} url
 * @param {string} origin
 * @param {string} root
 */
export function requestedRepoFile(url, origin, root) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.origin !== origin) return null;
  const src = repoPathFromUrl(url);
  // Modules are recorded through coverage; requests add the other files.
  if (src) return /\.(svelte|ts|js|mjs)$/.test(src) ? null : src;
  let path;
  try { path = decodeURIComponent(parsed.pathname); } catch { return null; }
  if (path === "/" || path.startsWith("/@") || path.startsWith("/node_modules/") || path.includes("..")) return null;
  const candidate = `static${path}`;
  return existsSync(join(root, candidate)) ? candidate : null;
}

/**
 * @typedef {import("./impact-coverage.mjs").ScriptCoverage & { source?: string }} RawScript
 * @typedef {{ path: string, blob: string | null, aligned: boolean,
 *   mapped: Array<[number, number]>, blocks: Array<[number, number]> }} FileMeta
 */

/**
 * @param {RawScript[]} scripts every script of every page the test opened
 * @param {{ root: string, readFile?: (path: string) => Buffer | null, seen?: Map<string, FileMeta> }} options
 *   `seen` caches per-worker static data by served source, so each module
 *   version is source-mapped once.
 * @returns {{ loaded: string[], exercised: string[], lines: Record<string, Array<[number, number]>>, metas: FileMeta[] }}
 */
export function reduceCoverage(scripts, { root, readFile, seen = new Map() }) {
  const read = readFile ?? ((/** @type {string} */ p) => { try { return readFileSync(join(root, p)); } catch { return null; } });
  /** @type {Set<string>} */
  const loaded = new Set();
  /** @type {Set<string>} */
  const exercised = new Set();
  /** @type {Map<string, Set<number>>} */
  const covered = new Map();
  /** @type {FileMeta[]} */
  const metas = [];
  for (const script of scripts) {
    const path = repoPathFromUrl(script.url);
    if (!path) continue;
    const top = script.functions?.find((fn) => fn.ranges?.[0]?.startOffset === 0);
    const ran = scriptExercised(script);
    if (top && (top.ranges[0].count ?? 0) === 0 && !ran) continue;
    loaded.add(path);
    if (ran) exercised.add(path);
    // Style modules (`?svelte&type=style`) and asset URL modules have no
    // source map: they count as loaded, without line data.
    if (typeof script.source !== "string" || script.url.includes("type=style")) continue;
    const lines = scriptLines(/** @type {any} */ (script));
    if (!lines) continue;
    // The URL carries Vite's version query, so it changes when the module does.
    const key = `${script.url}\0${script.source.length}`;
    if (!seen.has(key)) {
      const disk = read(path);
      const meta = {
        path,
        blob: disk ? gitBlobId(disk) : null,
        aligned: disk !== null && lines.sourceText !== null && lines.sourceText === disk.toString("utf8"),
        mapped: lines.mapped,
        blocks: lines.blocks,
      };
      seen.set(key, meta);
      metas.push(meta);
    }
    let set = covered.get(path);
    if (!set) covered.set(path, (set = new Set()));
    for (const [a, b] of lines.covered) for (let n = a; n <= b; n++) set.add(n);
  }
  /** @type {Record<string, Array<[number, number]>>} */
  const lines = {};
  for (const path of [...covered.keys()].sort()) {
    lines[path] = toRuns(covered.get(path) ?? []);
  }
  return { loaded: [...loaded].sort(), exercised: [...exercised].sort(), lines, metas };
}
