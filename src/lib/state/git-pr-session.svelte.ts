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
  let prsByBranch = $state.raw<Map<string, PrSnapshot>>(new Map());
  let prDetail = $state.raw<{ readonly oid: string; readonly pr: PrSnapshot } | null>(null);
  let failedCiChecks = $state.raw<FailedCiChecksState | null>(null);
  let failedCiChecksLoading = $state(false);
  let ciCheckLog = $state.raw<CiCheckLogState | null>(null);
  let badgeRequest = 0;
  let checksRequest = 0;
  let logRequest = 0;
  let disposed = false;
  let actionBusy = $state(false);
  let actionError = $state<string | null>(null);
  let actionResult = $state.raw<{ action: PrAction["action"]; output: string; prNumber?: number } | null>(null);

  async function prepareCreate(expectedBranch: string): Promise<PrAction | null> {
    if (disposed || actionBusy) return null;
    actionBusy = true;
    actionError = null;
    actionResult = null;
    try {
      const context = await (dependencies.context ?? gitPrContext)(repoPath);
      if (disposed) return null;
      if (context.headBranch !== expectedBranch) throw new Error("Current branch changed; refresh the graph before creating a PR");
      return { action: "create", repoSlug: context.repoSlug, headBranch: expectedBranch, title: "", body: "", base: "" };
    } catch (error) {
      if (!disposed) actionError = extractError(error);
      return null;
    } finally {
      if (!disposed) actionBusy = false;
    }
  }

  async function performAction(request: PrAction): Promise<void> {
    if (disposed || actionBusy) return;
    actionBusy = true;
    actionError = null;
    actionResult = null;
    try {
      const output = await (dependencies.mutate ?? gitPrAction)(repoPath, request);
      if (disposed) return;
      actionResult = { action: request.action, output, prNumber: "prNumber" in request ? request.prNumber : undefined };
    } catch (error) {
      if (!disposed) actionError = extractError(error);
    } finally {
      if (!disposed) {
        await reloadBadges();
        if (prDetail) {
          const updated = [...prsByBranch.values()].find(pr => pr.number === prDetail?.pr.number);
          if (updated) prDetail = Object.freeze({ oid: prDetail.oid, pr: updated });
          else closeDetail();
        }
        actionBusy = false;
      }
    }
  }


  const detailIsCurrent = (request: number, prNumber: number) =>
    !disposed && checksRequest === request && prDetail?.pr.number === prNumber;

  async function reloadBadges(): Promise<void> {
    if (disposed) return;
    const request = ++badgeRequest;
    try {
      const prs = await dependencies.openPrs(repoPath);
      if (!disposed && badgeRequest === request) {
        prsByBranch = indexPrsByBranch(prs.map(snapshotPr));
      }
    } catch {
      if (!disposed && badgeRequest === request) prsByBranch = new Map();
    }
  }

  async function openDetail(oid: string, pr: PrSnapshot): Promise<void> {
    if (disposed) return;
    const ownedPr = snapshotPr(pr);
    const prNumber = ownedPr.number;
    prDetail = Object.freeze({ oid, pr: ownedPr });
    failedCiChecks = null;
    ciCheckLog = null;
    logRequest += 1;
    const request = ++checksRequest;
    if (ownedPr.ciStatus !== "failure") {
      failedCiChecksLoading = false;
      return;
    }
    failedCiChecksLoading = true;
    try {
      const checks = await dependencies.failedChecks(repoPath, prNumber);
      if (detailIsCurrent(request, prNumber)) {
        failedCiChecks = Object.freeze({
          prNumber,
          checks: Object.freeze(checks.map(snapshotCheck)),
          error: null,
        });
      }
    } catch (error) {
      if (detailIsCurrent(request, prNumber)) {
        failedCiChecks = Object.freeze({
          prNumber,
          checks: Object.freeze([]),
          error: errorMessage(error, "Could not load failed checks"),
        });
      }
    } finally {
      if (detailIsCurrent(request, prNumber)) failedCiChecksLoading = false;
    }
  }

  function closeDetail(): void {
    prDetail = null;
    failedCiChecks = null;
    failedCiChecksLoading = false;
    ciCheckLog = null;
    checksRequest += 1;
    logRequest += 1;
  }

  async function openCheckLog(pr: PrSnapshot, check: FailedCiCheckSnapshot): Promise<void> {
    if (disposed || prDetail?.pr.number !== pr.number) return;
    const prNumber = pr.number;
    const ownedCheck = snapshotCheck(check);
    const request = ++logRequest;
    ciCheckLog = Object.freeze({ prNumber, check: ownedCheck, result: null, error: null });
    try {
      const result = await dependencies.checkLog(repoPath, ownedCheck);
      if (!disposed && logRequest === request && prDetail?.pr.number === prNumber) {
        ciCheckLog = Object.freeze({
          prNumber,
          check: ownedCheck,
          result: Object.freeze({ ...result }),
          error: null,
        });
      }
    } catch (error) {
      if (!disposed && logRequest === request && prDetail?.pr.number === prNumber) {
        ciCheckLog = Object.freeze({
          prNumber,
          check: ownedCheck,
          result: null,
          error: errorMessage(error, "Could not load CI check log"),
        });
      }
    }
  }

  function closeCheckLog(): void {
    logRequest += 1;
    ciCheckLog = null;
  }

  return {
    get prsByBranch(): ReadonlyMap<string, PrSnapshot> { return new Map(prsByBranch); },
    get prDetail() { return prDetail; },
    get failedCiChecks() { return failedCiChecks; },
    get failedCiChecksLoading() { return failedCiChecksLoading; },
    get ciCheckLog() { return ciCheckLog; },
    get actionBusy() { return actionBusy; },
    get actionError() { return actionError; },
    get actionResult() { return actionResult; },
    performAction,
    prepareCreate,
    clearActionStatus(): void { if (!actionBusy) { actionError = null; actionResult = null; } },
    reloadBadges,
    openDetail,
    closeDetail,
    openCheckLog,
    closeCheckLog,
    dispose(): void {
      disposed = true;
      badgeRequest += 1;
      checksRequest += 1;
      logRequest += 1;
      prsByBranch = new Map();
      prDetail = null;
      failedCiChecks = null;
      failedCiChecksLoading = false;
      ciCheckLog = null;
    },
  };
}

export type GitPrSession = ReturnType<typeof createGitPrSession>;
