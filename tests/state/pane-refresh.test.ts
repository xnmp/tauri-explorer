/**
 * Pane refresh lifecycle (src/lib/state/pane-refresh.ts): no-flash change
 * detection, streamed-chunk accumulation, path-change bail, cooldown skip.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const toastShow = vi.fn();
vi.mock("../../src/lib/state/toast.svelte", () => ({
  toastStore: { show: (...args: unknown[]) => toastShow(...args) },
}));

import { createPaneRefresh, entriesFingerprint } from "../../src/lib/state/pane-refresh";
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
    selectionAnchorIndex: null,
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
  overrides?: { inCooldown?: boolean }
) {
  const updateWatch = vi.fn();
  const navigateToParent = vi.fn(async () => {});
  const refresh = createPaneRefresh({
    coreState: state,
    dirListing: listing,
    inMutationCooldown: () => overrides?.inCooldown ?? false,
    updateWatch,
    navigateToParent,
  });
  return { refresh, updateWatch, navigateToParent };
}

beforeEach(() => {
  toastShow.mockClear();
});

describe("entriesFingerprint", () => {
  it("changes when path, size or mtime changes", () => {
    const base = [entry("a", 1)];
    expect(entriesFingerprint(base)).toBe(entriesFingerprint([entry("a", 1)]));
    expect(entriesFingerprint(base)).not.toBe(entriesFingerprint([entry("a", 2)]));
    expect(entriesFingerprint(base)).not.toBe(entriesFingerprint([entry("b", 1)]));
    expect(entriesFingerprint([])).toBe("");
  });
});

describe("createPaneRefresh", () => {
  it("replaces entries when the listing changed, accumulating streamed chunks", async () => {
    const state = coreState([entry("old")]);
    const { refresh, updateWatch } = makeRefresh(
      state,
      fakeListing({ entries: [entry("a")], streamed: [[entry("b")], [entry("c")]] })
    );

    await refresh();

    expect(state.entries.map((e) => e.name)).toEqual(["a", "b", "c"]);
    expect(updateWatch).toHaveBeenCalledWith("/d");
    expect(toastShow).toHaveBeenCalledWith("Refreshed", "info", { duration: 1500 });
  });

  it("leaves entries untouched (no flash) when nothing changed", async () => {
    const unchanged = [entry("a"), entry("b")];
    const state = coreState(unchanged);
    const sameReference = state.entries;
    const { refresh, updateWatch } = makeRefresh(
      state,
      fakeListing({ entries: [entry("a")], streamed: [[entry("b")]] })
    );

    await refresh({ silent: true });

    expect(state.entries).toBe(sameReference);
    expect(updateWatch).not.toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled();
  });

  it("reports 'Already up to date' for manual refresh with no changes", async () => {
    const state = coreState([entry("a")]);
    const { refresh } = makeRefresh(state, fakeListing({ entries: [entry("a")] }));

    await refresh();

    expect(toastShow).toHaveBeenCalledWith("Already up to date", "info", { duration: 1500 });
  });

  it("skips silent (watcher) refreshes during the mutation cooldown", async () => {
    const state = coreState([entry("a")]);
    const load = vi.fn();
    const listing = { load, cleanup: async () => {} } as unknown as DirListing;
    const { refresh } = makeRefresh(state, listing, { inCooldown: true });

    await refresh({ silent: true });
    expect(load).not.toHaveBeenCalled();

    // Manual refresh ignores the cooldown.
    await makeRefresh(state, fakeListing({ entries: [entry("a")] }), {
      inCooldown: true,
    }).refresh();
    expect(toastShow).toHaveBeenCalled();
  });

  it("discards the result when the pane navigated away mid-fetch", async () => {
    const state = coreState([entry("old")]);
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
