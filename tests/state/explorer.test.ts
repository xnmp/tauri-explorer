/**
 * Explorer store core contracts (#297).
 *
 * explorer.svelte.ts (per-pane path/history/entries/selection + navigation) is
 * a defect-dense hot spot with no dedicated behavior test. This suite drives
 * the REAL `createExplorerState` factory, mocking only the directory-listing
 * boundary (the Tauri IPC seam) so navigation logic runs unmodified. It pins:
 *
 *  - navigation commits path + entries and auto-selects the first row;
 *  - navigation pushes exactly one history entry (Back/Forward wiring);
 *  - the error path surfaces the error and leaves the current path untouched;
 *  - streaming ingest: post-return onEntries batches accumulate and onDone
 *    commits + clears loading;
 *  - the navGeneration race documented in lessons_learnt (async A→B navigation:
 *    the slower first result must be discarded, never clobbering B).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingCallbacks, DirectoryListingResult } from "$lib/state/directory-listing";

// Controllable directory-listing: every explorer instance gets a `load` we
// drive per test. This is the only seam mocked — all navigation/history/
// selection logic under test is the real module.
type LoadFn = (path: string, cbs: DirectoryListingCallbacks) => Promise<DirectoryListingResult>;
const { loadImpl, cleanupMock } = vi.hoisted(() => ({
  loadImpl: { current: (async () => ({ ok: false, error: "unset" })) as LoadFn },
  cleanupMock: vi.fn(async () => {}),
}));

vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({
    load: (path: string, cbs: DirectoryListingCallbacks) => loadImpl.current(path, cbs),
    cleanup: cleanupMock,
  }),
}));

import { createExplorerState } from "$lib/state/explorer.svelte";

function entry(name: string, dir = "/root"): FileEntry {
  return { name, path: `${dir}/${name}`, kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" };
}

/** A load that immediately returns a complete (non-streaming) listing. */
function staticLoad(map: Record<string, FileEntry[]>): LoadFn {
  return async (path) => {
    const entries = map[path];
    if (!entries) return { ok: false, error: `no such dir: ${path}` };
    return { ok: true, path, entries, streaming: false };
  };
}

