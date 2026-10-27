#!/usr/bin/env node
/**
 * Large-folder fixtures for the measured performance numbers (#983).
 *
 *   node scripts/perf-fixtures.mjs create [--root DIR] [--sizes 1k,10k,100k,500k]
 *   node scripts/perf-fixtures.mjs remove [--root DIR]
 *
 * `create` writes one flat folder per size under DIR (default:
 * `$TMPDIR/tauri-explorer-perf-fixtures`), named `files-1k`, `files-10k`, ...
 * Each holds exactly that many entries: one subdirectory, `000-subdir` (two
 * small files, the target for go-up/back/forward measurements), plus files
 * with mixed names (case, digits, spaces, dots, non-ASCII, 7-56 characters)
 * and mixed extensions, sizes and modification times. Contents are
 * deterministic (seeded PRNG), so every machine gets the same tree.
 *
 * File sizes are set with ftruncate, so files are sparse: a listing reports
 * their logical size while 500k files use little disk (inode tables dominate,
 * well under 1 GB on ext4). Listing never reads file contents, so sparseness
 * does not change what the measurement exercises. No image/video extensions
 * are used, so no thumbnail work is triggered.
 *
 * About a fifth of the names are dot-files, hidden by the app's default
 * settings. `root/manifest.json` records the total and visible (non-dot)
 * entry counts of every folder for the
 * measurement runner (`scripts/perf-real-app.mjs`). The root must lie outside
 * the repository; `remove` deletes only a root that contains that manifest.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "manifest.json";
const SUBDIR = "000-subdir";
/** @type {Record<string, number>} */
const SIZE_UNITS = { k: 1_000, m: 1_000_000 };

export const DEFAULT_ROOT = path.join(os.tmpdir(), "tauri-explorer-perf-fixtures");
export const DEFAULT_SIZES = ["1k", "10k", "100k", "500k"];

/**
 * Parse "10k" / "500k" / "1m" / "250" into an entry count.
 * @param {string} label
 * @returns {number}
 */
export function parseSize(label) {
  const match = /^(\d+)([km]?)$/i.exec(label.trim());
  if (!match) throw new Error(`invalid size "${label}" (expected e.g. 1k, 100k, 2500)`);
  const count = Number(match[1]) * (SIZE_UNITS[match[2].toLowerCase()] ?? 1);
  if (count < 2) throw new Error(`size "${label}" must be at least 2 entries`);
  return count;
}

/**
 * mulberry32: small, fast, deterministic.
 * @param {number} seed
 * @returns {() => number}
 */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["report", "Invoice", "draft", "IMG", "notes", "backup", "Résumé", "data", "build", "README",
  "config", "über", "final", "v2", "test", "日本語", "archive", "log", "Meeting notes", "temp"];
const EXTENSIONS = [".txt", ".md", ".json", ".log", ".csv", ".rs", ".ts", ".pdf", ".zip", ".tar.gz",
  ".docx", ".bin", ".yaml", ".html", "", ".DAT"];

/**
 * A unique, mixed-shape file name for index `i`.
 * @param {number} i
 * @param {() => number} random
 */
export function fixtureName(i, random) {
  /** @param {string[]} list */
  const pick = (list) => list[Math.floor(random() * list.length)];
  const shape = Math.floor(random() * 5);
  const n = String(i);
  const base =
    shape === 0 ? `${pick(WORDS)}_${n}` :
    shape === 1 ? `${pick(WORDS)} ${pick(WORDS)} (${n})` :
    shape === 2 ? `${n.padStart(7, "0")}-${pick(WORDS).toLowerCase()}` :
    shape === 3 ? `.${pick(WORDS).toLowerCase()}.${n}` :
    `${pick(WORDS).toUpperCase()}${"x".repeat(Math.floor(random() * 30))}.${n}`;
  return `${base}${pick(EXTENSIONS)}`;
}

/**
 * Mostly small files, a long tail up to 64 MiB (sparse).
 * @param {() => number} random
 */
function fixtureBytes(random) {
  const r = random();
  if (r < 0.1) return 0;
  if (r < 0.8) return Math.floor(random() * 16_384);
  if (r < 0.98) return Math.floor(random() * 4_194_304);
  return Math.floor(random() * 67_108_864);
}

/** @param {string} root */
function assertOutsideRepo(root) {
  const relative = path.relative(REPO, path.resolve(root));
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error(`fixture root ${root} is inside the repository; choose a temp dir`);
  }
}

/**
 * @param {string} dir
 * @param {number} count
 * @param {number} seed
 * @returns {number} entries not hidden by default (non-dot names)
 */
function createFolder(dir, count, seed) {
  const random = prng(seed);
  fs.mkdirSync(path.join(dir, SUBDIR), { recursive: true });
  for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(dir, SUBDIR, name), "subdir file\n");
  const now = Date.now() / 1000;
  for (let i = 1; i < count; i++) {
    const file = path.join(dir, fixtureName(i, random));
    const fd = fs.openSync(file, "w");
    try {
      fs.ftruncateSync(fd, fixtureBytes(random));
      const mtime = now - random() * 5 * 365 * 86_400;
      fs.futimesSync(fd, mtime, mtime);
    } finally {
      fs.closeSync(fd);
    }
  }
  // Names embed the index, so they are unique; verify rather than assume.
  const names = fs.readdirSync(dir);
  if (names.length !== count) throw new Error(`${dir}: expected ${count} entries, found ${names.length}`);
  // Dot-files are hidden by default, so the status bar counts only the rest.
  return names.filter((name) => !name.startsWith(".")).length;
}

/**
 * @typedef {{ name: string, path: string, entries: number, visibleEntries: number }} FixtureFolder
 * @typedef {{ generator: string, subdir: string, folders: Record<string, FixtureFolder> }} FixtureManifest
 */

/**
 * @param {string} root
 * @param {string[]} sizes
 * @returns {FixtureManifest}
 */
export function create(root, sizes) {
  assertOutsideRepo(root);
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0 && !fs.existsSync(path.join(root, MANIFEST))) {
    throw new Error(`${root} exists, is not empty and is not a fixture root; refusing to write into it`);
  }
  fs.mkdirSync(root, { recursive: true });
  /** @type {FixtureManifest} */
  const manifest = { generator: "scripts/perf-fixtures.mjs", subdir: SUBDIR, folders: {} };
  for (const label of sizes) {
    const count = parseSize(label);
    const name = `files-${label}`;
    const dir = path.join(root, name);
    fs.rmSync(dir, { recursive: true, force: true });
    const started = performance.now();
    const visibleEntries = createFolder(dir, count, count);
    manifest.folders[label] = { name, path: dir, entries: count, visibleEntries };
    console.log(`${name}: ${count} entries in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
  fs.writeFileSync(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** @param {string} root */
export function remove(root) {
  assertOutsideRepo(root);
  if (!fs.existsSync(root)) return;
  if (!fs.existsSync(path.join(root, MANIFEST))) {
    throw new Error(`${root} has no ${MANIFEST}; refusing to delete a directory this script did not create`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, root: DEFAULT_ROOT, sizes: DEFAULT_SIZES };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--root") options.root = path.resolve(rest[++i]);
    else if (rest[i] === "--sizes") options.sizes = rest[++i].split(",").filter(Boolean);
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "create") create(options.root, options.sizes);
    else if (options.command === "remove") remove(options.root);
    else throw new Error("usage: perf-fixtures.mjs create|remove [--root DIR] [--sizes 1k,10k,100k,500k]");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
