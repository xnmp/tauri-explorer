/**
 * Git-graph branch-line navigation bus (#530).
 *
 * Same shape, and the same reasoning, as `git-graph-refresh.ts`: the Ctrl+Up /
 * Ctrl+Down jumps are REGISTERED COMMANDS, not a `<svelte:window onkeydown>`
 * inside GitGraphView. A shadow window listener would be invisible to the
 * keybindings registry (so it could not be rebound, and the terminal's
 * key-ownership gate could not know the graph owns the key) and would fire for
 * every mounted graph tab whether active or not — the exact defect #432 fixed
 * for F5.
 *
 * GitGraphView registers its own selection stepper here keyed by pane id; the
 * commands dispatch to the ACTIVE pane's stepper only.
 */

import type { BranchLineDirection } from "$lib/domain/git-graph";

/** Moves a graph pane's selection one commit along its branch line. */
type StepFn = (direction: BranchLineDirection) => void;

const steppers = new Map<string, StepFn>();

/** Register a pane's selection stepper. Returns an unregister fn; call it on
 *  unmount. Idempotent per pane — a remount replaces the prior handler. */
export function registerGraphSelectionStepper(paneId: string, fn: StepFn): () => void {
  steppers.set(paneId, fn);
  return () => {
    if (steppers.get(paneId) === fn) steppers.delete(paneId);
  };
}

/** Step one pane's selection (the active graph pane). Returns false — a no-op
 *  — when that pane has no graph mounted. */
export function stepGraphSelection(
  paneId: string | undefined | null,
  direction: BranchLineDirection,
): boolean {
  if (!paneId) return false;
  const fn = steppers.get(paneId);
  if (!fn) return false;
  fn(direction);
  return true;
}
