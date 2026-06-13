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
  let pendingResolve: ((result: ConflictResult) => void) | null = null;
  // Concurrent batches (e.g. two simultaneous drops) each prompt; only one
  // dialog can show at a time, so later prompts queue until resolution.
  const queue: Array<{ info: ConflictInfo; resolve: (result: ConflictResult) => void }> = [];

  /** Show conflict dialog and await user choice. Queues if a dialog is already active. */
  function prompt(info: ConflictInfo): Promise<ConflictResult> {
    return new Promise<ConflictResult>((resolvePromise) => {
      if (activeConflict !== null) {
        queue.push({ info, resolve: resolvePromise });
        return;
      }
      activeConflict = { ...info };
      pendingResolve = resolvePromise;
    });
  }

  /** Called from the dialog when user makes a choice */
  function resolve(choice: ConflictChoice, applyToAll = false): void {
    const current = pendingResolve;
    pendingResolve = null;
    activeConflict = null;
    current?.({ choice, applyToAll });

    // Show the next queued conflict, if any.
    const next = queue.shift();
    if (next) {
      activeConflict = { ...next.info };
      pendingResolve = next.resolve;
    }
  }

  return {
    get activeConflict() { return activeConflict; },
    get isActive() { return activeConflict !== null; },
    prompt,
    resolve,
  };
}

export const conflictResolver = createConflictResolver();
