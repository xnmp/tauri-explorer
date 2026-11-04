/**
 * Per-pane Folder Peek filter (#1510), owned by the lazy peek session. While
 * the pane filters with peeking available it walks the listings beneath the
 * pane (`peek-filter-scan.ts`) and publishes which folders a descendant match
 * keeps (`domain/peek-filter.ts`). Live peek listings win over the walk's
 * snapshots, so an open peek's watcher updates are matched as they arrive.
 */
import { untrack } from "svelte";
import type { FileEntry } from "$lib/domain/file";
import { peekFilterKeeps } from "$lib/domain/peek-filter";
import { fetchDirectory } from "$lib/api/files";
import { createPeekFilterScan } from "./peek-filter-scan";

/** What the explorer supplies; all reads are reactive. */
export interface PeekFilterSource {
  /** The filter's entry predicate while the pane filters with peeking
   * available (Folder Peek on, plain location), else undefined. */
  matcher(): ((entry: FileEntry) => boolean) | undefined;
  /** The pane's directory and its listing (reactive fields). */
  state: { readonly currentPath: string; readonly entries: readonly FileEntry[] };
  /** The entries the pane shows of a listing (hidden rules). */
  visible(entries: readonly FileEntry[], parent: string): readonly FileEntry[];
}

export interface PeekFilterResult {
  /** Folders shown because something below them matches. */
  readonly keeps: ReadonlySet<string>;
  /** Changes whenever `keeps` is recomputed (a projection cache key). */
  readonly key: string;
  /** Whether an entry stays: it matches, or something below it does. */
  readonly shows: (entry: FileEntry) => boolean;
}

const listFor = async (path: string) => {
  const result = await fetchDirectory(path);
  return result.ok ? result.data.entries : null;
};

export function createPeekFilter(
  source: PeekFilterSource,
  liveListing: (path: string) => readonly FileEntry[] | undefined,
  list: (path: string) => Promise<readonly FileEntry[] | null> = listFor,
) {
  let revision = $state(0);
  let serial = 0;
  const scan = createPeekFilterScan({ list, visible: (entries, parent) => source.visible(entries, parent), onChange: () => { revision++; } });
  // Listings do not depend on the query: keystrokes must not restart the walk.
  const filtering = $derived(!!source.matcher());
  const dispose = $effect.root(() => {
    $effect(() => {
      if (!filtering) { untrack(() => scan.stop()); return; }
      const { currentPath: root, entries } = source.state;
      untrack(() => scan.start(root, entries));
    });
  });
  const result = $derived.by((): PeekFilterResult | undefined => {
    const matches = source.matcher();
    if (!matches) return undefined;
    void revision;
    const { currentPath: root, entries } = source.state;
    const keeps = peekFilterKeeps({
      entries: source.visible(entries, root),
      listing: path => {
        const listed = liveListing(path) ?? scan.listing(path);
        return listed && source.visible(listed, path);
      },
      matches,
    });
    return { keeps, key: String(++serial), shows: entry => matches(entry) || keeps.has(entry.path) };
  });
  return {
    get current() { return result; },
    dispose() { dispose(); scan.stop(); },
  };
}
