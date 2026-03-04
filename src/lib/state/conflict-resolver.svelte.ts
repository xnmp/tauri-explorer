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
}

export interface ConflictResult {
  choice: ConflictChoice;
  applyToAll: boolean;
}

function createConflictResolver() {
  let activeConflict = $state<ConflictInfo | null>(null);
  let pendingResolve: ((result: ConflictResult) => void) | null = null;

  /** Show conflict dialog and await user choice */
  function prompt(info: ConflictInfo): Promise<ConflictResult> {
    activeConflict = { ...info };
    return new Promise<ConflictResult>((resolve) => {
      pendingResolve = resolve;
    });
  }

  /** Called from the dialog when user makes a choice */
  function resolve(choice: ConflictChoice, applyToAll = false): void {
    activeConflict = null;
    pendingResolve?.({ choice, applyToAll });
    pendingResolve = null;
  }

  return {
    get activeConflict() { return activeConflict; },
    get isActive() { return activeConflict !== null; },
    prompt,
    resolve,
  };
}

export const conflictResolver = createConflictResolver();
