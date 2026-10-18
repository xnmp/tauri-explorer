/**
 * Every built-in file-view renderer loads on demand to keep the startup graph
 * within its budget. Each renderer's import is memoised so FileList can start
 * it as soon as it knows the view, in parallel with the directory listing.
 *
 * Once settled, a renderer is published reactively: panes mounted afterwards
 * (split, new tab, view switch) render it in the same flush, as an eager
 * import would, instead of each mount waiting on its own `{#await}`.
 */
import { untrack, type Component } from "svelte";
import type { ViewMode } from "$lib/domain/file";

export type ViewRenderer = "details" | "list-columns" | "list" | "tiles" | "tiles-panels";
type ViewModule = { default: Component<any> };
type Outcome = { component: Component<any> } | { failed: true };

const importers: Record<ViewRenderer, () => Promise<ViewModule>> = {
  details: () => import("./DetailsView.svelte"),
  "list-columns": () => import("./ListColumnsView.svelte"),
  list: () => import("./ListView.svelte"),
  tiles: () => import("./TilesView.svelte"),
  "tiles-panels": () => import("./TilePanelsView.svelte"),
};

const pending = new Map<ViewRenderer, Promise<ViewModule>>();
let outcomes = $state.raw<Partial<Record<ViewRenderer, Outcome>>>({});

function publish(view: ViewRenderer, outcome: Outcome | undefined): void {
  const { [view]: _previous, ...rest } = outcomes;
  outcomes = outcome ? { ...rest, [view]: outcome } : rest;
}

/** Start (or join) a renderer's import. A failed import is retried by the next call. */
export function loadView(view: ViewRenderer): Promise<ViewModule> {
  const existing = pending.get(view);
  if (existing) return existing;
  const request = importers[view]();
  pending.set(view, request);
  // Callers may be effects; reading the published outcome must not subscribe them.
  untrack(() => { if (outcomes[view]) publish(view, undefined); });
  request.then(
    module => { if (pending.get(view) === request) publish(view, { component: module.default }); },
    () => {
      if (pending.get(view) !== request) return;
      pending.delete(view);
      publish(view, { failed: true });
    },
  );
  return request;
}

/** The settled renderer, or undefined while it loads or after its import failed. Reactive. */
export function loadedView(view: ViewRenderer): Component<any> | undefined {
  const outcome = outcomes[view];
  return outcome && "component" in outcome ? outcome.component : undefined;
}

/** Whether the latest import of this renderer failed. Reactive. */
export function viewLoadFailed(view: ViewRenderer): boolean {
  const outcome = outcomes[view];
  return !!outcome && "failed" in outcome;
}

/** The renderer a pane configuration needs. Folder Peek selects List's column
 * flow and Tiles' panel bands; off keeps the classic renderers untouched. */
export function viewRendererFor(viewMode: ViewMode, folderPeek: boolean): ViewRenderer {
  if (viewMode === "details") return "details";
  if (viewMode === "list") return folderPeek ? "list-columns" : "list";
  return folderPeek ? "tiles-panels" : "tiles";
}
