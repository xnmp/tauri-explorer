#!/usr/bin/env node
// Frontend file-size ratchet (#1372).
//
// Every source file under src/ (.ts, .js, .mjs, .svelte) must stay at or below
// FILE_LINE_LIMIT lines. Files that were already larger when the ratchet was
// introduced are listed in scripts/file-size-allowlist.json at their line count
// then; such a file may shrink but never grow past its entry.
//
// Failures:
//   - a file over the limit with no allowlist entry;
//   - an allowlisted file that grew past its entry;
//   - a stale entry: its file is now at or below the limit, or no longer
//     exists. Stale entries fail rather than warn so the allowlist only ever
//     shrinks and a split cannot leave headroom for the file to regrow.
// A file below its entry but still over the limit passes with a note: lower
// the entry to lock in the reduction.
//
// Usage: node scripts/check-file-size.mjs   (run by `bun run lint:arch`)

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const FILE_LINE_LIMIT = 800;
const SOURCE = /\.(ts|js|mjs|svelte)$/;

/** Lines as `wc -l` counts them for a newline-terminated file.
 * @param {string} text */
export function countLines(text) {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/**
 * @param {ReadonlyArray<{ path: string, lines: number }>} files
 * @param {Readonly<Record<string, number>>} allowlist path -> maximum lines
 * @param {number} [limit]
 * @returns {{ errors: string[], notes: string[] }}
 */
export function checkFileSizes(files, allowlist, limit = FILE_LINE_LIMIT) {
  const errors = [];
  const notes = [];
  const seen = new Map(files.map((f) => [f.path, f.lines]));
  for (const { path, lines } of files) {
    const entry = Object.hasOwn(allowlist, path) ? allowlist[path] : undefined;
    if (entry === undefined) {
      if (lines > limit) errors.push(`${path}: ${lines} lines exceeds the ${limit}-line limit; split it (or, only for a file that predates the ratchet, list it in the allowlist)`);
      continue;
    }
    if (lines <= limit) errors.push(`${path}: ${lines} lines is within the ${limit}-line limit; remove its stale allowlist entry (${entry})`);
    else if (lines > entry) errors.push(`${path}: grew to ${lines} lines, past its allowlist entry of ${entry}; split it rather than raising the entry`);
    else if (lines < entry) notes.push(`${path}: ${lines} lines, below its allowlist entry of ${entry}; lower the entry to lock in the reduction`);
  }
  for (const [path, entry] of Object.entries(allowlist)) {
    if (!seen.has(path)) errors.push(`${path}: allowlisted (${entry}) but no longer exists; remove its stale entry`);
  }
  return { errors, notes };
}

/** Every frontend source file under `root/src`, repo-relative with `/`.
 * @param {string} root */
export function sourceFiles(root) {
  return readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const allowlist = JSON.parse(readFileSync(join(root, "scripts/file-size-allowlist.json"), "utf8"));
  const files = sourceFiles(root).map((path) => ({ path, lines: countLines(readFileSync(join(root, path), "utf8")) }));
  const { errors, notes } = checkFileSizes(files, allowlist);
  for (const note of notes) console.log(`file-size: note: ${note}`);
  if (errors.length) {
    for (const error of errors) console.error(`file-size: ${error}`);
    process.exit(1);
  }
  console.log(`file-size: ${files.length} source files within limits (${Object.keys(allowlist).length} allowlisted)`);
}
