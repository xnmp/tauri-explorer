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
