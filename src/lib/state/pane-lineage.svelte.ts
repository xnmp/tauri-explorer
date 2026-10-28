/**
 * One pane's entry lineage (lineage peek §4.2): which contribution applies to
 * the pane's folder, its loaded lineage, the first-paint hold and held
 * arrivals. Loaded lazily, with the first registered contribution; the
 * grouping itself is the pure `projectLineage`.
 *
 * No intermediate frames:
 * - First paint holds while the applicable contribution answers "pending" or
 *   its first load is in flight, for at most `LINEAGE_FIRST_PAINT_MS`.
 * - A file new to the listing that the loaded lineage does not know is held
 *   back for at most `LINEAGE_ARRIVAL_HOLD_MS`, waiting for the provider's
 *   `changed`, so a new edit does not flash at depth 0 and then jump under its
 *   parent. The next published lineage (or the deadline) releases it.
 * - A reload keeps the previous lineage until the new one arrives; an equal
 *   revision publishes nothing.
 */
import { untrack } from "svelte";
import type { FileEntry } from "$lib/domain/file";
import { projectLineage, type EntryLineage, type LineageProjection } from "$lib/domain/entry-lineage";
import { pathComparison } from "$lib/domain/path";
import { entryLineageRegistry, type RegisteredEntryLineage } from "$lib/plugins/entry-lineage-registry.svelte";

export const LINEAGE_FIRST_PAINT_MS = 400;
export const LINEAGE_ARRIVAL_HOLD_MS = 300;
/** `changed` is coalesced per folder: a provider may wake every subscribed
 * folder at once, repeatedly (one plugin-wide invalidation). */
export const LINEAGE_CHANGE_DEBOUNCE_MS = 50;

/** Grouping fallbacks (a cycle in a provider's graph), for diagnostics and tests. */
export const lineageDiagnostics = { cycleFallbacks: 0 };

export interface PaneLineageInputs {
  directory(): string;
  /** Contribution ids this pane's user turned off ("Show <title>" unchecked). */
  hidden(): ReadonlySet<string>;
  /** The pane can group at all (peekable built-in view in a plain folder). */
  enabled(): boolean;
  /** The pane's visible depth-0 listing (hidden rules, no name filter), sorted. */
  listing(): readonly FileEntry[];
  windows: boolean;
}

interface Loaded { directory: string; id: string; lineage: EntryLineage }

