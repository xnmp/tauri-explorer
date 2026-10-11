import type { PluginFileDropSource } from "$lib/plugins/api";
import type { RegisteredDropTarget } from "./file-drop-targets.svelte";
import { dragState, type DragData } from "./drag.svelte";
import { captureHighlightCleanup } from "$lib/composables/use-native-drop-target.svelte";

/** Terminal routing: returns null only for a built-in target. Calling this
 * claims synchronously, before the handler's first await. Invalid payloads,
 * retired registrations and blocked targets are consumed too. */
export function dispatchFileDrop(
  target: { type: string } | null,
  paths: readonly string[],
  source: PluginFileDropSource,
  dragData: DragData | null,
): Promise<void> | null {
  if (target?.type !== "plugin" && target?.type !== "blocked") return null;
  const registered = target as RegisteredDropTarget;
  const snapshot = Object.freeze([...paths]);
  const clear = captureHighlightCleanup();
  const lease = dragState.claim(dragData);
  if (!lease) return Promise.resolve();
  return (async () => {
    try {
      if (registered.type === "plugin" && snapshot.length &&
          registered.registration.live() && registered.registration.enabled()) {
        await registered.registration.handler(snapshot, source);
      }
    } finally {
      clear();
      lease.finish();
    }
  })();
}
