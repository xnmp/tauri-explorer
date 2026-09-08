/**
 * Pane refresh lifecycle (src/lib/state/pane-refresh.ts): no-flash change
 * detection, streamed-chunk accumulation, path-change bail, cooldown skip.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const toastShow = vi.fn();
vi.mock("../../src/lib/state/toast.svelte", () => ({
  toastStore: { show: (...args: unknown[]) => toastShow(...args) },
}));

import { createPaneRefresh } from "../../src/lib/state/pane-refresh";
import type { ExplorerCoreState } from "../../src/lib/state/types";
import type { FileEntry } from "../../src/lib/domain/file";
import type { createDirectoryListing } from "../../src/lib/state/directory-listing";

type DirListing = ReturnType<typeof createDirectoryListing>;
type LoadArgs = Parameters<DirListing["load"]>;

function entry(name: string, size = 1): FileEntry {
  return { name, path: `/d/${name}`, kind: "file", size, modified: "2024-01-01" };
}

function coreState(entries: FileEntry[]): ExplorerCoreState {
  return {
    currentPath: "/d",
    history: [],
    historyIndex: -1,
    entries,
    loading: false,
    error: null,
    sortBy: "name",
    sortAscending: true,
    viewMode: "details",
    selectedPaths: new Set(),
    selectionAnchorPath: null,
    cursorPath: null,
  };
}

interface FakeListingOptions {
  ok?: boolean;
  entries?: FileEntry[];
  streamed?: FileEntry[][];
  /** Run between returning the result and streaming (simulates mid-fetch changes). */
  beforeStream?: (callbacks: LoadArgs[1]) => void;
}

/** Listing that returns `entries` inline and streams `streamed` chunks. */
function fakeListing(opts: FakeListingOptions): DirListing {
  return {
    load: async (path: string, callbacks: LoadArgs[1]) => {
      if (opts.ok === false) {
        return { ok: false as const, error: "gone" };
      }
      const streamed = opts.streamed ?? [];
      queueMicrotask(() => {
        opts.beforeStream?.(callbacks);
        for (const chunk of streamed) callbacks.onEntries(chunk);
        callbacks.onDone();
      });
      return {
        ok: true as const,
        path,
        entries: opts.entries ?? [],
        streaming: true,
      };
    },
    cleanup: async () => {},
  } as DirListing;
}

function makeRefresh(
  state: ExplorerCoreState,
  listing: DirListing,
  overrides?: { allowRefresh?: (path: string) => boolean }
) {
  const allowRefresh = vi.fn(overrides?.allowRefresh ?? (() => true));
  const navigateToParent = vi.fn(async () => {});
  const setSelection = vi.fn((next: Iterable<string>) => {
    const nextSet = new Set(next);
    for (const path of [...state.selectedPaths]) {
      if (!nextSet.has(path)) state.selectedPaths.delete(path);
    }
    for (const path of nextSet) state.selectedPaths.add(path);
  });
  const requestReconcile = vi.fn();
  const refresh = createPaneRefresh({
    coreState: state,
    dirListing: listing,
    allowRefresh,
    navigateToParent,
    setSelection,
    requestReconcile,
  });
  return { refresh, allowRefresh, navigateToParent, setSelection, requestReconcile };
}

beforeEach(() => {
  toastShow.mockClear();
});

