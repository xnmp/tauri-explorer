/** Window-owned projection of native file history. The native process alone
 * admits and executes inverses, including actions shared by multiple windows. */
import { fileHistoryPort } from "$lib/api/file-history";
import { emptyHistorySummary, type HistoryDirection, type HistoryPort, type HistoryReply, type HistorySummary, type UndoAction } from "$lib/domain/file-history";
import { toastStore } from "./toast.svelte";

export interface UndoCompletion { action?: UndoAction; error?: string }

export function createUndoStore(port: HistoryPort, report: (error: string) => void = (error) => { toastStore.error(error); }) {
  const initial = emptyHistorySummary();
  let summary = $state.raw(initial);
  let running = $state(false);
  let pendingWrites = 0;
  let writes: Promise<HistoryReply> = Promise.resolve({ summary: initial });
  let disposed = false;
  const receive = (next: HistorySummary) => {
    if (!disposed && next.revision > summary.revision) summary = next;
  };
  const unsubscribe = port.subscribe(receive);

  function write(operation: () => ReturnType<HistoryPort["clear"]>): Promise<void> {
    pendingWrites += 1;
    const pending = writes.then(async () => {
      const result = await operation();
      receive(result.summary);
      if (result.error) report(`Could not update Undo history: ${result.error}`);
      return result;
    }).catch((error): HistoryReply => {
      report(`Could not update Undo history: ${String(error)}`);
      return { summary, error: String(error) };
    });
    writes = pending.finally(() => { pendingWrites -= 1; });
    return writes.then(() => {});
  }

  async function perform(direction: HistoryDirection): Promise<UndoCompletion> {
    if (disposed) return { error: "File history is closed" };
    if (running) return { error: "An undo or redo operation is already in progress" };
    // Capture intent before awaiting IPC. Only writes already queued by this
    // window may determine a newer target; an unrelated later push must not.
    const admittedWrites = pendingWrites ? writes : null;
    const entryId = (state: HistorySummary) => direction === "undo" ? state.undoId : state.redoId;
    const expected = entryId(summary);
    running = true;
    try {
      const admitted = await admittedWrites;
      if (admitted?.error) return { error: admitted.error };
      // Use the receipt of the last write owned at admission, even if the
      // channel already describes a newer push from another window.
      const target = admitted ? entryId(admitted.summary) : expected;
      if (target === null) return { error: direction === "undo" ? "Nothing to undo" : "Nothing to redo" };
      const result = await port.execute(direction, target);
      receive(result.summary);
      return {
        ...(result.action ? { action: result.action } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally { running = false; }
  }

  function push(action: UndoAction, shared: boolean): Promise<void> {
    // Capture before queued work runs; callers may mutate their input afterward.
    const owned = structuredClone($state.snapshot(action));
    return write(() => port.push(owned, shared));
  }

  return {
    get canUndo() { return !disposed && !running && !summary.busy && summary.undoId !== null; },
    get canRedo() { return !disposed && !running && !summary.busy && summary.redoId !== null; },
    get stackSize() { return summary.stackSize; },
    push: (action: UndoAction) => push(action, false),
    pushAndBroadcast: (action: UndoAction) => push(action, true),
    clear: () => write(() => port.clear()),
    undo: () => perform("undo"),
    redo: () => perform("redo"),
    dispose() { disposed = true; unsubscribe(); },
  };
}

export const undoStore = createUndoStore(fileHistoryPort);
