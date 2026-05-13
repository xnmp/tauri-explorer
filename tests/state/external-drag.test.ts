/**
 * External drag-out: handleDragStart must initiate a native drag session and
 * populate HTML5 DataTransfer so both in-app drop targets and external apps work.
 * Issue: feat/drag-out-to-external-apps
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const startDragMock = vi.fn();
vi.mock("@crabnebula/tauri-plugin-drag", () => ({
  startDrag: (...args: unknown[]) => startDragMock(...args),
}));

// `isMac` is a module-level constant in domain/platform.ts, evaluated once at
// import time. To test platform-specific behavior we mock the module and update
// the exported value per test via `mockIsMac`.
let mockIsMac = false;
vi.mock("$lib/domain/platform", () => ({
  get isMac() { return mockIsMac; },
  isCopyModifier: (e: { altKey: boolean; ctrlKey: boolean }) => mockIsMac ? e.altKey : e.ctrlKey,
}));

import { useItemInteractions } from "$lib/composables/use-item-interactions.svelte";
import type { FileEntry } from "$lib/domain/file";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";

function makeEntry(path: string, name: string): FileEntry {
  return {
    path,
    name,
    kind: "file",
    size: 0,
    modified: "2026-01-01T00:00:00Z",
  };
}

function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: vi.fn((type: string, value: string) => store.set(type, value)),
    getData: (type: string) => store.get(type) ?? "",
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

function makeExplorer(selected: FileEntry[]): ExplorerInstance {
  return {
    getSelectedEntries: () => selected,
    isSelected: (e: FileEntry) => selected.some((s) => s.path === e.path),
    selectEntry: vi.fn(),
    openContextMenu: vi.fn(),
    refresh: vi.fn(),
  } as unknown as ExplorerInstance;
}

describe("external drag-out", () => {
  beforeEach(() => {
    startDragMock.mockReset();
    mockIsMac = false;
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  });

  it("starts a native drag with the single entry path (non-Mac)", () => {
    const entry = makeEntry("/home/u/file.txt", "file.txt");
    const interactions = useItemInteractions({
      getExplorer: () => makeExplorer([entry]),
      getPaneNav: () => undefined,
    });

    const event = { dataTransfer: makeDataTransfer() } as DragEvent;
    interactions.handleDragStart(event, entry, true);

    expect(startDragMock).toHaveBeenCalledTimes(1);
    expect(startDragMock.mock.calls[0][0].item).toEqual(["/home/u/file.txt"]);
  });

  it("starts a native drag with all selected paths when multi-selected (non-Mac)", () => {
    const a = makeEntry("/h/a.txt", "a.txt");
    const b = makeEntry("/h/b.txt", "b.txt");
    const c = makeEntry("/h/c.txt", "c.txt");
    const interactions = useItemInteractions({
      getExplorer: () => makeExplorer([a, b, c]),
      getPaneNav: () => undefined,
    });

    const event = { dataTransfer: makeDataTransfer() } as DragEvent;
    interactions.handleDragStart(event, a, true);

    expect(startDragMock.mock.calls[0][0].item).toEqual(["/h/a.txt", "/h/b.txt", "/h/c.txt"]);
  });

  it("skips native drag on macOS (WKWebView bridges HTML5 drag to native pasteboard)", () => {
    mockIsMac = true;
    const entry = makeEntry("/h/x.txt", "x.txt");
    const interactions = useItemInteractions({
      getExplorer: () => makeExplorer([entry]),
      getPaneNav: () => undefined,
    });

    interactions.handleDragStart({ dataTransfer: makeDataTransfer(), metaKey: true } as DragEvent, entry, true);

    expect(startDragMock).not.toHaveBeenCalled();
  });

  it("sets text/uri-list with file:// URLs for external app drops", () => {
    mockIsMac = true;
    const entry = makeEntry("/h/my file.txt", "my file.txt");
    const interactions = useItemInteractions({
      getExplorer: () => makeExplorer([entry]),
      getPaneNav: () => undefined,
    });

    const dt = makeDataTransfer();
    interactions.handleDragStart({ dataTransfer: dt } as DragEvent, entry, true);

    expect(dt.getData("text/uri-list")).toBe("file:///h/my%20file.txt");
  });

  it("preserves HTML5 DataTransfer for in-app drops", () => {
    const entry = makeEntry("/h/x.txt", "x.txt");
    const interactions = useItemInteractions({
      getExplorer: () => makeExplorer([entry]),
      getPaneNav: () => undefined,
    });

    const dt = makeDataTransfer();
    interactions.handleDragStart({ dataTransfer: dt } as DragEvent, entry, true);

    expect(dt.getData("application/x-explorer-path")).toBe("/h/x.txt");
    expect(dt.effectAllowed).toBe("all");
  });

  it("skips native drag outside Tauri (browser dev / E2E)", () => {
    (globalThis as { window?: unknown }).window = {};
    const entry = makeEntry("/h/x.txt", "x.txt");
    const interactions = useItemInteractions({
      getExplorer: () => makeExplorer([entry]),
      getPaneNav: () => undefined,
    });

    interactions.handleDragStart({ dataTransfer: makeDataTransfer() } as DragEvent, entry, true);

    expect(startDragMock).not.toHaveBeenCalled();
  });
});
