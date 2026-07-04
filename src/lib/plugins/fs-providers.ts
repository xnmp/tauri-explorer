/**
 * Virtual-filesystem provider registry + dispatch.
 *
 * Plugins register a provider for a URL scheme (e.g. `demo`, `keep`). The
 * directory-listing API wrappers in `files.ts` route `<scheme>://…` paths to
 * the matching provider instead of the real-fs Tauri commands.
 *
 * This is intentionally minimal: providers expose `list(path)` returning a
 * `DirectoryListing`. `open`/`readFile` are left for future contribution
 * points (the Keep provider, #143).
 */

import type { DirectoryListing } from "$lib/domain/file";
import { virtualScheme } from "$lib/domain/virtual-path";

export interface FsProvider {
  /** List the contents of a virtual directory. May be sync or async. */
  list(path: string): DirectoryListing | Promise<DirectoryListing>;
}

const providers = new Map<string, FsProvider>();

/**
 * Register a provider for `scheme`. Returns a disposer that unregisters it
 * (only if it is still the registered provider for that scheme).
 */
export function registerFsProvider(scheme: string, provider: FsProvider): () => void {
  const key = scheme.toLowerCase();
  providers.set(key, provider);
  return () => {
    if (providers.get(key) === provider) providers.delete(key);
  };
}

/** The provider matching `path`'s scheme, or null when none matches. */
export function providerFor(path: string): FsProvider | null {
  const scheme = virtualScheme(path);
  if (!scheme) return null;
  return providers.get(scheme) ?? null;
}

/** Remove all registered providers. Test helper. */
export function clearFsProviders(): void {
  providers.clear();
}
