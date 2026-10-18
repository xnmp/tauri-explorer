import {
  gitBranchAuthors,
  gitRefs,
  gitMergeBase,
  type MergeBaseBranch,
  type BranchAuthor,
  type GitRefs,
} from "$lib/api/git-log";
import type { BranchListEntry } from "$lib/domain/git-graph";

export interface GitGraphBranchesDependencies {
  refs(repoPath: string): Promise<GitRefs>;
  branchAuthors(repoPath: string): Promise<BranchAuthor[]>;
  mergeBase?: typeof gitMergeBase;
}

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

const snapshotBranches = (refs: GitRefs): readonly Readonly<BranchListEntry>[] =>
  Object.freeze([
    ...refs.local_branches.map(({ name }) => Object.freeze({ name, remote: false })),
    ...refs.remote_branches.map(({ name }) => Object.freeze({ name, remote: true })),
  ]);

const snapshotAuthors = (values: readonly BranchAuthor[]): ReadonlyMap<string, string> =>
  new Map(values.map(({ name, author }) => [name, author]));

type RefsResult =
  | { ok: true }
  | { ok: false; error: string; superseded: boolean };

/** Owns one mounted graph's branch-filter metadata requests and lazy cache. */
export function createGitGraphBranches(
  repoPath: string,
  dependencies: GitGraphBranchesDependencies = {
    refs: gitRefs,
    branchAuthors: gitBranchAuthors,
  },
) {
  let branches = $state.raw<readonly Readonly<BranchListEntry>[]>(Object.freeze([]));
  let authors = $state.raw<ReadonlyMap<string, string>>(new Map());
  let known = $state(false);
  let popoverLoaded = $state(false);
  let popoverLoading = $state(false);
  let popoverError = $state<string | null>(null);
  let refsRequest = 0;
  let refsEpoch = 0;
  let latestRefs: { request: number; result: Promise<RefsResult> } | null = null;
  let authorsRequest = 0;
  let popoverRequest = 0;
  let disposed = false;
  let mergeBaseRequest = 0;
  let mergeBaseBusy = $state(false);
  let mergeBaseError = $state<string | null>(null);
  let mergeBaseResult = $state<{ first: string; second: string; oid: string } | null>(null);

  function cancelMergeBase(): void {
    mergeBaseRequest += 1;
    mergeBaseBusy = false;
    mergeBaseError = null;
    mergeBaseResult = null;
  }

  async function jumpToMergeBase(
    first: MergeBaseBranch, second: MergeBaseBranch,
    reveal: (oid: string, isCurrent: () => boolean) => Promise<boolean>,
    /** Runs synchronously once the lookup is accepted, before any await. The
     *  owner retires pending work whose later reload would cancel this lookup
     *  (a debounced path-filter reload, #1281). */
    onStart?: () => void,
    /** Runs when this lookup finishes still current; `revealed` is whether the
     *  fork point was selected. Superseded lookups never call it. */
    onSettled?: (revealed: boolean) => void,
  ): Promise<void> {
    if (disposed || mergeBaseBusy || (first.name === second.name && first.remote === second.remote)) return;
    const request = ++mergeBaseRequest;
    const current = () => !disposed && request === mergeBaseRequest;
    onStart?.();
    mergeBaseBusy = true;
    mergeBaseError = null;
    mergeBaseResult = null;
    try {
      const oid = await (dependencies.mergeBase ?? gitMergeBase)(repoPath, first, second);
      if (!current()) return;
      if (!oid) {
        mergeBaseError = "These branches have no common ancestor";
      } else {
        const revealed = await reveal(oid, current);
        if (current()) {
          if (revealed) mergeBaseResult = { first: first.name, second: second.name, oid };
          else mergeBaseError = "Could not reveal the merge-base; history changed or is incomplete. Try again.";
        }
      }
    } catch (cause) {
      if (current()) mergeBaseError = message(cause, "Could not find the merge-base");
    } finally {
      if (current()) {
        mergeBaseBusy = false;
        onSettled?.(mergeBaseResult !== null);
      }
    }
  }

  function requestRefs(): Promise<RefsResult> {
    const request = ++refsRequest;
    const epoch = refsEpoch;
    const result = (async (): Promise<RefsResult> => {
      try {
        const refs = await dependencies.refs(repoPath);
        if (!disposed && refsEpoch === epoch && refsRequest === request) {
          branches = snapshotBranches(refs);
          known = true;
          return { ok: true };
        }
        return { ok: false, error: "Branch metadata request was superseded", superseded: true };
      } catch (cause) {
        if (disposed || refsEpoch !== epoch || refsRequest !== request) {
          return { ok: false, error: "Branch metadata request was superseded", superseded: true };
        }
        return {
          ok: false,
          error: message(cause, "Could not load branches"),
          superseded: false,
        };
      }
    })();
    latestRefs = { request, result };
    return result;
  }

  async function settleCurrentRefs(result: RefsResult): Promise<RefsResult> {
    while (!result.ok && result.superseded && !disposed) {
      const replacement = latestRefs;
      if (!replacement) break;
      result = await replacement.result;
      if (latestRefs?.request === replacement.request && !result.ok && result.superseded) break;
    }
    return result;
  }

  async function refreshForQuery(): Promise<void> {
    if (disposed) return;
    const result = await settleCurrentRefs(await requestRefs());
    if (!result.ok && (!known || result.superseded) && !disposed) throw new Error(result.error);
  }

  async function requestAuthors(): Promise<{ ok: true } | { ok: false; error: string }> {
    const request = ++authorsRequest;
    try {
      const result = await dependencies.branchAuthors(repoPath);
      if (!disposed && authorsRequest === request) authors = snapshotAuthors(result);
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: message(cause, "Could not load branch authors") };
    }
  }

  async function loadForPopover(): Promise<void> {
    if (disposed || popoverLoaded || popoverLoading) return;
    const request = ++popoverRequest;
    popoverLoading = true;
    popoverError = null;
    const [refsResult, authorsResult] = await Promise.all([
      requestRefs().then(settleCurrentRefs),
      requestAuthors(),
    ]);
    if (disposed || popoverRequest !== request) return;
    const errors = [refsResult, authorsResult]
      .flatMap((result) => result.ok ? [] : [result.error]);
    popoverError = errors.length > 0 ? errors.join("; ") : null;
    popoverLoaded = errors.length === 0;
    popoverLoading = false;
  }

  function invalidate(): void {
    if (disposed) return;
    popoverRequest += 1;
    authorsRequest += 1;
    refsEpoch += 1;
    popoverLoaded = false;
    popoverLoading = false;
    popoverError = null;
  }

  return {
    get mergeBaseBusy() { return mergeBaseBusy; },
    get mergeBaseError() { return mergeBaseError; },
    get mergeBaseResult() { return mergeBaseResult; },
    jumpToMergeBase,
    cancelMergeBase,
    get branches(): readonly Readonly<BranchListEntry>[] { return branches; },
    get authors(): ReadonlyMap<string, string> { return new Map(authors); },
    get hasKnownBranches(): boolean { return known; },
    get popoverLoaded(): boolean { return popoverLoaded; },
    get popoverLoading(): boolean { return popoverLoading; },
    get popoverError(): string | null { return popoverError; },
    refreshForQuery,
    loadForPopover,
    invalidate,
    dispose(): void {
      cancelMergeBase();
      disposed = true;
      refsRequest += 1;
      refsEpoch += 1;
      latestRefs = null;
      authorsRequest += 1;
      popoverRequest += 1;
      branches = Object.freeze([]);
      authors = new Map();
      known = false;
      popoverLoaded = false;
      popoverLoading = false;
      popoverError = null;
    },
  };
}

export type GitGraphBranches = ReturnType<typeof createGitGraphBranches>;