export function createPaneLineage(inputs: PaneLineageInputs) {
  const paths = pathComparison(inputs.windows);
  /** Contributions that apply to this folder (true or "pending"), for the View menu. */
  const offered = $derived.by(() => {
    const directory = inputs.directory();
    if (!directory || !inputs.enabled()) return [];
    return entryLineageRegistry.items
      .map(item => ({ item, answer: entryLineageRegistry.availability(item, directory) }))
      .filter(({ answer }) => answer !== false);
  });
  /** The first shown contribution: it groups once available, holds while pending. */
  const candidate = $derived(offered.find(({ item }) => !inputs.hidden().has(item.id)) ?? null);
  const active = $derived<RegisteredEntryLineage | null>(candidate?.answer === true ? candidate.item : null);

  let loaded = $state.raw<Loaded | null>(null);
  /** The scope whose first-paint deadline passed. */
  let expired = $state.raw<string | null>(null);
  let held = $state.raw<ReadonlySet<string>>(new Set());
  const scope = $derived(`${inputs.directory()}\0${candidate?.item.id ?? ""}`);
  const current = $derived(active && loaded && loaded.id === active.id && paths.same(loaded.directory, inputs.directory()) ? loaded : null);

  const holding = $derived(candidate !== null && current === null && expired !== scope);

  const projection = $derived.by((): LineageProjection | null => {
    if (!current) return null;
    const listing = inputs.listing();
    const visible = held.size ? listing.filter(entry => !held.has(entry.path)) : listing;
    return projectLineage(visible, current.lineage, inputs.windows);
  });

  const dispose = $effect.root(() => {
    // The first-paint deadline: one per folder and contribution.
    $effect(() => {
      const at = scope;
      if (candidate === null) return;
      const timer = setTimeout(() => { expired = at; }, LINEAGE_FIRST_PAINT_MS);
      return () => clearTimeout(timer);
    });
    // Load, and reload on `changed`, for the active contribution.
    $effect(() => {
      const item = active;
      const directory = inputs.directory();
      if (!item || !directory) return;
      let controller: AbortController | null = null;
      let disposed = false;
      const load = () => {
        controller?.abort();
        const own = controller = new AbortController();
        void Promise.resolve().then(() => item.load(directory, own.signal)).then(lineage => {
          if (disposed || own.signal.aborted || !lineage || !(lineage.parents instanceof Map)) return;
          const previous = untrack(() => loaded);
          // A published lineage answers every held arrival.
          if (untrack(() => held.size)) held = new Set();
          if (previous && previous.id === item.id && previous.directory === directory && previous.lineage.revision === lineage.revision) return;
          loaded = { directory, id: item.id, lineage };
        }, error => {
          if (!disposed && !own.signal.aborted) console.error(`[plugins] "${item.pluginId}" entry lineage ${item.id} load failed:`, error);
        });
      };
      load();
      let unsubscribe: (() => void) | undefined;
      let debounce: ReturnType<typeof setTimeout> | undefined;
      const changed = () => {
        if (disposed) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => { if (!disposed) load(); }, LINEAGE_CHANGE_DEBOUNCE_MS);
      };
      try { unsubscribe = item.subscribe?.(directory, changed); }
      catch (error) { console.error(`[plugins] "${item.pluginId}" entry lineage ${item.id} subscribe failed:`, error); }
      return () => {
        disposed = true;
        clearTimeout(debounce);
        controller?.abort();
        try { unsubscribe?.(); } catch (error) { console.error(`[plugins] entry lineage ${item.id} unsubscribe failed:`, error); }
      };
    });
    // Held arrivals: new files the loaded lineage does not know yet.
    let previous: { directory: string; paths: ReadonlySet<string> } | null = null;
    $effect(() => {
      const directory = inputs.directory();
      const listing = inputs.listing();
      const lineage = current?.lineage;
      untrack(() => {
        const now = new Set(listing.map(entry => entry.path));
        const before = previous?.directory === directory ? previous.paths : null;
        previous = { directory, paths: now };
        if (!lineage || !before) {
          if (held.size) held = new Set();
          return;
        }
        const known = new Set<string | null>();
        for (const [child, parents] of lineage.parents) {
          if (typeof child === "string") known.add(paths.key(child));
          if (Array.isArray(parents)) for (const parent of parents) if (parent?.kind === "entry" && typeof parent.path === "string") known.add(paths.key(parent.path));
        }
        // Only files can be lineage outputs: a new folder never waits.
        const arrivals = listing.filter(entry => entry.kind !== "directory" && !before.has(entry.path) && !held.has(entry.path) && !known.has(paths.key(entry.path)));
        const kept = [...held].filter(path => now.has(path));
        if (!arrivals.length && kept.length === held.size) return;
        held = new Set([...kept, ...arrivals.map(entry => entry.path)]);
        if (!arrivals.length) return;
        const release = new Set(arrivals.map(entry => entry.path));
        setTimeout(() => {
          if (![...release].some(path => held.has(path))) return;
          held = new Set([...held].filter(path => !release.has(path)));
        }, LINEAGE_ARRIVAL_HOLD_MS);
      });
    });
    // Count each fallback once per folder and revision.
    let counted: string | null = null;
    $effect(() => {
      const value = projection;
      const at = current ? `${current.directory}\0${current.id}\0${current.lineage.revision}` : null;
      if (value?.kind === "flat" && value.reason === "cycle" && at !== counted) {
        counted = at;
        lineageDiagnostics.cycleFallbacks++;
        console.warn(`[lineage] ${current!.id} returned a cycle for ${current!.directory}; grouping is off there.`);
      }
    });
  });

  return {
    dispose,
    /** Contributions offered for this folder (for "Show <title>"). */
    get offered(): readonly RegisteredEntryLineage[] { return offered.map(({ item }) => item); },
    get active() { return active; },
    /** Hold first paint (bounded): the lineage for this folder is still coming. */
    get holding() { return holding; },
    /** New files held back while the lineage catches up. */
    get held(): ReadonlySet<string> { return held; },
    /** Show a held arrival now (it is being revealed or selected). */
    release(path: string) { if (held.has(path)) held = new Set([...held].filter(item => item !== path)); },
    /** The grouping for the current listing, or null (no lineage here, or not loaded). */
    get projection() { return projection; },
  };
}

export type PaneLineage = ReturnType<typeof createPaneLineage>;
