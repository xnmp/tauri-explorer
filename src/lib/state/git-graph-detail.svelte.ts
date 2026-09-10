import {
  gitCommitFileDiff,
  gitCompareCommitFiles,
  gitCompareCommitFileDiff,
  type CommitFile,
} from "$lib/api/git-log";
import { gitDiff } from "$lib/api/git";
import { buildStageFiles, type StageSection } from "$lib/domain/commit-panel";
import { parseUnifiedDiff, type DiffHunk, type DiffLine, type ParsedDiff } from "$lib/domain/diff";
import {
  acceptsDetailLoad,
  closeCommitComparison,
  createCommitComparisonState,
  exitCommitComparison,
  selectComparisonCommit,
  startCommitComparison,
  type CommitComparison,
  type CommitComparisonState,
  type DetailLoad,
} from "$lib/domain/git-graph-comparison";
import { cachedCommitFiles } from "$lib/state/git-commit-files-cache";
import type { GraphCommit } from "$lib/state/git-graph-cache";
import { fetchGitSummary } from "$lib/state/git-summary-cache";

export const UNCOMMITTED_OID = "*";

export type DetailFile = Readonly<CommitFile & {
  staged?: boolean;
  section?: StageSection;
}>;
export type ParsedDiffSnapshot = Readonly<Omit<ParsedDiff, "lines" | "hunks"> & {
  lines: readonly Readonly<DiffLine>[];
  hunks: readonly Readonly<DiffHunk>[];
}>;
export interface DetailSelectionToken {
  readonly generation: number;
  readonly oid: string;
}
export type DetailComparison = Readonly<CommitComparison<GraphCommit>>;

export interface GitGraphDetailDependencies {
  commitFiles(repoPath: string, oid: string): Promise<CommitFile[]>;
  compareFiles(repoPath: string, olderOid: string, newerOid: string): Promise<CommitFile[]>;
  summary: typeof fetchGitSummary;
  workingDiff: typeof gitDiff;
  commitDiff: typeof gitCommitFileDiff;
  compareDiff: typeof gitCompareCommitFileDiff;
  parseDiff(text: string): ParsedDiff;
}

const snapshotFiles = (files: readonly DetailFile[]): readonly DetailFile[] =>
  Object.freeze(files.map((file) => Object.freeze({ ...file })));

const snapshotDiff = (diff: ParsedDiff): ParsedDiffSnapshot => Object.freeze({
  ...diff,
  lines: Object.freeze(diff.lines.map((line) => Object.freeze({ ...line }))),
  hunks: Object.freeze(diff.hunks.map((hunk) => Object.freeze({ ...hunk }))),
});

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const snapshotCommit = (commit: GraphCommit): GraphCommit => Object.freeze({
  ...commit,
  parents: Object.freeze([...commit.parents]),
});
const snapshotComparisonState = (
  state: CommitComparisonState<GraphCommit>,
): CommitComparisonState<GraphCommit> => Object.freeze({
  ...state,
  comparison: state.comparison ? Object.freeze({ ...state.comparison }) : null,
});

