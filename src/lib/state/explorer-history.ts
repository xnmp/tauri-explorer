/**
 * Undo and redo for one pane. Extracted from explorer.svelte.ts: the global
 * undo stack runs the action; the pane refreshes only while it is current.
 */

import { undoStore } from "./undo.svelte";
import { undoActionLabel } from "./undo-helpers";
import { toastStore } from "./toast.svelte";

export function createExplorerHistory(deps: {
  captureMutation(): { current(): boolean };
  refresh(options: { silent: true }): Promise<unknown>;
}) {
  async function applyHistory(direction: "undo" | "redo"): Promise<string | null> {
    const origin = deps.captureMutation();
    if (!origin.current()) return "Pane is closed";
    const result = await undoStore[direction]();
    const warnings = result.warnings?.join("\n");
    if (result.action) {
      // Native history publishes confirmed effects even if this pane closes.
      if (!result.error) {
        const completion = `${direction === "undo" ? "Undo" : "Redo"}: ${undoActionLabel(result.action)}`;
        toastStore.show(warnings ? `${completion}\n${warnings}` : completion, "info");
      }
      if (origin.current()) await deps.refresh({ silent: true });
    }
    if (warnings && result.error) toastStore.show(warnings, "info");
    if (result.error) toastStore.error(result.error);
    return result.error ?? null;
  }

  return {
    undo: () => applyHistory("undo"),
    redo: () => applyHistory("redo"),
  };
}
