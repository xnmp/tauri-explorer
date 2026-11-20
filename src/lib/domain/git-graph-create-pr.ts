/**
 * Pure state of the git graph's "Create pull request…" menu entry (#1847).
 * The rendering lives in components/git-graph/GitGraphCommitMenu.svelte.
 */

/** The "Create pull request…" entry of a branch menu (#1847). */
export type CreatePrMenuItem =
  | { readonly branch: string; readonly enabled: true }
  | { readonly branch: string; readonly enabled: false; readonly reason: string };

/**
 * Only a menu scoped to a local branch (a local branch pill, or a branch
 * chosen in the row's references disclosure) offers PR creation; remote and
 * tag pills and the plain row menu do not. The entry stays visible but
 * disabled, with its reason, while a PR action runs or once the branch
 * already has an open PR.
 */
export function createPrMenuItem(
  scopedBranch: string | null,
  actionBusy: boolean,
  openPr: { readonly number: number } | undefined,
): CreatePrMenuItem | null {
  if (!scopedBranch) return null;
  if (actionBusy) return { branch: scopedBranch, enabled: false, reason: "A GitHub PR action is in progress" };
  if (openPr) return { branch: scopedBranch, enabled: false, reason: `PR #${openPr.number} is already open` };
  return { branch: scopedBranch, enabled: true };
}
