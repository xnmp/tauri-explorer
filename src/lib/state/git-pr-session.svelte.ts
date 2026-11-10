import { getPrMutationOwner } from "$lib/state/git-pr-mutations.svelte";
import { extractError } from "$lib/api/common";
import {
  gitFailedCiCheckLog,
  gitFailedCiChecks,
  gitOpenPrs,
  gitPrAction,
  gitPrContext,
  type PrContext,
  type PrAction,
  type FailedCiCheck,
  type FailedCiCheckLog,
  type OpenPr,
  type PrComment,
  type PrReviewComment,
  type PrReviewThread,
} from "$lib/api/git-log";
import { indexPrsByBranch } from "$lib/domain/git-graph";
import { createSlotCell } from "$lib/state/slot-cell.svelte";
import { beginSlot, clearSlot, idleSlot, isSlotLoading, settleSlot, slotData, type Slot } from "$lib/domain/request-slot";

export interface FailedCiChecksState {
  readonly prNumber: number;
  readonly checks: readonly FailedCiCheckSnapshot[];
  readonly error: string | null;
}

export interface CiCheckLogState {
  readonly prNumber: number;
  readonly check: FailedCiCheckSnapshot;
  readonly result: FailedCiCheckLogSnapshot | null;
  readonly error: string | null;
}

export type FailedCiCheckSnapshot = Readonly<FailedCiCheck>;
export type FailedCiCheckLogSnapshot = Readonly<FailedCiCheckLog>;

export type PrCommentSnapshot = Readonly<PrComment>;
export type PrReviewCommentSnapshot = Readonly<PrReviewComment>;
export type PrReviewThreadSnapshot = Readonly<
  Omit<PrReviewThread, "comments"> & { comments: readonly PrReviewCommentSnapshot[] }
>;
export type PrSnapshot = Readonly<
  Omit<OpenPr, "comments" | "reviewThreads"> & {
    comments?: readonly PrCommentSnapshot[];
    reviewThreads?: readonly PrReviewThreadSnapshot[] | null;
  }
>;

