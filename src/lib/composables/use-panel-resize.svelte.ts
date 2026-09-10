import { loadPersisted, savePersisted } from "$lib/state/persisted";
import { createPanelResize } from "$lib/state/panel-resize";
import type { ResizeSizeOptions } from "$lib/domain/resize-size";
import { useResizeOwner, type ResizePresentation } from "$lib/composables/use-resize-owner.svelte";

export function usePersistedPanelWidth(key: string, options: ResizeSizeOptions,
  presentation: ResizePresentation & { automaticWidth?(): number } = {}) {
  return useResizeOwner(effects => createPanelResize(
    loadPersisted<unknown>(key, presentation.automaticWidth ? null : options.default), options,
    { ...effects, persist: value => savePersisted(key, value), automaticWidth: presentation.automaticWidth },
  ), presentation);
}