describe("createPaneRefresh", () => {
  it("replaces entries when the listing changed, accumulating streamed chunks", async () => {
    const state = coreState([entry("old")]);
    const { refresh } = makeRefresh(
      state,
      fakeListing({ entries: [entry("a")], streamed: [[entry("b")], [entry("c")]] })
    );

    await refresh();

    expect(state.entries.map((e) => e.name)).toEqual(["a", "b", "c"]);
    expect(toastShow).toHaveBeenCalledWith("Refreshed", "info", { duration: 1500 });
  });

  it("leaves entries untouched (no flash) when nothing changed", async () => {
    const unchanged = [entry("a"), entry("b")];
    const state = coreState(unchanged);
    const sameReference = state.entries;
    const { refresh } = makeRefresh(
      state,
      fakeListing({ entries: [entry("a")], streamed: [[entry("b")]] })
    );

    await refresh({ silent: true });

    expect(state.entries).toBe(sameReference);
    expect(toastShow).not.toHaveBeenCalled();
  });

  it("does not fetch while pending navigation denies watcher refreshes", async () => {
    const state = coreState([entry("old")]);
    const load = vi.fn();
    const listing = { load, cleanup: async () => {} } as unknown as DirListing;
    const { refresh, allowRefresh } = makeRefresh(state, listing, {
      allowRefresh: () => false,
    });

    await refresh({ silent: true });

    expect(allowRefresh).toHaveBeenCalledWith("/d");
    expect(load).not.toHaveBeenCalled();
    expect(state.entries.map((e) => e.name)).toEqual(["old"]);
  });

  it("discards an old refresh result when navigation becomes pending mid-fetch", async () => {
    const state = coreState([entry("old")]);
    let allowed = true;
    const { refresh, allowRefresh } = makeRefresh(
      state,
      fakeListing({
        entries: [entry("new")],
        beforeStream: () => { allowed = false; },
      }),
      { allowRefresh: () => allowed },
    );

    await refresh();

    expect(allowRefresh).toHaveBeenCalledTimes(2);
    expect(state.entries.map((e) => e.name)).toEqual(["old"]);
    expect(toastShow).not.toHaveBeenCalled();
  });

  it("reports 'Already up to date' for manual refresh with no changes", async () => {
    const state = coreState([entry("a")]);
    const { refresh } = makeRefresh(state, fakeListing({ entries: [entry("a")] }));

    await refresh();

    expect(toastShow).toHaveBeenCalledWith("Already up to date", "info", { duration: 1500 });
  });

  it("publishes a changed silent listing without a toast", async () => {
    const state = coreState([entry("a")]);
    const { refresh } = makeRefresh(state, fakeListing({ entries: [entry("a"), entry("new.zip")] }));
    await refresh({ silent: true });
    expect(state.entries.map((e) => e.name)).toContain("new.zip");
    expect(toastShow).not.toHaveBeenCalled();
  });

  it("reconciles selection against a completed external listing", async () => {
    const removed = entry("removed");
    const survivor = entry("survivor");
    const external = entry("external");
    const state = coreState([removed, survivor]);
    state.selectedPaths = new Set([removed.path, survivor.path]);
    state.selectionAnchorPath = removed.path;
    state.cursorPath = removed.path;
    const { refresh } = makeRefresh(
      state,
      fakeListing({ entries: [survivor, external] }),
    );

    await refresh({ silent: true });

    expect(state.entries.map(({ path }) => path)).toEqual([survivor.path, external.path]);
    expect([...state.selectedPaths]).toEqual([survivor.path]);
    expect(state.selectionAnchorPath).toBeNull();
    expect(state.cursorPath).toBeNull();
  });

  it("clears selection and cursor identities when the completed listing is empty", async () => {
    const removed = entry("removed");
    const state = coreState([removed]);
    state.selectedPaths = new Set([removed.path]);
    state.selectionAnchorPath = removed.path;
    state.cursorPath = removed.path;
    const { refresh } = makeRefresh(state, fakeListing({ entries: [] }));

    await refresh({ silent: true });

    expect(state.entries).toEqual([]);
    expect(state.selectedPaths.size).toBe(0);
    expect(state.selectionAnchorPath).toBeNull();
    expect(state.cursorPath).toBeNull();
  });

  it("waits for the final streamed listing before reconciling selection", async () => {
    const removed = entry("removed");
    const streamedSurvivor = entry("streamed-survivor");
    const state = coreState([removed, streamedSurvivor]);
    state.selectedPaths = new Set([removed.path, streamedSurvivor.path]);
    state.selectionAnchorPath = removed.path;
    state.cursorPath = removed.path;
    let callbacks: LoadArgs[1] | null = null;
    const listing = {
      load: vi.fn(async (path: string, nextCallbacks: LoadArgs[1]) => {
        callbacks = nextCallbacks;
        return { ok: true as const, path, entries: [], streaming: true };
      }),
      cleanup: async () => {},
    } as DirListing;
    const { refresh } = makeRefresh(state, listing);

    const pending = refresh({ silent: true });
    await Promise.resolve();
    callbacks!.onEntries([streamedSurvivor]);

    expect([...state.selectedPaths]).toEqual([removed.path, streamedSurvivor.path]);
    expect(state.cursorPath).toBe(removed.path);

    callbacks!.onDone();
    await pending;

    expect([...state.selectedPaths]).toEqual([streamedSurvivor.path]);
    expect(state.selectionAnchorPath).toBeNull();
    expect(state.cursorPath).toBeNull();
  });

  it("leaves selection untouched when a streamed refresh is cancelled", async () => {
    const selected = entry("selected");
    const state = coreState([selected]);
    state.selectedPaths = new Set([selected.path]);
    state.selectionAnchorPath = selected.path;
    state.cursorPath = selected.path;
    const { refresh } = makeRefresh(
      state,
      fakeListing({
        entries: [entry("replacement")],
        beforeStream: ({ onCancelled }) => onCancelled?.(),
      }),
    );

    await refresh({ silent: true });

    expect(state.entries.map(({ path }) => path)).toEqual([selected.path]);
    expect([...state.selectedPaths]).toEqual([selected.path]);
    expect(state.selectionAnchorPath).toBe(selected.path);
    expect(state.cursorPath).toBe(selected.path);
  });

  it("uses the selection current at commit time when the user selects during the fetch", async () => {
    const initial = entry("initial");
    const selectedDuringFetch = entry("selected-during-fetch");
    const external = entry("external");
    const state = coreState([initial, selectedDuringFetch]);
    state.selectedPaths = new Set([initial.path]);
    state.selectionAnchorPath = initial.path;
    state.cursorPath = initial.path;
    const { refresh } = makeRefresh(
      state,
      fakeListing({
        entries: [initial, selectedDuringFetch, external],
        beforeStream: () => {
          state.selectedPaths.clear();
          state.selectedPaths.add(selectedDuringFetch.path);
          state.selectionAnchorPath = selectedDuringFetch.path;
          state.cursorPath = selectedDuringFetch.path;
        },
      }),
    );

    await refresh({ silent: true });

    expect([...state.selectedPaths]).toEqual([selectedDuringFetch.path]);
    expect(state.selectionAnchorPath).toBe(selectedDuringFetch.path);
    expect(state.cursorPath).toBe(selectedDuringFetch.path);
  });

  it.each([
    {
      operation: "create",
      currentEntries: [entry("old"), entry("stable"), entry("locally-created")],
      selected: entry("locally-created"),
    },
    {
      operation: "rename",
      currentEntries: [entry("renamed"), entry("stable")],
      selected: entry("renamed"),
    },
  ])(
    "does not overwrite a concurrent local $operation with an older listing",
    async ({ currentEntries, selected }) => {
      const old = entry("old");
      const stable = entry("stable");
      const external = entry("incoming-external");
      const state = coreState([old, stable]);
      state.selectedPaths = new Set([old.path]);
      state.selectionAnchorPath = old.path;
      state.cursorPath = old.path;
      const { refresh, requestReconcile } = makeRefresh(
        state,
        fakeListing({
          entries: [old, stable, external],
          beforeStream: () => {
            state.entries = currentEntries;
            state.selectedPaths.clear();
            state.selectedPaths.add(selected.path);
            state.selectionAnchorPath = selected.path;
            state.cursorPath = selected.path;
          },
        }),
      );

      await refresh({ silent: true });

      expect(state.entries.some(({ path }) => path === external.path)).toBe(true);
      expect(state.entries.some(({ path }) => path === selected.path)).toBe(true);
      expect(state.entries.some(({ path }) => path === old.path)).toBe(
        currentEntries.some(({ path }) => path === old.path),
      );
      expect([...state.selectedPaths]).toEqual([selected.path]);
      expect(state.selectionAnchorPath).toBe(selected.path);
      expect(state.cursorPath).toBe(selected.path);
      expect(requestReconcile).toHaveBeenCalledExactlyOnceWith("/d");
    },
  );

  it(
    "provisionally retains a metadata-null create or rename identity until a fresh listing resolves it",
    async () => {
      const old = entry("old");
      const committedPath = entry("committed-without-metadata").path;
      const state = coreState([old]);
      state.selectedPaths = new Set([old.path]);
      state.selectionAnchorPath = old.path;
      state.cursorPath = old.path;
      let assignCommittedIdentity = true;
      const listing = fakeListing({
        entries: [old],
        beforeStream: () => {
          if (!assignCommittedIdentity) return;
          state.selectedPaths.clear();
          state.selectedPaths.add(committedPath);
          state.selectionAnchorPath = committedPath;
          state.cursorPath = committedPath;
          assignCommittedIdentity = false;
        },
      });
      const { refresh, requestReconcile } = makeRefresh(state, listing);

      await refresh({ silent: true });

      expect([...state.selectedPaths]).toEqual([committedPath]);
      expect(state.selectionAnchorPath).toBe(committedPath);
      expect(state.cursorPath).toBe(committedPath);
      expect(requestReconcile).toHaveBeenCalledExactlyOnceWith("/d");

      requestReconcile.mockClear();
      await refresh({ silent: true });

      expect(state.selectedPaths.size).toBe(0);
      expect(state.selectionAnchorPath).toBeNull();
      expect(state.cursorPath).toBeNull();
      expect(requestReconcile).not.toHaveBeenCalled();
    },
  );

  it("discards the result when the pane navigated away mid-fetch", async () => {
    const old = entry("old");
    const state = coreState([old]);
    state.selectedPaths = new Set([old.path]);
    state.selectionAnchorPath = old.path;
    state.cursorPath = old.path;
    const { refresh } = makeRefresh(
      state,
      fakeListing({
        entries: [entry("new")],
        beforeStream: () => {
          state.currentPath = "/elsewhere"; // navigation happened mid-stream
        },
      })
    );

    await refresh();

    expect(state.entries.map((e) => e.name)).toEqual(["old"]);
    expect([...state.selectedPaths]).toEqual([old.path]);
    expect(state.selectionAnchorPath).toBe(old.path);
    expect(state.cursorPath).toBe(old.path);
    expect(toastShow).not.toHaveBeenCalled();
  });

  it("falls back to the parent when the directory no longer exists", async () => {
    const state = coreState([entry("a")]);
    const { refresh, navigateToParent } = makeRefresh(state, fakeListing({ ok: false }));

    await refresh();

    expect(navigateToParent).toHaveBeenCalledTimes(1);
  });

  it("does not navigate to parent if the pane already moved elsewhere", async () => {
    const state = coreState([entry("a")]);
    const listing: DirListing = {
      load: async () => {
        state.currentPath = "/elsewhere";
        return { ok: false as const, error: "gone" };
      },
      cleanup: async () => {},
    } as DirListing;
    const { refresh, navigateToParent } = makeRefresh(state, listing);

    await refresh();

    expect(navigateToParent).not.toHaveBeenCalled();
  });
});