beforeEach(() => {
  localStorage.clear();
  loadImpl.current = (async () => ({ ok: false, error: "unset" })) as LoadFn;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("navigation commits path, entries and selection", () => {
  it("updates currentPath, entries and auto-selects the first row", async () => {
    const entries = [entry("a.txt"), entry("b.txt"), entry("c.txt")];
    loadImpl.current = staticLoad({ "/root": entries });

    const explorer = createExplorerState();
    await explorer.navigateTo("/root");

    expect(explorer.currentPath).toBe("/root");
    expect(explorer.displayEntries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(explorer.loading).toBe(false);
    expect(explorer.error).toBeNull();
    // Auto-selects the first entry so keyboard nav has an anchor.
    expect([...explorer.selectedPaths]).toEqual(["/root/a.txt"]);
  });

  it("clears selection when navigating into an empty directory", async () => {
    loadImpl.current = staticLoad({ "/root": [entry("x")], "/empty": [] });
    const explorer = createExplorerState();

    await explorer.navigateTo("/root");
    expect(explorer.selectedPaths.size).toBe(1);

    await explorer.navigateTo("/empty");
    expect(explorer.currentPath).toBe("/empty");
    expect(explorer.displayEntries).toEqual([]);
    expect(explorer.selectedPaths.size).toBe(0);
  });

  it("pushes one history entry per navigation so Back/Forward are enabled", async () => {
    loadImpl.current = staticLoad({ "/a": [entry("f", "/a")], "/b": [entry("f", "/b")] });
    const explorer = createExplorerState();

    await explorer.navigateTo("/a");
    expect(explorer.canGoBack).toBe(false);
    expect(explorer.canGoForward).toBe(false);

    await explorer.navigateTo("/b");
    expect(explorer.currentPath).toBe("/b");
    expect(explorer.canGoBack).toBe(true);
    expect(explorer.canGoForward).toBe(false);

    await explorer.goBack();
    expect(explorer.currentPath).toBe("/a");
    expect(explorer.canGoForward).toBe(true);
  });
});

describe("navigation error path", () => {
  it("surfaces the error and leaves the current path untouched", async () => {
    loadImpl.current = staticLoad({ "/good": [entry("f", "/good")] });
    const explorer = createExplorerState();

    await explorer.navigateTo("/good");
    expect(explorer.currentPath).toBe("/good");

    // /missing is not in the map -> load returns ok:false.
    await explorer.navigateTo("/missing");
    expect(explorer.error).toContain("no such dir");
    expect(explorer.loading).toBe(false);
    // A failed navigation must not move the pane off the last good directory.
    expect(explorer.currentPath).toBe("/good");
    expect(explorer.canGoBack).toBe(false);
  });
});

describe("streaming ingest", () => {
  it("accumulates post-return onEntries batches and commits on done", async () => {
    vi.useFakeTimers();
    let captured: DirectoryListingCallbacks | null = null;

    loadImpl.current = async (path, cbs) => {
      captured = cbs;
      // Initial batch arrives with the (streaming) result.
      return { ok: true, path, entries: [entry("a")], streaming: true };
    };

    const explorer = createExplorerState();
    await explorer.navigateTo("/root");

    expect(explorer.currentPath).toBe("/root");
    expect(explorer.displayEntries.map((e) => e.name)).toEqual(["a"]);
    // Still loading: streaming continuation is outstanding.
    expect(explorer.loading).toBe(true);

    // A continuation batch streams in; commit is throttled behind a timer.
    captured!.onEntries([entry("b"), entry("c")]);
    vi.advanceTimersByTime(100);
    expect(explorer.displayEntries.map((e) => e.name)).toEqual(["a", "b", "c"]);

    // Done flushes any remainder and drops the loading flag.
    captured!.onDone();
    expect(explorer.loading).toBe(false);
    expect(explorer.displayEntries.map((e) => e.name)).toEqual(["a", "b", "c"]);
  });
});

describe("inline new-entry creation kind (#436)", () => {
  it("startInlineNewFolder / startInlineNewFile toggle the active kind, cancel clears", () => {
    const explorer = createExplorerState();

    // Default: not creating.
    expect(explorer.isCreatingFolder).toBe(false);
    expect(explorer.newEntryKind).toBe("folder");

    explorer.startInlineNewFolder();
    expect(explorer.isCreatingFolder).toBe(true);
    expect(explorer.newEntryKind).toBe("folder");

    // Switching to file creation flips the kind while staying active.
    explorer.startInlineNewFile();
    expect(explorer.isCreatingFolder).toBe(true);
    expect(explorer.newEntryKind).toBe("file");

    explorer.cancelInlineNewFolder();
    expect(explorer.isCreatingFolder).toBe(false);
    // Kind sticks at its last value; only the active flag is cleared.
    expect(explorer.newEntryKind).toBe("file");
  });
});

describe("navGeneration race (documented in lessons_learnt)", () => {
  it("discards the slower first navigation so a rapid A->B lands on B", async () => {
    const entriesA = [entry("a-only", "/A")];
    const entriesB = [entry("b-only", "/B")];

    let resolveA: (() => void) | null = null;
    loadImpl.current = async (path) => {
      if (path === "/A") {
        // /A resolves only when we release it — simulating the slow request.
        return new Promise<DirectoryListingResult>((resolve) => {
          resolveA = () => resolve({ ok: true, path, entries: entriesA, streaming: false });
        });
      }
      // /B resolves immediately.
      return { ok: true, path, entries: entriesB, streaming: false };
    };

    const explorer = createExplorerState();

    // Start A (hangs), then immediately start B (wins).
    const pA = explorer.navigateTo("/A");
    const pB = explorer.navigateTo("/B");

    await pB;
    expect(explorer.currentPath).toBe("/B");
    expect(explorer.displayEntries.map((e) => e.name)).toEqual(["b-only"]);

    // Now release the stale /A result — it must be discarded, not applied.
    resolveA!();
    await pA;

    expect(explorer.currentPath).toBe("/B");
    expect(explorer.displayEntries.map((e) => e.name)).toEqual(["b-only"]);
    // Only B's navigation should be in history.
    expect(explorer.canGoBack).toBe(false);
  });
});
