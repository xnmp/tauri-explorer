/**
 * Optional file-view renderers load on demand to keep the Details startup
 * graph bounded. The import promise is memoised per view so FileList can start
 * it as soon as it knows the view (in parallel with the directory listing) and
 * the render-time `{#await}` then joins the same in-flight promise.
 */
import type { Component } from "svelte";

export type OptionalView = "list-columns" | "list" | "tiles";

const importers: Record<OptionalView, () => Promise<{ default: Component<any> }>> = {
  "list-columns": () => import("./ListColumnsView.svelte"),
  list: () => import("./ListView.svelte"),
  tiles: () => import("./TilesView.svelte"),
};

const loaded = new Map<OptionalView, Promise<{ default: Component<any> }>>();

export function loadView(view: OptionalView): Promise<{ default: Component<any> }> {
  let pending = loaded.get(view);
  if (!pending) {
    pending = importers[view]();
    // A failed chunk fetch must be retryable on the next request.
    pending.catch(() => { if (loaded.get(view) === pending) loaded.delete(view); });
    loaded.set(view, pending);
  }
  return pending;
}

/** The renderer a given pane configuration needs, or null for built-in Details. */
export function optionalViewFor(viewMode: string, folderPeek: boolean): OptionalView | null {
  if (viewMode === "list") return folderPeek ? "list-columns" : "list";
  if (viewMode === "details") return null;
  return "tiles";
}
