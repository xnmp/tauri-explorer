/**
 * Confirmation dialog for GitHub PR mutations from the git graph (#1082,
 * ADR 0005/0006). The dialog carries the displayed repository identity the
 * backend rechecks; the PR session owns the mutation lifecycle. After an
 * uncertain failure GitHub may already have accepted the request, so a retry
 * needs an explicit "I checked GitHub" acknowledgement.
 */
import type { PrAction } from "$lib/api/git-log";
import { prRepositorySlug } from "$lib/domain/git-graph";
import type { GitPrSession, PrSnapshot } from "./git-pr-session.svelte";
import { toastStore } from "./toast.svelte";

type PrDialogSession = Pick<
  GitPrSession,
  "actionBusy" | "actionError" | "actionUncertain" | "prepareCreate" | "performAction" | "clearActionStatus"
>;

export function createGitGraphPrDialog(session: PrDialogSession) {
  let dialog = $state<PrAction | null>(null);
  let retryAcknowledged = $state(false);

  return {
    get dialog() { return dialog; },
    get retryAcknowledged() { return retryAcknowledged; },
    set retryAcknowledged(value: boolean) { retryAcknowledged = value; },
    /** Whether submission is currently refused. */
    get blocked() { return session.actionBusy || (session.actionUncertain && !retryAcknowledged); },

    async openCreate(headBranch: string | null): Promise<void> {
      if (!headBranch || session.actionBusy) return;
      retryAcknowledged = false;
      dialog = await session.prepareCreate(headBranch);
    },
    openAction(action: "merge" | "approve", pr: PrSnapshot): void {
      if (session.actionBusy) return;
      const repoSlug = prRepositorySlug(pr);
      if (!repoSlug) { toastStore.error("Cannot determine this PR's GitHub repository"); return; }
      retryAcknowledged = false;
      session.clearActionStatus();
      dialog = action === "merge"
        ? { action, repoSlug, prNumber: pr.number, method: "squash" }
        : { action, repoSlug, prNumber: pr.number };
    },
    async submit(): Promise<void> {
      if (!dialog || session.actionBusy || (session.actionUncertain && !retryAcknowledged)) return;
      await session.performAction({ ...dialog }, retryAcknowledged);
      retryAcknowledged = false;
      if (!session.actionError) dialog = null;
    },
    close(): void {
      dialog = null;
    },
  };
}

export type GitGraphPrDialog = ReturnType<typeof createGitGraphPrDialog>;
