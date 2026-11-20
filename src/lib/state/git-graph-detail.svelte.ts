import { gitCommitFileDiff, type CommitFile } from "$lib/api/git-log";
import { gitDiff } from "$lib/api/git";
import { buildStageFiles, type StageSection } from "$lib/domain/commit-panel";
import { parseUnifiedDiff, type DiffHunk, type DiffLine, type ParsedDiff } from "$lib/domain/diff";
import {
  acceptsDetailLoad,
  closeDetailSelection,
  createDetailSelection,
  selectDetailCommit,
  type DetailLoad,
  type DetailSelection,
} from "$lib/domain/git-graph-selection";
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

export interface GitGraphDetailDependencies {
  commitFiles(repoPath: string, oid: string): Promise<CommitFile[]>;
  summary: typeof fetchGitSummary;
  workingDiff: typeof gitDiff;
  commitDiff: typeof gitCommitFileDiff;
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
const snapshotSelection = (
  state: DetailSelection<GraphCommit>,
): DetailSelection<GraphCommit> => Object.freeze({ ...state });

/** Owns one mounted graph's selected commit, file, and inline-diff lifetimes. */
export function createGitGraphDetail(
  repoPath: string,
  summaryConsumerId: string,
  dependencies: GitGraphDetailDependencies = {
    commitFiles: cachedCommitFiles,
    summary: fetchGitSummary,
    workingDiff: gitDiff,
    commitDiff: gitCommitFileDiff,
    parseDiff: parseUnifiedDiff,
  },
) {
  let selection = $state.raw(snapshotSelection(createDetailSelection<GraphCommit>()));
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

  async function loadSelection(load: DetailLoad<GraphCommit>): Promise<void> {
    const token = ++tokens;
    filesSlot.set(beginSlot(filesSlot.get(), undefined, token));
    let outcome: SlotOutcome<readonly DetailFile[]>;
    try {
      let loaded: readonly DetailFile[];
      if (load.commit.oid === UNCOMMITTED_OID) {
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
    if (acceptsDetailLoad(selection, load)) filesSlot.set(settleSlot(filesSlot.get(), token, outcome));
  }

  async function select(commit: GraphCommit): Promise<void> {
    if (disposed) return;
    const transition = selectDetailCommit(selection, snapshotCommit(commit));
    selection = snapshotSelection(transition.state);
    clearFiles();
    clearDiff();
    if (transition.load) await loadSelection(transition.load);
  }

  function close(): void {
    selection = snapshotSelection(closeDetailSelection(selection));
    clearFiles();
    clearDiff();
  }

  /** Settles the diff for `token` unless the detail it was opened for has gone. */
  const settleDiff = (token: number, identity: DiffIdentity, outcome: SlotOutcome<ParsedDiffSnapshot>): boolean => {
    if (selection.generation !== identity.generation) return false;
    const before = diffSlot.get();
    diffSlot.set(settleSlot(before, token, outcome));
    return diffSlot.get() !== before;
  };

  async function toggleDiff(file: DetailFile): Promise<string | null> {
    if (disposed || !selection.selected) return null;
    const staged = file.staged === true;
    const open = openIdentity(diffSlot.get());
    if (open?.path === file.path && open.staged === staged) {
      clearDiff();
      return null;
    }
    const selected = selection.selected;
    const identity: DiffIdentity = Object.freeze({ path: file.path, staged, generation: selection.generation });
    const token = ++tokens;
    // A newly opened diff never shows the previous file's lines while it loads.
    diffSlot.set(beginSlot(idleSlot(), identity, token));
    try {
      let text: string;
      if (selected.oid === UNCOMMITTED_OID) {
        const result = await dependencies.workingDiff(repoPath, file.path, { staged });
        if (!result.ok) throw new Error(result.error);
        text = result.data;
      } else {
        text = await dependencies.commitDiff(repoPath, selected.oid, file.path);
      }
      if (selection.generation !== identity.generation || !isSlotCurrent(diffSlot.get(), token)) return null;
      settleDiff(token, identity, { ok: true, data: snapshotDiff(dependencies.parseDiff(text)) });
      return null;
    } catch (cause) {
      const error = errorMessage(cause);
      return settleDiff(token, identity, { ok: false, error }) ? error : null;
    }
  }

  function captureSelection(): DetailSelectionToken | null {
    const selected = selection.selected;
    return selected ? Object.freeze({ generation: selection.generation, oid: selected.oid }) : null;
  }

  const acceptsSelection = (token: DetailSelectionToken) =>
    selection.generation === token.generation && selection.selected?.oid === token.oid;

  async function refreshUncommittedFiles(expected = captureSelection()): Promise<boolean> {
    if (disposed || selection.selected?.oid !== UNCOMMITTED_OID || !expected
      || !acceptsSelection(expected)) return false;
    // The accepted mutation has already changed the index/worktree. Its old
    // diff is invalid even when the same path and side remain in the summary.
    clearDiff();
    const generation = selection.generation;
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
    if (!isSlotCurrent(filesSlot.get(), token) || selection.generation !== generation
      || selection.selected?.oid !== UNCOMMITTED_OID
      || !acceptsSelection(expected)) return false;
    if (!result.ok) {
      filesSlot.set(settleSlot(filesSlot.get(), token, { ok: false, error: result.error, keepPrevious: true }));
      return false;
    }
    filesSlot.set(settleSlot(filesSlot.get(), token, { ok: true, data: snapshotFiles(buildStageFiles(result.data)) }));
    return true;
  }

  return {
    get selected() { return selection.selected; },
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
