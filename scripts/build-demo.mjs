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
 * (content-hashed, so they never collide; dropped after RETAIN_MS), and the
 * new directory is swapped into place at the end, so `build-demo/` is never
 * half-written while a page is being served from it.
 *
 * A deployment needs the same property: keep the previous release's
 * `_app/immutable/` files servable for as long as a visitor may keep a page
 * open (a static host that replaces the whole directory does not).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How long a retired chunk stays servable after the build that made it. */
export const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const IMMUTABLE = join("_app", "immutable");

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

/**
 * Copy into `next` every immutable file of `live` that `next` lacks and
 * that is younger than `retainMs` (by its own mtime, which a carried file
 * keeps, so it ages out however many builds carry it). Returns the
 * carried paths, relative to the build root.
 * @param {string} live
 * @param {string} next
 * @param {{ now?: number, retainMs?: number }} [options]
 * @returns {string[]}
 */
export function carryOverRetiredChunks(live, next, { now = Date.now(), retainMs = RETAIN_MS } = {}) {
  const carried = [];
  for (const file of filesUnder(join(live, IMMUTABLE))) {
    const rel = relative(live, file);
    const target = join(next, rel);
    if (existsSync(target) || now - statSync(file).mtimeMs > retainMs) continue;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target, { preserveTimestamps: true });
    carried.push(rel);
  }
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

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const live = join(root, "build-demo");
  const next = join(root, "build-demo.next");
  rmSync(next, { recursive: true, force: true });
  const build = spawnSync("bun", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    // svelte.config.js reads SITE_DEMO_OUT for the site-demo output directory.
    env: { ...process.env, VITE_SITE_DEMO: "1", SITE_DEMO_OUT: "build-demo.next" },
  });
  if (build.status !== 0) {
    rmSync(next, { recursive: true, force: true });
    process.exit(build.status ?? 1);
  }
  const carried = carryOverRetiredChunks(live, next);
  swapIntoPlace(live, next);
  console.log(`build-demo/ updated; kept ${carried.length} chunk(s) of earlier builds for pages still open.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
