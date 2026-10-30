/**
 * Lineage peek state for one pane (#1431): which contributions the user
 * turned off, the lazily loaded controller, and the grouping the tree shows.
 * Extracted from explorer.svelte.ts; the pane supplies what it is showing
 * through `deps`.
 */

import { entryLineageRegistry } from "$lib/plugins/entry-lineage-registry.svelte";
import type { FileEntry } from "$lib/domain/file";
import type { LineageGroup } from "$lib/domain/entry-lineage";
import { basename } from "$lib/domain/path";
import type { PreviewTarget } from "$lib/plugins/preview-registry.svelte";
import type { PaneLineage } from "./pane-lineage.svelte";

/** Owner of host-made Preview targets for lineage group rows. */
export const LINEAGE_PREVIEW_OWNER = "host.lineage";

/** Preview of a lineage group row: the parents it combines and its size. */
export function lineageGroupPreviewTarget(group: LineageGroup): PreviewTarget {
  const names = group.coParents.map(parent => parent.kind === "entry" ? parent.name : `${parent.label} (outside this folder)`);
  const owner = basename(group.parent);
  return {
    id: group.id, title: `${owner} ${group.label}`, typeLabel: "Lineage group",
    ...(group.thumbnailPath ? { imagePath: group.thumbnailPath } : {}),
    details: [
      { label: "Parents", value: [owner, ...names].join(", ") },
      { label: "Files", value: String(group.members.length) },
    ],
  };
}

export interface ExplorerLineageDeps {
  directory(): string;
  /** Peeking is available here (capability is not "none"). */
  enabled(): boolean;
  /** A name filter suspends grouping so matches show flat. */
  filtered(): boolean;
  /** The pane's visible depth-0 listing without the name filter. */
  listing(): readonly FileEntry[];
  windows: boolean;
  /** The tree policies, loaded lazily; grouping needs them. */
  peek: { readonly policies: unknown; activate(): Promise<unknown> };
}

/** "Show <title>" is per pane and on by default: the pane records the
 * contributions its user turned off. The controller loads lazily with the
 * first registered contribution. */
export function createExplorerLineage(deps: ExplorerLineageDeps) {
  let hidden = $state.raw<ReadonlySet<string>>(new Set());
  let paneLineage = $state.raw<PaneLineage | null>(null);
  let loading = $state(false);
  let disposed = false;

  const disposeLoader = $effect.root(() => {
    $effect(() => {
      if (paneLineage || loading || disposed || !entryLineageRegistry.items.length) return;
      loading = true;
      void import("./pane-lineage.svelte").then(({ createPaneLineage }) => {
        if (disposed) return;
        paneLineage = createPaneLineage({
          directory: deps.directory,
          hidden: () => hidden,
          enabled: deps.enabled,
          listing: deps.listing,
          windows: deps.windows,
        });
      }).finally(() => { loading = false; });
    });
    // Grouping needs the tree policies; load them as soon as it applies.
    $effect(() => { if (grouping && !deps.peek.policies) void deps.peek.activate(); });
  });

  /** The grouping the tree shows, or null (no provider, off, or filtered). */
  const grouping = $derived.by(() => {
    const projection = deps.enabled() && !deps.filtered() ? paneLineage?.projection : null;
    return projection?.kind === "grouped" ? projection : null;
  });
  // Also while the controller module itself loads, so a provider registered
  // before navigation never shows a flat first frame.
  const holding = $derived(deps.enabled() && (paneLineage ? paneLineage.holding || (!!grouping && !deps.peek.policies) : loading));

  return {
    get grouping() { return grouping; },
    /** Prompt labels (#1449) while a shown lineage supplies them, else null. */
    get labels() { return deps.enabled() ? paneLineage?.labels ?? null : null; },
    /** First paint waits (bounded) for this folder's lineage. */
    get holding() { return holding; },
    /** Contributions offered here, for the View menu's "Show <title>". */
    get options() { return paneLineage?.offered ?? []; },
    isShown(id: string) { return !hidden.has(id); },
    setShown(id: string, shown: boolean) {
      if (shown === !hidden.has(id)) return;
      const next = new Set(hidden);
      if (shown) next.delete(id); else next.add(id);
      hidden = next;
    },
    /** Contribution ids this pane turned off (persisted with the pane). */
    get hidden(): readonly string[] { return [...hidden]; },
    /** Releases a held arrival so the revealed file can show. */
    release(path: string) { paneLineage?.release(path); },
    dispose() {
      disposed = true;
      disposeLoader();
      paneLineage?.dispose();
    },
  };
}
