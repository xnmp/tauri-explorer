/**
 * Unique JavaScript files statically reachable from Vite's entry records.
 * Dynamic imports are deliberately excluded: they belong to first-use costs.
 * @param {Record<string, {file: string, isEntry?: boolean, imports?: string[], dynamicImports?: string[]}>} manifest
 * @returns {string[]}
 */
export function collectStartupFiles(manifest) {
  const seen = new Set();
  const files = new Set();
  const queue = Object.keys(manifest).filter((key) => manifest[key].isEntry);
  while (queue.length > 0) {
    const key = queue.pop();
    if (key === undefined) break;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing static import in Vite manifest: ${key}`);
    if (entry.file.endsWith(".js")) files.add(entry.file);
    queue.push(...(entry.imports ?? []));
  }
  if (files.size === 0) throw new Error("No entry JS chunks found in Vite manifest");
  return [...files];
}

/** Fixed-length stand-in for a Rollup content hash (8 characters by default). */
export const HASH_PLACEHOLDER = "########";

// SvelteKit names client output `${prefix}/chunks/[hash].js`,
// `${prefix}/[name].[hash].js` (entry/ and nodes/) and
// `${prefix}/assets/[name].[hash][extname]` (@sveltejs/kit
// src/exports/vite/index.js). Rollup's hash is 8 base64url characters, and
// Rollup appends a counter when two emitted names collide (e.g. `BfIQrfYo2.js`).
const HASHED_CHUNK = /^[A-Za-z0-9_-]{8}\d*(\.[A-Za-z0-9]+)$/;
const HASHED_NAMED = /^(.+)\.[A-Za-z0-9_-]{8}\d*(\.[A-Za-z0-9]+)$/;

/**
 * The basename an emitted client file would have with its content hash
 * replaced by HASH_PLACEHOLDER, or null when the file is not content-hashed.
 * @param {string} file path relative to the client output directory
 * @returns {string | null}
 */
export function normalizedClientName(file) {
  const parts = file.split(/[\\/]/);
  const base = parts.pop() ?? "";
  if (!parts.includes("immutable")) return null;
  if (parts.at(-1) === "chunks") {
    const chunk = HASHED_CHUNK.exec(base);
    return chunk ? `${HASH_PLACEHOLDER}${chunk[1]}` : null;
  }
  const named = HASHED_NAMED.exec(base);
  return named ? `${named[1]}.${HASH_PLACEHOLDER}${named[2]}` : null;
}

/**
 * Replace every reference to an emitted content-hashed file in `text` with
 * its placeholder name. Renaming an unchanged file (because some chunk it
 * lists, imports or preloads changed) then leaves the text identical, so a
 * gzip measurement tracks code rather than the entropy of hash strings.
 * @param {string} text
 * @param {Iterable<string>} files every emitted file, relative to the client output directory
 * @returns {string}
 */
export function normalizeHashedNames(text, files) {
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const file of files) {
    const normalized = normalizedClientName(file);
    if (normalized) names.set(file.split(/[\\/]/).pop() ?? file, normalized);
  }
  if (names.size === 0) return text;
  const escape = (/** @type {string} */ name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alternation = [...names.keys()].sort((a, b) => b.length - a.length).map(escape).join("|");
  const reference = new RegExp(`(?<![A-Za-z0-9_.-])(?:${alternation})(?![A-Za-z0-9_-])`, "g");
  return text.replace(reference, (name) => names.get(name) ?? name);
}
