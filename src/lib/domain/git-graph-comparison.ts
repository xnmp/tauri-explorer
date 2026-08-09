/**
 * Pure detail-panel transitions for Git Graph commit comparison (#512).
 *
 * The component owns IPC and rendering; this module owns which commit detail
 * is current, whether a second comparison pick is pending, and the generation
 * that makes an older asynchronous response stale.
 */
export interface ComparisonCommit {
  oid: string;
  author_time: number;
}

export interface CommitComparison<T extends ComparisonCommit> {
  older: T;
  newer: T;
}

export interface CommitComparisonState<T extends ComparisonCommit> {
  selected: T | null;
  first: T | null;
  comparison: CommitComparison<T> | null;
  generation: number;
}

export type DetailLoad<T extends ComparisonCommit> =
  | { kind: "normal"; commit: T; generation: number }
  | { kind: "comparison"; older: T; newer: T; generation: number }
  | null;

export interface ComparisonTransition<T extends ComparisonCommit> {
  state: CommitComparisonState<T>;
  load: DetailLoad<T>;
  clearFiles: boolean;
}

export function createCommitComparisonState<T extends ComparisonCommit>(): CommitComparisonState<T> {
  return { selected: null, first: null, comparison: null, generation: 0 };
}

function chronological<T extends ComparisonCommit>(a: T, b: T): CommitComparison<T> {
  if (a.author_time !== b.author_time) return a.author_time < b.author_time ? { older: a, newer: b } : { older: b, newer: a };
  return a.oid < b.oid ? { older: a, newer: b } : { older: b, newer: a };
}

function clear<T extends ComparisonCommit>(state: CommitComparisonState<T>): CommitComparisonState<T> {
  return { selected: null, first: null, comparison: null, generation: state.generation + 1 };
}

/** Close the detail panel and invalidate every pending detail request. */
export function closeCommitComparison<T extends ComparisonCommit>(state: CommitComparisonState<T>): ComparisonTransition<T> {
  return { state: clear(state), load: null, clearFiles: true };
}

/** Begin choosing a second commit. Synthetic working-tree rows cannot compare. */
export function startCommitComparison<T extends ComparisonCommit>(
  state: CommitComparisonState<T>,
  uncommittedOid: string,
): ComparisonTransition<T> {
  if (!state.selected || state.selected.oid === uncommittedOid) return { state, load: null, clearFiles: false };
  return {
    state: { selected: state.selected, first: state.selected, comparison: null, generation: state.generation + 1 },
    load: null,
    clearFiles: true,
  };
}

/** Select a normal detail commit or finish the pending comparison pair. */
export function selectComparisonCommit<T extends ComparisonCommit>(
  state: CommitComparisonState<T>,
  commit: T,
  uncommittedOid: string,
): ComparisonTransition<T> {
  if (state.first) {
    if (commit.oid === state.first.oid || commit.oid === uncommittedOid) return { state, load: null, clearFiles: false };
    const comparison = chronological(state.first, commit);
    const next = { selected: comparison.newer, first: null, comparison, generation: state.generation + 1 };
    return { state: next, load: { kind: "comparison", ...comparison, generation: next.generation }, clearFiles: true };
  }
  if (state.selected?.oid === commit.oid) return closeCommitComparison(state);
  const next = { selected: commit, first: null, comparison: null, generation: state.generation + 1 };
  return { state: next, load: { kind: "normal", commit, generation: next.generation }, clearFiles: true };
}

/** Cancel a pending pick or leave a completed comparison at its newer commit. */
export function exitCommitComparison<T extends ComparisonCommit>(
  state: CommitComparisonState<T>,
  uncommittedOid: string,
): ComparisonTransition<T> {
  const selected = state.selected;
  const next = { selected, first: null, comparison: null, generation: state.generation + 1 };
  if (!selected || selected.oid === uncommittedOid) return { state: next, load: null, clearFiles: true };
  return { state: next, load: { kind: "normal", commit: selected, generation: next.generation }, clearFiles: true };
}

/** True only while an asynchronous load still belongs to the current detail. */
export function acceptsDetailLoad<T extends ComparisonCommit>(
  state: CommitComparisonState<T>,
  load: Exclude<DetailLoad<T>, null>,
): boolean {
  if (state.generation !== load.generation) return false;
  if (load.kind === "normal") return state.selected?.oid === load.commit.oid && state.comparison === null && state.first === null;
  return state.comparison?.older.oid === load.older.oid && state.comparison.newer.oid === load.newer.oid;
}
