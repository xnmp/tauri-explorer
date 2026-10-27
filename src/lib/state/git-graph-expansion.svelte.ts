/**
 * The git graph's single inline expansion below a commit row: either the
 * commit details block (#221) or the PR details dropdown (#459), never both.
 * Each opener closes the other, which keeps `expandedOid` single-valued and
 * the RowExpand stretch math unchanged. The measured heights of the open
 * block are published by the view (bind:offsetHeight) and reset whenever
 * the block closes or changes owner, so a stale height never stretches the
 * graph under a different row.
 */
import type { GraphCommit } from "./git-graph-cache";
import type { GitGraphDetail } from "./git-graph-detail.svelte";
import type { GitPrSession, PrSnapshot } from "./git-pr-session.svelte";
import type { CommitPanelStore } from "./commit-panel.svelte";

export interface GitGraphExpansionDeps {
  detail: Pick<GitGraphDetail, "selected" | "select" | "close">;
  pr: Pick<GitPrSession, "prDetail" | "openDetail" | "closeDetail">;
  /** Read at call time: the store follows the graph's pane. */
  commitPanel: () => Pick<CommitPanelStore, "resetIfIdle">;
  /** Retire an active fork-point lookup (user navigation). */
  cancelNavigation: () => void;
}

export function createGitGraphExpansion(deps: GitGraphExpansionDeps) {
  const { detail, pr, commitPanel, cancelNavigation } = deps;
  let detailsHeight = $state(0);
  let prDetailHeight = $state(0);

  function closePrDetail(): void {
    pr.closeDetail();
    prDetailHeight = 0;
  }

  /** Close commit details without retiring navigation (the fork-point
   *  jump's own reveal path). */
  function resetDetails(): void {
    detail.close();
    // Keep the pane-owned in-flight commit guard across close/reopen.
    commitPanel().resetIfIdle();
    detailsHeight = 0;
  }

  function closeDetails(): void {
    cancelNavigation();
    resetDetails();
  }

  function isPrDetailOpen(oid: string, prNumber: number): boolean {
    const open = pr.prDetail;
    return open?.oid === oid && open.pr.number === prNumber;
  }

  return {
    get detailsHeight() { return detailsHeight; },
    set detailsHeight(value: number) { detailsHeight = value; },
    get prDetailHeight() { return prDetailHeight; },
    set prDetailHeight(value: number) { prDetailHeight = value; },
    /** Oid of the row with an open inline expansion, or null. */
    get expandedOid(): string | null {
      return detail.selected?.oid ?? pr.prDetail?.oid ?? null;
    },
    /** Height of whichever inline block is open. */
    get expandHeight(): number {
      return detail.selected ? detailsHeight : pr.prDetail ? prDetailHeight : 0;
    },
    closePrDetail,
    closeDetails,
    resetDetails,
    async selectCommit(commit: GraphCommit, cancelJump = true): Promise<void> {
      if (cancelJump) cancelNavigation();
      closePrDetail();
      const pending = detail.select(commit);
      if (!detail.selected) {
        commitPanel().resetIfIdle();
        detailsHeight = 0;
      }
      await pending;
    },
    isPrDetailOpen,
    /** Toggle the PR dropdown for `snapshot` under row `oid`: the same badge
     *  closes it; another opens it in place of any commit details. */
    togglePrDetail(oid: string, snapshot: PrSnapshot): void {
      cancelNavigation();
      if (isPrDetailOpen(oid, snapshot.number)) {
        closePrDetail();
        return;
      }
      closeDetails();
      // Switching directly from one badge to another must not attach the
      // prior PR's checks or log to this expansion while either request is
      // in flight.
      prDetailHeight = 0;
      void pr.openDetail(oid, snapshot);
    },
  };
}

export type GitGraphExpansion = ReturnType<typeof createGitGraphExpansion>;
