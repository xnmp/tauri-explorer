/**
 * Inline commit-panel domain (#466).
 *
 * Pure, framework-free state machine + derivations for the git graph's
 * uncommitted-changes node panel:
 *   - stage-status grouping of working-tree files (merge / staged / unstaged /
 *     untracked), mirroring the SCM sidebar's section semantics and keifu's
 *     `build_staged_unstaged_items` ordering;
 *   - commit-button enablement + label (with the staged count surfaced);
 *   - the ephemeral commit-message editor's transitions (idle → committing →
 *     idle), with the typed message preserved on failure and cleared on
 *     success.
 *
 * Kept importable and unit-tested in isolation so the panel's logic never
 * lives only inside a `.svelte` component (#444).
 */

import { gitStatusLetter } from "./git";

export type StageSection = "merge" | "staged" | "unstaged" | "untracked";

/** A working-tree file row, tagged with the index side it sits on. */
export interface StageFile {
  path: string;
  /** Porcelain-style status letter (A / M / D / R / …). */
  status: string;
  section: StageSection;
  /** True iff the file is in the index (staged section). Drives which per-row
   *  action (unstage vs stage) shows, and the diff side to load. */
  staged: boolean;
}

export interface StageGroup {
  section: StageSection;
  label: string;
  files: StageFile[];
}

/** Minimal shape of a status entry as delivered by `git_status`. */
export interface StatusEntryLike {
  path: string;
  /** Status code ("Modified", "Added", …); resolved to a letter here. */
  status: string;
}

/** The four working-tree buckets from `git_status`. */
export interface StatusBucketsLike {
  staged: StatusEntryLike[];
  changes: StatusEntryLike[];
  merge: StatusEntryLike[];
  untracked: StatusEntryLike[];
}

const SECTION_LABELS: Record<StageSection, string> = {
  merge: "Merge Changes",
  staged: "Staged Changes",
  unstaged: "Changes",
  untracked: "Untracked",
};

const SECTION_ORDER: readonly StageSection[] = ["merge", "staged", "unstaged", "untracked"];

/**
 * Flatten the status buckets into an ordered file list: merge first (needs the
 * most attention), then staged, then unstaged changes, then untracked —
 * matching keifu's `build_staged_unstaged_items` ordering and the SCM
 * sidebar's section order.
 *
 * A partially-staged file (staged edits plus further working-tree edits)
 * legitimately appears twice: once in `staged` (staged=true) and once in
 * `changes` (staged=false), exactly as the backend classifies it.
 */
export function buildStageFiles(buckets: StatusBucketsLike): StageFile[] {
  const toFile =
    (section: StageSection, staged: boolean) =>
    (e: StatusEntryLike): StageFile => ({
      path: e.path,
      status: gitStatusLetter(e.status),
      section,
      staged,
    });
  return [
    ...buckets.merge.map(toFile("merge", false)),
    ...buckets.staged.map(toFile("staged", true)),
    ...buckets.changes.map(toFile("unstaged", false)),
    ...buckets.untracked.map(toFile("untracked", false)),
  ];
}

/** Group a flat stage-file list into labelled sections, omitting empty ones. */
export function groupStageFiles(files: StageFile[]): StageGroup[] {
  return SECTION_ORDER.map((section) => ({
    section,
    label: SECTION_LABELS[section],
    files: files.filter((f) => f.section === section),
  })).filter((g) => g.files.length > 0);
}

/** Number of files in the index (what a commit would include). */
export function stagedCountOf(files: StageFile[]): number {
  return files.reduce((n, f) => (f.section === "staged" ? n + 1 : n), 0);
}

/** Number of unresolved merge-conflict files (git refuses to commit these). */
export function conflictCountOf(files: StageFile[]): number {
  return files.reduce((n, f) => (f.section === "merge" ? n + 1 : n), 0);
}

/** Paths not in the index (stage-all candidates), de-duplicated. */
export function unstagedPaths(files: StageFile[]): string[] {
  return Array.from(new Set(files.filter((f) => !f.staged).map((f) => f.path)));
}

/** Paths currently in the index (unstage-all candidates), de-duplicated. */
export function stagedPaths(files: StageFile[]): string[] {
  return Array.from(new Set(files.filter((f) => f.section === "staged").map((f) => f.path)));
}

/**
 * Whether a commit may proceed: a non-whitespace message, at least one staged
 * file, and no unresolved merge conflicts.
 */
export function canCommit(input: {
  message: string;
  stagedCount: number;
  conflictCount: number;
}): boolean {
  return (
    input.message.trim().length > 0 && input.stagedCount > 0 && input.conflictCount === 0
  );
}

/** Button label, surfacing the staged count so the user sees what will land. */
export function commitButtonLabel(stagedCount: number): string {
  return stagedCount > 0 ? `Commit (${stagedCount})` : "Commit";
}

// ── Commit-message editor state machine ──────────────────────────────────

export type CommitPhase = "idle" | "committing";

export interface CommitPanelState {
  message: string;
  phase: CommitPhase;
  error: string | null;
}

export function initialCommitPanelState(): CommitPanelState {
  return { message: "", phase: "idle", error: null };
}

/** Edit the draft message; clears a stale error once the user types something. */
export function setMessage(state: CommitPanelState, message: string): CommitPanelState {
  return {
    ...state,
    message,
    error: state.error && message.trim().length > 0 ? null : state.error,
  };
}

/**
 * Enter the in-flight commit phase. No-op when already committing (guards a
 * double submit), so callers can gate their async work on the returned phase.
 */
export function startCommit(state: CommitPanelState): CommitPanelState {
  if (state.phase === "committing") return state;
  return { ...state, phase: "committing", error: null };
}

/** Commit landed: clear the draft and return to idle. */
export function commitSucceeded(_state: CommitPanelState): CommitPanelState {
  return initialCommitPanelState();
}

/** Commit failed: preserve the typed message, surface the error, return idle. */
export function commitFailed(state: CommitPanelState, error: string): CommitPanelState {
  return { ...state, phase: "idle", error };
}
