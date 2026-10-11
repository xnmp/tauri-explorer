import type { PluginFileDropSource } from "$lib/plugins/api";
import type { RegisteredDropTarget } from "./file-drop-targets.svelte";
import { dragState, type DragData } from "./drag.svelte";
import { captureHighlightCleanup } from "$lib/composables/use-native-drop-target.svelte";

/** The single admission path for native, DOM and pointer completions.
 * Claim before effects, including blocked/no-op drops. DOM completion cannot
 * steal a pending/accepted native handoff. Targets must be resolved live. */
export function admitFileDrop(target: { type: string } | null, data: DragData | null, transport: "native" | "dom" = "native") {
  if (transport === "dom" && data?.sessionId) {
    const live = dragState.latestSource();
    if (dragState.nativeOwns(data.sessionId)
        || (live?.sessionId === data.sessionId && live.transport === "native-pending")) return null;
  }
  const receipt = dragState.claim(data);
  if (receipt && target?.type === "blocked") {
    const clear = captureHighlightCleanup();
    try { clear(); } finally { receipt.finish(); }
    return null;
  }
  return receipt;
}

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
  const lease = admitFileDrop(target, dragData);
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
