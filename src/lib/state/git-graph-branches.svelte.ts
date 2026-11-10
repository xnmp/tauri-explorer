import {
  gitBranchAuthors,
  gitRefs,
  gitMergeBase,
  type MergeBaseBranch,
  type BranchAuthor,
  type GitRefs,
} from "$lib/api/git-log";
import type { BranchListEntry } from "$lib/domain/git-graph";
import { createSlotCell } from "$lib/state/slot-cell.svelte";
import {
  beginSlot, cancelSlot, clearSlot, idleSlot, isSlotCurrent, isSlotLoading, settleSlot, slotData,
  type Slot, type SlotOutcome,
} from "$lib/domain/request-slot";

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

type Branches = readonly Readonly<BranchListEntry>[];
type MergeBase = { first: string; second: string; oid: string };
const NO_BRANCHES: Branches = Object.freeze([]);

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
  // Each async result is a latest-request-wins slot. Tokens come from one
  // counter. Refs and authors keep their data across a failed or invalidated
  // reload; the popover and merge-base slots do not.
  const refs = createSlotCell<Slot<Branches>>(idleSlot());
  const authors = createSlotCell<Slot<ReadonlyMap<string, string>>>(idleSlot());
  const popover = createSlotCell<Slot<true>>(idleSlot());
  const mergeBase = createSlotCell<Slot<MergeBase, { first: string; second: string }>>(idleSlot());
  // Commands touch slots untracked; getters and the guards the old code read
  // reactively are `$derived`, so each notifies only when its own value changes.
  const branchesView = $derived(slotData(refs.view()) ?? NO_BRANCHES);
  const authorsView = $derived(slotData(authors.view()));
  const knownView = $derived(slotData(refs.view()) !== undefined);
  const popoverLoaded = $derived(popover.view().kind === "ready");
  const popoverLoading = $derived(isSlotLoading(popover.view()));
  const popoverError = $derived.by(() => {
    const slot = popover.view();
    return slot.kind === "failed" ? slot.error : null;
  });
  const mergeBaseBusy = $derived(isSlotLoading(mergeBase.view()));
  const mergeBaseError = $derived.by(() => {
    const slot = mergeBase.view();
    return slot.kind === "failed" ? slot.error : null;
  });
  const mergeBaseResult = $derived.by(() => {
    const slot = mergeBase.view();
    return slot.kind === "ready" ? slot.data : null;
  });
  let tokens = 0;
  const nextToken = () => ++tokens;
  const known = () => slotData(refs.get()) !== undefined;
  let refsSequence = 0; // identifies the newest refs promise for coalescing
  let latestRefs: { request: number; result: Promise<RefsResult> } | null = null;
  let disposed = false;

  function cancelMergeBase(): void {
    mergeBase.set(clearSlot(mergeBase.get()));
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
    const token = nextToken();
    const before = mergeBase.get();
    // onStart runs before the slot changes, as it always did: it sees the
    // previous error/result and busy=false.
    onStart?.();
    // A lookup begun (or a cancel done) inside onStart owns the slot now.
    if (mergeBase.get() !== before) return;
    mergeBase.set(beginSlot(before, { first: first.name, second: second.name }, token));
    const current = () => !disposed && isSlotCurrent(mergeBase.get(), token);
    // Busy stays on until the reveal finishes, so `current` holds throughout.
    let outcome: SlotOutcome<MergeBase> | null = null;
    try {
      const oid = await (dependencies.mergeBase ?? gitMergeBase)(repoPath, first, second);
      if (!current()) return;
      if (!oid) {
        outcome = { ok: false, error: "These branches have no common ancestor" };
      } else {
        const revealed = await reveal(oid, current);
        if (current()) {
          outcome = revealed
            ? { ok: true, data: { first: first.name, second: second.name, oid } }
            : { ok: false, error: "Could not reveal the merge-base; history changed or is incomplete. Try again." };
        }
      }
    } catch (cause) {
      if (current()) outcome = { ok: false, error: message(cause, "Could not find the merge-base") };
    } finally {
      // A null outcome means the lookup was retired, so it is not current here.
      if (outcome && current()) {
        mergeBase.set(settleSlot(mergeBase.get(), token, outcome));
        onSettled?.(outcome.ok);
      }
    }
  }

  function requestRefs(): Promise<RefsResult> {
    const request = ++refsSequence;
    const token = nextToken();
    refs.set(beginSlot(refs.get(), undefined, token));
    const superseded = (): RefsResult =>
      ({ ok: false, error: "Branch metadata request was superseded", superseded: true });
    const result = (async (): Promise<RefsResult> => {
      try {
        const loaded = await dependencies.refs(repoPath);
        if (!isSlotCurrent(refs.get(), token)) return superseded();
        refs.set(settleSlot(refs.get(), token, { ok: true, data: snapshotBranches(loaded) }));
        return { ok: true };
      } catch (cause) {
        if (!isSlotCurrent(refs.get(), token)) return superseded();
        const error = message(cause, "Could not load branches");
        refs.set(settleSlot(refs.get(), token, { ok: false, error, keepPrevious: true }));
        return { ok: false, error, superseded: false };
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
    if (!result.ok && (!known() || result.superseded) && !disposed) throw new Error(result.error);
  }

  async function requestAuthors(): Promise<{ ok: true } | { ok: false; error: string }> {
    const token = nextToken();
    authors.set(beginSlot(authors.get(), undefined, token));
    try {
      const result = await dependencies.branchAuthors(repoPath);
      authors.set(settleSlot(authors.get(), token, { ok: true, data: snapshotAuthors(result) }));
      return { ok: true };
    } catch (cause) {
      // Reported even when superseded; the slot ignores a stale failure.
      const error = message(cause, "Could not load branch authors");
      authors.set(settleSlot(authors.get(), token, { ok: false, error, keepPrevious: true }));
      return { ok: false, error };
    }
  }

  async function loadForPopover(): Promise<void> {
    if (disposed || popoverLoaded || popoverLoading) return;
    const token = nextToken();
    popover.set(beginSlot(popover.get(), undefined, token));
    const [refsResult, authorsResult] = await Promise.all([
      requestRefs().then(settleCurrentRefs),
      requestAuthors(),
    ]);
    if (disposed || !isSlotCurrent(popover.get(), token)) return;
    const errors = [refsResult, authorsResult]
      .flatMap((result) => result.ok ? [] : [result.error]);
    popover.set(settleSlot(popover.get(), token, errors.length > 0
      ? { ok: false, error: errors.join("; ") }
      : { ok: true, data: true }));
  }

  /** Drops in-flight work but keeps loaded branches and authors. Refs are
   *  retired by cancelling their slot; a newer request is unaffected. */
  function invalidate(): void {
    if (disposed) return;
    popover.set(clearSlot(popover.get()));
    authors.set(cancelSlot(authors.get()));
    refs.set(cancelSlot(refs.get()));
  }

  return {
    get mergeBaseBusy() { return mergeBaseBusy; },
    get mergeBaseError() { return mergeBaseError; },
    get mergeBaseResult() { return mergeBaseResult; },
    jumpToMergeBase,
    cancelMergeBase,
    get branches(): readonly Readonly<BranchListEntry>[] { return branchesView; },
    get authors(): ReadonlyMap<string, string> { return new Map(authorsView ?? []); },
    get hasKnownBranches(): boolean { return knownView; },
    get popoverLoaded(): boolean { return popoverLoaded; },
    get popoverLoading(): boolean { return popoverLoading; },
    get popoverError(): string | null { return popoverError; },
    refreshForQuery,
    loadForPopover,
    invalidate,
    dispose(): void {
      cancelMergeBase();
      disposed = true;
      latestRefs = null;
      refs.set(clearSlot(refs.get()));
      authors.set(clearSlot(authors.get()));
      popover.set(clearSlot(popover.get()));
    },
  };
}

export type GitGraphBranches = ReturnType<typeof createGitGraphBranches>;
