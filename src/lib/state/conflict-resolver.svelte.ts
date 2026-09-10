/**
 * Paste conflict resolution state.
 * Issue: tauri-zqdp
 *
 * When pasting files that already exist at the destination, this module
 * manages the conflict dialog and tracks the user's resolution choice.
 */

export type ConflictChoice = "overwrite" | "skip" | "cancel";

export interface ConflictInfo {
  fileName: string;
  sourcePath: string;
  remaining: number;
  sourceSize?: number;
  sourceModified?: string;
  destSize?: number;
  destModified?: string;
}

export interface ConflictResult {
  choice: ConflictChoice;
  applyToAll: boolean;
}

function createConflictResolver() {
  let activeConflict = $state<ConflictInfo | null>(null);
  interface Prompt { info: ConflictInfo; finish: (result: ConflictResult) => void }
  let active: Prompt | null = null;
  const queue: Prompt[] = [];

  function showNext(): void {
    active = queue.shift() ?? null;
    activeConflict = active ? { ...active.info } : null;
  }

  /** Each caller owns its queued or visible prompt through its AbortSignal. */
  function prompt(info: ConflictInfo, signal?: AbortSignal): Promise<ConflictResult> {
    const cancelled: ConflictResult = { choice: "cancel", applyToAll: false };
    if (signal?.aborted) return Promise.resolve(cancelled);
    return new Promise<ConflictResult>((resolvePromise) => {
      let pending = true;
      const request: Prompt = { info, finish(result) {
        if (!pending) return;
        pending = false;
        signal?.removeEventListener("abort", abort);
        if (active === request) showNext();
        else {
          const index = queue.indexOf(request);
          if (index !== -1) queue.splice(index, 1);
        }
        resolvePromise(result);
      } };
      const abort = () => request.finish(cancelled);
      signal?.addEventListener("abort", abort, { once: true });
      queue.push(request);
      if (!active) showNext();
    });
  }

  function resolve(choice: ConflictChoice, applyToAll = false): void {
    active?.finish({ choice, applyToAll });
  }

  return {
    get activeConflict() { return activeConflict; },
    get isActive() { return activeConflict !== null; },
    prompt,
    resolve,
  };
}

export const conflictResolver = createConflictResolver();