interface GitPrSessionDependencies {
  context?(repoPath: string): Promise<PrContext>;
  mutate?(repoPath: string, request: PrAction): Promise<string>;
  openPrs(repoPath: string): Promise<OpenPr[]>;
  failedChecks(repoPath: string, prNumber: number): Promise<FailedCiCheck[]>;
  checkLog(repoPath: string, check: FailedCiCheck): Promise<FailedCiCheckLog>;
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const snapshotPr = (pr: PrSnapshot): PrSnapshot => Object.freeze({
  ...pr,
  comments: pr.comments
    ? Object.freeze(pr.comments.map((comment) => Object.freeze({ ...comment })))
    : pr.comments,
  reviewThreads: pr.reviewThreads
    ? Object.freeze(pr.reviewThreads.map((thread) => Object.freeze({
        ...thread,
        comments: Object.freeze(
          thread.comments.map((comment) => Object.freeze({ ...comment })),
        ),
      })))
    : pr.reviewThreads,
});

const snapshotCheck = (check: FailedCiCheckSnapshot): FailedCiCheckSnapshot =>
  Object.freeze({ ...check });

/** Owns one mounted graph's GitHub badge and PR/CI request lifetimes. */
export function createGitPrSession(
  repoPath: string,
  dependencies: GitPrSessionDependencies = {
    openPrs: gitOpenPrs,
    failedChecks: gitFailedCiChecks,
    checkLog: gitFailedCiCheckLog,
  },
) {
  let prDetail = $state.raw<{ readonly oid: string; readonly pr: PrSnapshot } | null>(null);
  // Each async result is a latest-request-wins slot; settled states are built
  // (and frozen) once so getters return stable objects. The loading slot's key
  // is the loading-state object itself where consumers read it.
  const badges = createSlotCell<Slot<Map<string, PrSnapshot>>>(idleSlot());
  const checks = createSlotCell<Slot<FailedCiChecksState, number, FailedCiChecksState>>(idleSlot());
  const checkLog = createSlotCell<Slot<CiCheckLogState, CiCheckLogState, CiCheckLogState>>(idleSlot());
  // Getters notify only when their own value changes, not when a reload begins.
  const badgeData = $derived(slotData(badges.view()));
  const checksView = $derived.by((): FailedCiChecksState | null => {
    const slot = checks.view();
    return slot.kind === "ready" ? slot.data : slot.kind === "failed" ? slot.error : null;
  });
  const checksLoading = $derived(isSlotLoading(checks.view()));
  const checkLogView = $derived.by((): CiCheckLogState | null => {
    const slot = checkLog.view();
    return slot.kind === "loading" ? slot.key
      : slot.kind === "ready" ? slot.data
      : slot.kind === "failed" ? slot.error : null;
  });
  let tokens = 0;
  const nextToken = () => ++tokens;
  let disposed = false;
  const mutation = getPrMutationOwner(repoPath);
  let contextBusy = $state(false);
  let contextError = $state<string | null>(null);
  const unsubscribeMutation = mutation.subscribe(async () => {
    await reloadBadges();
    if (disposed || !prDetail) return;
    const updated = [...(slotData(badges.get()) ?? new Map<string, PrSnapshot>()).values()].find(pr => pr.number === prDetail?.pr.number);
    if (updated) prDetail = Object.freeze({ oid: prDetail.oid, pr: updated });
    else closeDetail();
  });

  async function prepareCreate(expectedBranch: string): Promise<PrAction | null> {
    if (disposed || contextBusy || mutation.busy) return null;
    contextBusy = true; contextError = null; mutation.clear();
    try {
      const context = await (dependencies.context ?? gitPrContext)(repoPath);
      if (disposed) return null;
      if (context.headBranch !== expectedBranch) throw new Error("Current branch changed; refresh the graph before creating a PR");
      return { action: "create", repoSlug: context.repoSlug, headBranch: expectedBranch, title: "", body: "", base: "" };
    } catch (error) {
      if (!disposed) contextError = extractError(error);
      return null;
    } finally { contextBusy = false; }
  }

  async function performAction(request: PrAction, checkedRetry = false): Promise<void> {
    if (disposed || contextBusy) return;
    contextError = null;
    await mutation.run(request, request => (dependencies.mutate ?? gitPrAction)(repoPath, request), checkedRetry);
  }

  async function reloadBadges(): Promise<void> {
    if (disposed) return;
    const token = nextToken();
    badges.set(beginSlot(badges.get(), undefined, token));
    try {
      const prs = await dependencies.openPrs(repoPath);
      badges.set(settleSlot(badges.get(), token, { ok: true, data: indexPrsByBranch(prs.map(snapshotPr)) }));
    } catch {
      badges.set(settleSlot(badges.get(), token, { ok: false, error: "" }));
    }
  }

  async function openDetail(oid: string, pr: PrSnapshot): Promise<void> {
    if (disposed) return;
    const ownedPr = snapshotPr(pr);
    const prNumber = ownedPr.number;
    prDetail = Object.freeze({ oid, pr: ownedPr });
    checkLog.set(clearSlot(checkLog.get()));
    if (ownedPr.ciStatus !== "failure") {
      checks.set(clearSlot(checks.get()));
      return;
    }
    const token = nextToken();
    checks.set(beginSlot(clearSlot(checks.get()), prNumber, token));
    try {
      const failed = await dependencies.failedChecks(repoPath, prNumber);
      checks.set(settleSlot(checks.get(), token, {
        ok: true,
        data: Object.freeze({ prNumber, checks: Object.freeze(failed.map(snapshotCheck)), error: null }),
      }));
    } catch (error) {
      checks.set(settleSlot(checks.get(), token, {
        ok: false,
        error: Object.freeze({
          prNumber,
          checks: Object.freeze([]),
          error: errorMessage(error, "Could not load failed checks"),
        }),
      }));
    }
  }

  function closeDetail(): void {
    prDetail = null;
    checks.set(clearSlot(checks.get()));
    checkLog.set(clearSlot(checkLog.get()));
  }

  async function openCheckLog(pr: PrSnapshot, check: FailedCiCheckSnapshot): Promise<void> {
    if (disposed || prDetail?.pr.number !== pr.number) return;
    const prNumber = pr.number;
    const ownedCheck = snapshotCheck(check);
    const token = nextToken();
    const loading: CiCheckLogState = Object.freeze({ prNumber, check: ownedCheck, result: null, error: null });
    checkLog.set(beginSlot(clearSlot(checkLog.get()), loading, token));
    try {
      const result = await dependencies.checkLog(repoPath, ownedCheck);
      checkLog.set(settleSlot(checkLog.get(), token, {
        ok: true,
        data: Object.freeze({ prNumber, check: ownedCheck, result: Object.freeze({ ...result }), error: null }),
      }));
    } catch (error) {
      checkLog.set(settleSlot(checkLog.get(), token, {
        ok: false,
        error: Object.freeze({
          prNumber,
          check: ownedCheck,
          result: null,
          error: errorMessage(error, "Could not load CI check log"),
        }),
      }));
    }
  }

  function closeCheckLog(): void {
    checkLog.set(clearSlot(checkLog.get()));
  }

  return {
    get prsByBranch(): ReadonlyMap<string, PrSnapshot> { return new Map(badgeData ?? []); },
    get prDetail() { return prDetail; },
    get failedCiChecks(): FailedCiChecksState | null { return checksView; },
    get failedCiChecksLoading() { return checksLoading; },
    get ciCheckLog(): CiCheckLogState | null { return checkLogView; },
    get actionBusy() { return !disposed && (contextBusy || mutation.busy); },
    get actionError() { return disposed ? null : contextError ?? mutation.error; },
    get actionResult() { return disposed ? null : mutation.result; },
    get actionUncertain() { return !disposed && mutation.uncertain; },
    performAction,
    prepareCreate,
    clearActionStatus(): void { if (!contextBusy) { contextError = null; mutation.clear(); } },
    reloadBadges,
    openDetail,
    closeDetail,
    openCheckLog,
    closeCheckLog,
    dispose(): void {
      disposed = true;
      unsubscribeMutation();
      badges.set(clearSlot(badges.get()));
      checks.set(clearSlot(checks.get()));
      checkLog.set(clearSlot(checkLog.get()));
      prDetail = null;
    },
  };
}

export type GitPrSession = ReturnType<typeof createGitPrSession>;
