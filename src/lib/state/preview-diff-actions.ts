/**
 * Preview diff-header and hunk actions (stage / unstage / discard).
 *
 * The shared Preview is window-global, so its repository mutations are admitted
 * against the pane that owns the previewed diff with the same destination-scoped
 * check commands use (`isPaneBlocked`). A covered owner makes every action a
 * no-op: no mutation is sent, no toast, and the view does not follow the file.
 */

import type { ScmStore } from "./scm.svelte";

export type HunkAction = "stage" | "unstage" | "discard";

export interface PreviewDiffActionDeps {
  scm: () => Pick<ScmStore, "activeDiff" | "summary" | "stage" | "unstage" | "discard" | "applyPatch" | "openDiff" | "closeDiff">;
  /** Pane owning the previewed diff (not necessarily the focused one). */
  ownerPaneId: () => string;
  isPaneBlocked: (paneId: string) => boolean;
  onError: (message: string) => void;
  confirm: (message: string) => boolean;
}

export function createPreviewDiffActions(deps: PreviewDiffActionDeps) {
  const blocked = () => deps.isPaneBlocked(deps.ownerPaneId());

  async function stage(): Promise<void> {
    const scm = deps.scm();
    if (blocked() || !scm.activeDiff) return;
    const path = scm.activeDiff.path;
    await scm.stage([path]);
    // Follow the file to its staged diff so the view doesn't leave the user
    // staring at an empty "unstaged" diff after the change moved to the index.
    if (scm.summary.staged.some((e) => e.path === path)) scm.openDiff(path, true);
  }

  async function unstage(): Promise<void> {
    const scm = deps.scm();
    if (blocked() || !scm.activeDiff) return;
    const path = scm.activeDiff.path;
    await scm.unstage([path]);
    const stillChanged =
      scm.summary.changes.some((e) => e.path === path) ||
      scm.summary.untracked.some((e) => e.path === path);
    if (stillChanged) scm.openDiff(path, false);
  }

  async function discard(): Promise<void> {
    const scm = deps.scm();
    if (blocked() || !scm.activeDiff) return;
    const r = await scm.discard([scm.activeDiff.path]);
    if (!r.ok) {
      deps.onError(`Discard failed: ${r.error}`);
      return;
    }
    scm.closeDiff();
  }

  async function applyHunk(patch: string, action: HunkAction): Promise<void> {
    const scm = deps.scm();
    if (blocked() || !scm.activeDiff) return;
    if (action === "discard" && !deps.confirm("Discard this hunk? This cannot be undone.")) return;
    const path = scm.activeDiff.path;
    const r = await scm.applyPatch(patch, action);
    if (!r.ok) {
      deps.onError(`${action[0].toUpperCase()}${action.slice(1)} hunk failed: ${r.error}`);
      return;
    }
    const stillStaged = scm.summary.staged.some((entry) => entry.path === path);
    const stillUnstaged = scm.summary.changes.some((entry) => entry.path === path);
    // A partially changed file can exist in both buckets. Only switch the
    // displayed side when the operation exhausted the current side.
    if (action === "stage" && !stillUnstaged && stillStaged) scm.openDiff(path, true);
    if (action === "unstage" && !stillStaged && stillUnstaged) scm.openDiff(path, false);
    if (action === "discard" && !stillUnstaged) scm.closeDiff();
  }

  return { stage, unstage, discard, applyHunk, blocked };
}
