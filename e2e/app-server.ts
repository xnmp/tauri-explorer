/**
 * Which app server a spec runs against (#1381).
 *
 * CI's browser shards serve one prebuilt browser-test bundle
 * (`E2E_BUILD_DIR`, `scripts/serve-e2e-build.mjs`) and keep a Vite dev server
 * beside it. A spec that intercepts requests may target individual source
 * modules (a route handler for `**\/FilePicker.svelte*` that fails or delays a
 * lazy chunk, or one that serves a modified module). Keep the interception
 * call's literal spelling out of this file's comments: fixtures.ts imports
 * it, so every spec would match. A bundle has no such URLs, so the
 * route would never match and the spec could pass without exercising what it
 * tests. Every spec that routes requests therefore runs on the dev server;
 * all others run on the bundle. Without `E2E_BUILD_DIR` (local runs, the
 * impact map) everything runs on the dev server at the configured baseURL.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** Port of the dev server that runs beside the bundle server. */
export const DEV_BESIDE_BUNDLE_PORT = Number(process.env.E2E_DEV_PORT || 1421);

const INTERCEPTS = /\.(?:route|unroute|routeFromHAR|routeWebSocket)\s*\(/;

/** True when a spec's source intercepts requests and so needs per-module URLs. */
export function needsDevServer(specSource: string): boolean {
  return INTERCEPTS.test(specSource);
}

const LOCAL_IMPORT = /\bfrom\s+["'](\.\.?\/[^"']+)["']/g;

/**
 * A spec and the local e2e modules it imports, transitively, so a helper that
 * routes requests moves its callers too. Throws if a file cannot be read.
 */
function sourcesOf(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const text = readFileSync(file, "utf8");
  const nested = [...text.matchAll(LOCAL_IMPORT)]
    .map((match) => resolve(dirname(file), match[1]))
    // Node-side app modules (`../src/lib/api/mock-control`) are not test helpers.
    .filter((path) => !path.includes(`${sep}src${sep}`) && !path.includes(`${sep}node_modules${sep}`))
    .flatMap((path) => {
      const candidate = [path, `${path}.ts`].find((name) => existsSync(name) && name.endsWith(".ts"));
      return candidate ? sourcesOf(candidate, seen) : [];
    });
  return [text, ...nested];
}

const decided = new Map<string, boolean>();

/**
 * The baseURL for a spec file: the configured one, or the dev server beside
 * the bundle for a spec that intercepts requests.
 */
export function baseURLFor(specFile: string, configured: string | undefined): string | undefined {
  if (!process.env.E2E_BUILD_DIR) return configured;
  let dev = decided.get(specFile);
  if (dev === undefined) {
    // An unreadable spec cannot be classified: the dev server is the safe side.
    try {
      dev = sourcesOf(specFile).some(needsDevServer);
    } catch {
      dev = true;
    }
    decided.set(specFile, dev);
  }
  return dev ? `http://localhost:${DEV_BESIDE_BUNDLE_PORT}` : configured;
}
