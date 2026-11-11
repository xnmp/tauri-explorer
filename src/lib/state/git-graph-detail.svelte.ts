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
import {
  beginSlot, clearSlot, idleSlot, isSlotCurrent, isSlotLoading, settleSlot, slotData,
  type Slot, type SlotOutcome,
} from "$lib/domain/request-slot";
import { createSlotCell } from "$lib/state/slot-cell.svelte";
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
interface DiffIdentity {
  readonly path: string;
  readonly staged: boolean;
  readonly generation: number;
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

const NO_FILES: readonly DetailFile[] = Object.freeze([]);
/** The file whose diff is open: loading or shown. A failed diff is closed. */
const openIdentity = (slot: Slot<ParsedDiffSnapshot, DiffIdentity>): DiffIdentity | null =>
  slot.kind === "loading" || slot.kind === "ready" ? slot.key : null;
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
  // Files and the inline diff are latest-request-wins slots (#1569); tokens
  // come from one counter. A diff's key is the file it shows: loading/ready
  // diffs are open, and a failure closes it while reporting its error.
  const filesSlot = createSlotCell<Slot<readonly DetailFile[]>>(idleSlot());
  const diffSlot = createSlotCell<Slot<ParsedDiffSnapshot, DiffIdentity>>(idleSlot());
  const filesView = $derived(slotData(filesSlot.view()) ?? NO_FILES);
  const openDiffIdentity = $derived(openIdentity(diffSlot.view()));
  const openDiff = $derived(slotData(diffSlot.view()) ?? null);
  const diffLoading = $derived(isSlotLoading(diffSlot.view()));
  const diffError = $derived.by(() => {
    const slot = diffSlot.view();
    return slot.kind === "failed" ? slot.error : null;
  });
  let tokens = 0;
  let disposed = false;

  const clearFiles = () => filesSlot.set(clearSlot(filesSlot.get()));
  const clearDiff = () => diffSlot.set(clearSlot(diffSlot.get()));

  async function loadTransition(load: Exclude<DetailLoad<GraphCommit>, null>): Promise<void> {
    const token = ++tokens;
    filesSlot.set(beginSlot(filesSlot.get(), undefined, token));
    let outcome: SlotOutcome<readonly DetailFile[]>;
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
      outcome = { ok: true, data: snapshotFiles(loaded) };
    } catch (cause) {
      outcome = { ok: false, error: errorMessage(cause) };
    }
    if (acceptsDetailLoad(comparisonState, load)) filesSlot.set(settleSlot(filesSlot.get(), token, outcome));
  }

  async function select(commit: GraphCommit): Promise<void> {
    if (disposed) return;
    const transition = selectComparisonCommit(comparisonState, snapshotCommit(commit), UNCOMMITTED_OID);
    comparisonState = snapshotComparisonState(transition.state);
    if (!transition.clearFiles) return;
    clearFiles();
    clearDiff();
    if (transition.load) await loadTransition(transition.load);
  }

  function close(): void {
    comparisonState = snapshotComparisonState(closeCommitComparison(comparisonState).state);
    clearFiles();
    clearDiff();
  }

  function beginComparison(): void {
    if (disposed) return;
    const transition = startCommitComparison(comparisonState, UNCOMMITTED_OID);
    comparisonState = snapshotComparisonState(transition.state);
    if (!transition.clearFiles) return;
    clearFiles();
    clearDiff();
  }

  async function exitComparison(): Promise<void> {
    if (disposed) return;
    const transition = exitCommitComparison(comparisonState, UNCOMMITTED_OID);
    comparisonState = snapshotComparisonState(transition.state);
    clearFiles();
    clearDiff();
    if (transition.load?.kind === "normal") await loadTransition(transition.load);
  }

  /** Settles the diff for `token` unless the detail it was opened for has gone. */
  const settleDiff = (token: number, identity: DiffIdentity, outcome: SlotOutcome<ParsedDiffSnapshot>): boolean => {
    if (comparisonState.generation !== identity.generation) return false;
    const before = diffSlot.get();
    diffSlot.set(settleSlot(before, token, outcome));
    return diffSlot.get() !== before;
  };

  async function toggleDiff(file: DetailFile): Promise<string | null> {
    if (disposed || !comparisonState.selected) return null;
    const staged = file.staged === true;
    const open = openIdentity(diffSlot.get());
    if (open?.path === file.path && open.staged === staged) {
      clearDiff();
      return null;
    }
    const selected = comparisonState.selected;
    const comparison = comparisonState.comparison;
    const identity: DiffIdentity = Object.freeze({ path: file.path, staged, generation: comparisonState.generation });
    const token = ++tokens;
    // A newly opened diff never shows the previous file's lines while it loads.
    diffSlot.set(beginSlot(idleSlot(), identity, token));
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
      if (comparisonState.generation !== identity.generation || !isSlotCurrent(diffSlot.get(), token)) return null;
      settleDiff(token, identity, { ok: true, data: snapshotDiff(dependencies.parseDiff(text)) });
      return null;
    } catch (cause) {
      const error = errorMessage(cause);
      return settleDiff(token, identity, { ok: false, error }) ? error : null;
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
    const token = ++tokens;
    // The files already shown stay visible while the forced scan runs.
    filesSlot.set(beginSlot(filesSlot.get(), undefined, token));
    let result;
    try {
      result = await dependencies.summary(repoPath, { force: true, consumerId: summaryConsumerId });
    } catch (cause) {
      filesSlot.set(settleSlot(filesSlot.get(), token, { ok: false, error: errorMessage(cause), keepPrevious: true }));
      return false;
    }
    if (!isSlotCurrent(filesSlot.get(), token) || comparisonState.generation !== generation
      || comparisonState.selected?.oid !== UNCOMMITTED_OID
      || comparisonState.first || comparisonState.comparison
      || !acceptsSelection(expected)) return false;
    if (!result.ok) {
      filesSlot.set(settleSlot(filesSlot.get(), token, { ok: false, error: result.error, keepPrevious: true }));
      return false;
    }
    filesSlot.set(settleSlot(filesSlot.get(), token, { ok: true, data: snapshotFiles(buildStageFiles(result.data)) }));
    return true;
  }

  return {
    get selected() { return comparisonState.selected; },
    get comparisonFirst() { return comparisonState.first; },
    get comparison(): DetailComparison | null { return comparisonState.comparison; },
    get files() { return filesView; },
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
