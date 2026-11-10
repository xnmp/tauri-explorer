/**
 * Preview diff loading: the working-tree diff of the SCM store's open file
 * and the commit / comparison file diff routed from the git graph (#366).
 *
 * One request generation owns `parsed` / `loading` / `error`, so a superseded
 * response never lands. A redundant reload of the working-tree target already
 * in flight is dropped (UNC repos are polled every 3s and each poll replaces
 * the summary the caller tracks, #387 / #396), and re-checking the diff
 * already shown never blanks it.
 */

import { parseUnifiedDiff, type ParsedDiff } from "$lib/domain/diff";
import type { ApiResult } from "$lib/api/common";

export interface CommitDiffTarget {
  repoPath: string;
  oid: string;
  path: string;
  baseOid?: string;
}

export interface PreviewDiffDeps {
  /** The store's live targets, re-read after each fetch to drop stale responses. */
  current: () => {
    activeDiff: { path: string; staged: boolean } | null;
    commitDiff: CommitDiffTarget | null;
  };
  workingDiff: (repoRoot: string, path: string, staged: boolean) => Promise<ApiResult<string>>;
  commitFileDiff: (repoPath: string, oid: string, path: string) => Promise<string>;
  compareCommitFileDiff: (repoPath: string, baseOid: string, oid: string, path: string) => Promise<string>;
}

export function createPreviewDiff(deps: PreviewDiffDeps) {
  let parsed = $state<ParsedDiff | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let requestGen = 0;
  // The target currently being fetched, and the one `parsed` belongs to,
  // both as `${repoRoot}|${path}|${staged}` (repo included: the pane and
  // sidebar stores can sit on different repos that share a relative path).
  let inFlight: string | null = null;
  let renderedTarget: string | null = null;

  /** No diff is open: invalidate any in-flight request and show nothing. */
  function clear(): void {
    requestGen++;
    inFlight = null;
    renderedTarget = null;
    parsed = null;
    error = null;
    loading = false;
  }

  /** Load a commit file diff for the graph-routed target (#366). */
  async function loadCommit(target: CommitDiffTarget): Promise<void> {
    const gen = ++requestGen;
    // `parsed` is about to hold a COMMIT diff — the working-tree render
    // cache must not claim it, or reopening that target would briefly show
    // the commit's hunks under a working-tree badge.
    renderedTarget = null;
    inFlight = null;
    loading = true;
    error = null;
    try {
      const text = target.baseOid
        ? await deps.compareCommitFileDiff(target.repoPath, target.baseOid, target.oid, target.path)
        : await deps.commitFileDiff(target.repoPath, target.oid, target.path);
      if (gen !== requestGen || deps.current().commitDiff !== target) return;
      parsed = parseUnifiedDiff(text);
    } catch (err) {
      if (gen !== requestGen) return;
      error = err instanceof Error ? err.message : String(err);
      parsed = null;
    } finally {
      if (gen === requestGen) loading = false;
    }
  }

  async function load(repoRoot: string, path: string, staged: boolean): Promise<void> {
    const target = `${repoRoot}|${path}|${staged}`;
    // A redundant reload of a target we're already loading is dropped: over
    // a slow share a superseding re-run would never land (#396).
    if (inFlight === target) return;
    inFlight = target;
    const gen = ++requestGen;
    // Re-checking the diff we're already showing must not blank it — that's the
    // flash. A different target must, or the old file's diff would linger under
    // the new file's header.
    if (renderedTarget !== target) {
      parsed = null;
      loading = true;
    }
    error = null;
    try {
      const r = await deps.workingDiff(repoRoot, path, staged);
      // Drop stale responses: a newer request superseded this one, or the
      // target (path OR staged flag) changed while we were fetching.
      if (gen !== requestGen) return;
      const current = deps.current().activeDiff;
      if (!current || current.path !== path || current.staged !== staged) return;
      if (!r.ok) {
        error = r.error;
        parsed = null;
        renderedTarget = null;
      } else {
        parsed = parseUnifiedDiff(r.data);
        renderedTarget = target;
      }
      loading = false;
    } finally {
      // Always release the target, and never leave a superseded request's
      // spinner up: the winning request owns `loading` from here.
      if (inFlight === target) inFlight = null;
      if (gen === requestGen) loading = false;
    }
  }

  return {
    get parsed() { return parsed; },
    get loading() { return loading; },
    get error() { return error; },
    clear,
    loadCommit,
    load,
  };
}

export type PreviewDiff = ReturnType<typeof createPreviewDiff>;