/** Owns one mounted graph's selected commit, comparison, file, and inline-diff lifetimes. */
export function createGitGraphDetail(
  repoPath: string,
  summaryConsumerId: string,
  dependencies: GitGraphDetailDependencies = {
    commitFiles: cachedCommitFiles,
    compareFiles: gitCompareCommitFiles,
    summary: fetchGitSummary,
    workingDiff: gitDiff,
    commitDiff: gitCommitFileDiff,
    compareDiff: gitCompareCommitFileDiff,
    parseDiff: parseUnifiedDiff,
  },
) {
  let comparisonState = $state.raw(snapshotComparisonState(createCommitComparisonState<GraphCommit>()));
  let files = $state.raw<readonly DetailFile[]>(Object.freeze([]));
  let openDiffIdentity = $state.raw<{ path: string; staged: boolean; generation: number } | null>(null);
  let openDiff = $state.raw<ParsedDiffSnapshot | null>(null);
  let diffLoading = $state(false);
  let diffError = $state<string | null>(null);
  let filesRequest = 0;
  let diffRequest = 0;
  let disposed = false;

  const clearDiff = () => {
    diffRequest += 1;
    openDiffIdentity = null;
    openDiff = null;
    diffLoading = false;
    diffError = null;
  };

  async function loadTransition(load: Exclude<DetailLoad<GraphCommit>, null>): Promise<void> {
    const request = ++filesRequest;
    try {
      let loaded: readonly DetailFile[];
      if (load.kind === "comparison") {
        loaded = await dependencies.compareFiles(repoPath, load.older.oid, load.newer.oid);
      } else if (load.commit.oid === UNCOMMITTED_OID) {
        const result = await dependencies.summary(repoPath, { consumerId: summaryConsumerId });
        if (!result.ok) throw new Error(result.error);
        loaded = buildStageFiles(result.data);
      } else {
        loaded = await dependencies.commitFiles(repoPath, load.commit.oid);
      }
      if (!disposed && filesRequest === request && acceptsDetailLoad(comparisonState, load)) {
        files = snapshotFiles(loaded);
      }
    } catch {
      if (!disposed && filesRequest === request && acceptsDetailLoad(comparisonState, load)) {
        files = Object.freeze([]);
      }
    }
  }

  async function select(commit: GraphCommit): Promise<void> {
    if (disposed) return;
    const transition = selectComparisonCommit(comparisonState, snapshotCommit(commit), UNCOMMITTED_OID);
    comparisonState = snapshotComparisonState(transition.state);
    if (!transition.clearFiles) return;
    filesRequest += 1;
    files = Object.freeze([]);
    clearDiff();
    if (transition.load) await loadTransition(transition.load);
  }

  function close(): void {
    comparisonState = snapshotComparisonState(closeCommitComparison(comparisonState).state);
    filesRequest += 1;
    files = Object.freeze([]);
    clearDiff();
  }

  function beginComparison(): void {
    if (disposed) return;
    const transition = startCommitComparison(comparisonState, UNCOMMITTED_OID);
    comparisonState = snapshotComparisonState(transition.state);
    if (!transition.clearFiles) return;
    filesRequest += 1;
    files = Object.freeze([]);
    clearDiff();
  }

  async function exitComparison(): Promise<void> {
    if (disposed) return;
    const transition = exitCommitComparison(comparisonState, UNCOMMITTED_OID);
    comparisonState = snapshotComparisonState(transition.state);
    filesRequest += 1;
    files = Object.freeze([]);
    clearDiff();
    if (transition.load?.kind === "normal") await loadTransition(transition.load);
  }

  const diffIsCurrent = (request: number, identity: NonNullable<typeof openDiffIdentity>) =>
    !disposed
    && diffRequest === request
    && openDiffIdentity === identity
    && comparisonState.generation === identity.generation;

  async function toggleDiff(file: DetailFile): Promise<string | null> {
    if (disposed || !comparisonState.selected) return null;
    const staged = file.staged === true;
    if (openDiffIdentity?.path === file.path && openDiffIdentity.staged === staged) {
      clearDiff();
      return null;
    }
    const selected = comparisonState.selected;
    const comparison = comparisonState.comparison;
    const identity = Object.freeze({ path: file.path, staged, generation: comparisonState.generation });
    const request = ++diffRequest;
    openDiffIdentity = identity;
    openDiff = null;
    diffError = null;
    diffLoading = true;
    try {
      let text: string;
      if (selected.oid === UNCOMMITTED_OID) {
        const result = await dependencies.workingDiff(repoPath, file.path, { staged });
        if (!result.ok) throw new Error(result.error);
        text = result.data;
      } else if (comparison) {
        text = await dependencies.compareDiff(repoPath, comparison.older.oid, comparison.newer.oid, file.path);
      } else {
        text = await dependencies.commitDiff(repoPath, selected.oid, file.path);
      }
      if (diffIsCurrent(request, identity)) openDiff = snapshotDiff(dependencies.parseDiff(text));
      return null;
    } catch (cause) {
      if (!diffIsCurrent(request, identity)) return null;
      const error = errorMessage(cause);
      diffError = error;
      diffLoading = false;
      openDiffIdentity = null;
      openDiff = null;
      return error;
    } finally {
      if (diffIsCurrent(request, identity)) diffLoading = false;
    }
  }

  function captureSelection(): DetailSelectionToken | null {
    const selected = comparisonState.selected;
    return selected ? Object.freeze({ generation: comparisonState.generation, oid: selected.oid }) : null;
  }

  const acceptsSelection = (token: DetailSelectionToken) =>
    comparisonState.generation === token.generation && comparisonState.selected?.oid === token.oid;

  async function refreshUncommittedFiles(expected = captureSelection()): Promise<boolean> {
    if (disposed || comparisonState.selected?.oid !== UNCOMMITTED_OID
      || comparisonState.first || comparisonState.comparison || !expected
      || !acceptsSelection(expected)) return false;
    // The accepted mutation has already changed the index/worktree. Its old
    // diff is invalid even when the same path and side remain in the summary.
    clearDiff();
    const generation = comparisonState.generation;
    const request = ++filesRequest;
    let result;
    try {
      result = await dependencies.summary(repoPath, { force: true, consumerId: summaryConsumerId });
    } catch {
      return false;
    }
    if (disposed || filesRequest !== request || comparisonState.generation !== generation
      || comparisonState.selected?.oid !== UNCOMMITTED_OID
      || comparisonState.first || comparisonState.comparison
      || !acceptsSelection(expected)) return false;
    if (!result.ok) return false;
    files = snapshotFiles(buildStageFiles(result.data));
    return true;
  }

  return {
    get selected() { return comparisonState.selected; },
    get comparisonFirst() { return comparisonState.first; },
    get comparison(): DetailComparison | null { return comparisonState.comparison; },
    get files() { return files; },
    get openDiffPath() { return openDiffIdentity?.path ?? null; },
    get openDiff() { return openDiff; },
    get diffLoading() { return diffLoading; },
    get diffError() { return diffError; },
    isDiffOpen(file: DetailFile) {
      return openDiffIdentity?.path === file.path && openDiffIdentity.staged === (file.staged === true);
    },
    select,
    close,
    beginComparison,
    exitComparison,
    toggleDiff,
    closeDiff: clearDiff,
    captureSelection,
    refreshUncommittedFiles,
    dispose(): void {
      disposed = true;
      close();
    },
  };
}

export type GitGraphDetail = ReturnType<typeof createGitGraphDetail>;
