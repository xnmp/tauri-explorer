/**
 * Pure selection transitions for the Git Graph commit detail panel.
 *
 * The detail session owns IPC and rendering; this module owns which commit's
 * detail is current and the generation that makes an older asynchronous
 * response stale. Every transition advances the generation, so a response
 * started for an earlier selection can never land on a later one, even when
 * the same commit is selected again.
 */
export interface SelectableCommit {
  oid: string;
}

export interface DetailSelection<T extends SelectableCommit> {
  selected: T | null;
  generation: number;
}

/** An asynchronous detail load, bound to the selection that started it. */
export interface DetailLoad<T extends SelectableCommit> {
  commit: T;
  generation: number;
}

export interface SelectionTransition<T extends SelectableCommit> {
  state: DetailSelection<T>;
  /** The load the new selection needs, or null when the detail closed. */
  load: DetailLoad<T> | null;
}

export function createDetailSelection<T extends SelectableCommit>(): DetailSelection<T> {
  return { selected: null, generation: 0 };
}

/** Close the detail panel and invalidate every pending detail request. */
export function closeDetailSelection<T extends SelectableCommit>(state: DetailSelection<T>): DetailSelection<T> {
  return { selected: null, generation: state.generation + 1 };
}

/** Select a commit's detail; selecting the open commit again closes it. */
export function selectDetailCommit<T extends SelectableCommit>(
  state: DetailSelection<T>,
  commit: T,
): SelectionTransition<T> {
  if (state.selected?.oid === commit.oid) return { state: closeDetailSelection(state), load: null };
  const next = { selected: commit, generation: state.generation + 1 };
  return { state: next, load: { commit, generation: next.generation } };
}

/** True only while an asynchronous load still belongs to the current detail. */
export function acceptsDetailLoad<T extends SelectableCommit>(
  state: DetailSelection<T>,
  load: DetailLoad<T>,
): boolean {
  return state.generation === load.generation && state.selected?.oid === load.commit.oid;
}
