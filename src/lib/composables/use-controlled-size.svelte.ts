import { untrack } from "svelte";
import type { ResizeSizeOptions } from "$lib/domain/resize-size";
import { createScalarResize } from "$lib/state/scalar-resize";
import { useResizeOwner, type ResizePresentation } from "$lib/composables/use-resize-owner.svelte";

/** Drafts remain presentation-only. A changed committed source supersedes the
 * gesture; unrelated settings updates and the owner's own commit do not. */
export function useControlledSize(read: () => number, commit: (value: number) => void,
  options: () => ResizeSizeOptions, presentation: ResizePresentation = {}) {
  const resize = useResizeOwner(effects => createScalarResize({ ...effects, read, commit, options }), presentation);
  $effect(() => { read(); options(); untrack(resize.reconcile); });
  return resize;
}
