import { onDestroy, untrack } from "svelte";
import type { ReserveInlineWidth } from "$lib/state/pane-viewport.svelte";

/** The mount owns its contribution and stable reservation function. Hidden/hoisted
 * panels contribute nothing. */
export function useInlinePanelWidth(reserve: ReserveInlineWidth | undefined, width: () => number) {
  const lease = reserve?.();
  $effect(() => { const value = width(); untrack(() => lease?.update(value)); });
  onDestroy(() => lease?.dispose());
}
