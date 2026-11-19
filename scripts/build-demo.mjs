/**
 * `bun run build:demo`: build the marketing site's embedded demo
 * (`VITE_SITE_DEMO=1`, served at /app/) without breaking pages already open.
 *
 * An open page loads its lazy chunks (file views, the git graph, dialogs) on
 * first use, by the content-hashed names of the build it booted from.
 * Building in place deletes those files, so an open page failed the first
 * time it needed one: "Unable to load List view", "Could not load Git
 * history" (#1789). So the build goes to `build-demo.next/`, the previous
 * build's immutable files that are not in the new one are carried over
 * (content-hashed, so they never collide), and the new directory is swapped
 * into place at the end, so `build-demo/` is never half-written while a page
 * is being served from it.
 *
 * - One build at a time: `build-demo.lock` holds the running build's pid; a
 *   second run fails at once (two builds would delete each other's
 *   `build-demo.next/` and share `.svelte-kit/`). A lock whose process is
 *   gone is taken over.
 * - The swap is two renames (live → `.old`, next → live); Node offers no
 *   atomic directory exchange. A run interrupted between them leaves only
 *   `build-demo.old/`, which the next run puts back first. For the instant
 *   between the renames the server answers 404.
 * - A retired chunk is kept for RETAIN_MS from the build that RETIRED it (the
 *   first build that no longer produced it), recorded in `.retired.json`, not
 *   from its own date: a build that stayed live for weeks still leaves its
 *   chunks for the pages open on it.
 *
 * A deployment needs the same property: keep the previous release's
 * `_app/immutable/` files servable for as long as a visitor may keep a page
 * open (a static host that replaces the whole directory does not).
 */
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, closeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How long a retired chunk stays servable after the build that retired it. */
export const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const IMMUTABLE = join("_app", "immutable");
/** Retirement times of carried chunks, by path relative to the build root. */
export const RETIRED_MANIFEST = ".retired.json";

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

/** @param {string} build @returns {Record<string, number>} */
function readRetired(build) {
  try {
    const parsed = JSON.parse(readFileSync(join(build, RETIRED_MANIFEST), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Copy into `next` every immutable file of `live` that `next` lacks and that
 * was retired less than `retainMs` ago: a file `live` produced itself is
 * retired by this build (`now`); a file `live` was carrying keeps the time it
 * was first retired, so it ages out however many builds carry it. Records the
 * retirement times in `next`'s manifest and returns the carried paths,
 * relative to the build root.
 * @param {string} live
 * @param {string} next
 * @param {{ now?: number, retainMs?: number }} [options]
 * @returns {string[]}
 */
export function carryOverRetiredChunks(live, next, { now = Date.now(), retainMs = RETAIN_MS } = {}) {
  const earlier = readRetired(live);
  /** @type {Record<string, number>} */
  const retired = {};
  const carried = [];
  for (const file of filesUnder(join(live, IMMUTABLE))) {
    const rel = relative(live, file).split("\\").join("/");
    const target = join(next, rel);
    if (existsSync(target)) continue;
    const since = typeof earlier[rel] === "number" ? earlier[rel] : now;
    if (now - since > retainMs) continue;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target, { preserveTimestamps: true });
    retired[rel] = since;
    carried.push(rel);
  }
  mkdirSync(next, { recursive: true });
  writeFileSync(join(next, RETIRED_MANIFEST), `${JSON.stringify(retired, null, 1)}\n`);
  return carried.sort();
}

/** Put `next` where `live` is; the old build is removed.
 * @param {string} live @param {string} next */
export function swapIntoPlace(live, next) {
  const old = `${live}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(live)) renameSync(live, old);
  renameSync(next, live);
  rmSync(old, { recursive: true, force: true });
}

/**
 * Finish a swap an earlier run did not: with `live` missing, its `.old`
 * build is the last good one. Returns what it did.
 * @param {string} live
 * @returns {"restored" | "cleaned" | "none"}
 */
export function recoverInterruptedSwap(live) {
  const old = `${live}.old`;
  if (!existsSync(old)) return "none";
  if (!existsSync(live)) {
    renameSync(old, live);
    return "restored";
  }
  rmSync(old, { recursive: true, force: true });
  return "cleaned";
}

/** @param {number} pid */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * Take the build lock, or throw if a running build holds it. Returns the
 * release function.
 * @param {string} path
 * @param {number} [pid]
 * @returns {() => void}
 */
export function acquireBuildLock(path, pid = process.pid) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, `${pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      const holder = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
        throw new Error(`build:demo is already running (pid ${holder}; lock ${path}). Wait for it to finish.`);
      }
      // The build that held it is gone: take it over.
      rmSync(path, { force: true });
    }
  }
  throw new Error(`could not take the build lock ${path}`);
}

/**
 * One locked demo build: recover an interrupted swap, build into
 * `build-demo.next/`, carry the retired chunks over and swap. `build` runs
 * the actual build and returns its exit status. Returns the exit status.
 * @param {{ root: string, build: () => number, now?: number, retainMs?: number, log?: (line: string) => void }} options
 * @returns {number}
 */
export function runDemoBuild({ root, build, now, retainMs, log = console.log }) {
  const live = join(root, "build-demo");
  const next = join(root, "build-demo.next");
  const release = acquireBuildLock(join(root, "build-demo.lock"));
  try {
    const recovered = recoverInterruptedSwap(live);
    if (recovered === "restored") log("build-demo/ restored from build-demo.old/ (an earlier run was interrupted mid-swap).");
    rmSync(next, { recursive: true, force: true });
    const status = build();
    if (status !== 0) {
      rmSync(next, { recursive: true, force: true });
      log(`build failed (exit ${status}); build-demo/ is unchanged.`);
      return status;
    }
    const carried = carryOverRetiredChunks(live, next, { now, retainMs });
    swapIntoPlace(live, next);
    log(`build-demo/ updated; kept ${carried.length} chunk(s) of earlier builds for pages still open.`);
    return 0;
  } finally {
    release();
  }
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    process.exitCode = runDemoBuild({
      root,
      build: () => spawnSync("bun", ["run", "build"], {
        cwd: root,
        stdio: "inherit",
        // svelte.config.js reads SITE_DEMO_OUT for the site-demo output directory.
        env: { ...process.env, VITE_SITE_DEMO: "1", SITE_DEMO_OUT: "build-demo.next" },
      }).status ?? 1,
    });
  } catch (error) {
    console.error(String(/** @type {Error} */ (error).message ?? error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
