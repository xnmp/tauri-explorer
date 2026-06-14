/**
 * Tests for macOS pointer-event-based drag composable.
 * Validates threshold detection, target resolution, exit-window behavior,
 * and cleanup on cancel/escape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("$lib/domain/zoom", () => ({
  getZoomFactor: () => 1,
}));

vi.mock("$lib/state/settings.svelte", () => ({
  settingsStore: { zoomLevel: 100 },
}));

vi.mock("$lib/state/drag.svelte", () => ({
  dragState: {
    current: null,
    start: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("$lib/state/bookmarks.svelte", () => ({
  bookmarksStore: { addBookmark: vi.fn() },
}));

vi.mock("$lib/state/drop-operations", () => ({
  handleFileDrop: vi.fn().mockResolvedValue(undefined),
  handleBackgroundDrop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/composables/use-external-drag.svelte", () => ({
  startExternalDrag: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/composables/use-native-drop-target.svelte", () => ({
  resolveDropTargetAtPoint: vi.fn().mockReturnValue(null),
  highlightTargetAtPoint: vi.fn(),
  clearHighlights: vi.fn(),
}));

import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
import { dragState } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { handleFileDrop, handleBackgroundDrop } from "$lib/state/drop-operations";
import { startExternalDrag } from "$lib/composables/use-external-drag.svelte";
import { resolveDropTargetAtPoint, highlightTargetAtPoint, clearHighlights } from "$lib/composables/use-native-drop-target.svelte";

function makeEntry(name: string, kind = "file") {
  return { path: `/home/user/${name}`, name, kind, size: 100, modified: 0 } as any;
}

function makeMockExplorer(entries: any[] = [], selected: any[] = []) {
  return {
    currentPath: "/home/user",
    getSelectedEntries: () => selected,
    refresh: vi.fn(),
  } as any;
}

function makeMouseEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    clientX: 100,
    clientY: 100,
    altKey: false,
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as MouseEvent;
}

let registeredListeners: Record<string, { handler: Function; capture: boolean }[]> = {};

function fireWindowEvent(type: string, props: Partial<MouseEvent | KeyboardEvent> = {}) {
  const listeners = registeredListeners[type] || [];
  const event = { ...props, type } as any;
  for (const { handler } of listeners) handler(event);
}

describe("usePointerDrag", () => {

  beforeEach(() => {
    registeredListeners = {};

    vi.stubGlobal("window", {
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (type: string, handler: any, capture?: any) => {
        if (!registeredListeners[type]) registeredListeners[type] = [];
        registeredListeners[type].push({ handler, capture: !!capture });
      },
      removeEventListener: (_type: string, handler: any) => {
        for (const key of Object.keys(registeredListeners)) {
          registeredListeners[key] = registeredListeners[key].filter(l => l.handler !== handler);
        }
      },
    });

    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue({
        style: { cssText: "", left: "", top: "" },
        className: "",
        textContent: "",
        remove: vi.fn(),
      }),
      body: { appendChild: vi.fn() },
      hasFocus: () => true,
    });

    vi.mocked(dragState.start).mockClear();
    vi.mocked(dragState.clear).mockClear();
    vi.mocked(handleFileDrop).mockClear();
    vi.mocked(handleBackgroundDrop).mockClear();
    vi.mocked(startExternalDrag).mockClear();
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue(null);
    vi.mocked(highlightTargetAtPoint).mockClear();
    vi.mocked(clearHighlights).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores non-left-button clicks", () => {
    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ button: 2 }), entry, false);
    expect(registeredListeners["mousemove"]).toBeUndefined();
  });

  it("registers window listeners on left-click", () => {
    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent(), entry, false);
    expect(registeredListeners["mousemove"]).toHaveLength(1);
    expect(registeredListeners["mouseup"]).toHaveLength(1);
    expect(registeredListeners["keydown"]).toHaveLength(1);
    expect(registeredListeners["blur"]).toHaveLength(1);
  });

  it("does not activate drag below threshold (5px)", () => {
    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 103, clientY: 103 });

    expect(dragState.start).not.toHaveBeenCalled();
  });

  it("activates drag above threshold", () => {
    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });

    expect(dragState.start).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/home/user/file.txt", name: "file.txt" })
    );
  });

  it("uses multi-selection paths when entry is already selected", () => {
    const entries = [makeEntry("a.txt"), makeEntry("b.txt")];
    const explorer = makeMockExplorer(entries, entries);
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entries[0], true);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });

    expect(dragState.start).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ["/home/user/a.txt", "/home/user/b.txt"] })
    );
  });

  it("triggers native drag when cursor exits window bounds", () => {
    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    // Cross threshold
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    // Exit window right edge
    fireWindowEvent("mousemove", { clientX: 800, clientY: 300 });

    expect(startExternalDrag).toHaveBeenCalledWith(["/home/user/file.txt"]);
    expect(clearHighlights).toHaveBeenCalled();
  });

  it("calls highlightTargetAtPoint during drag within window", () => {
    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    fireWindowEvent("mousemove", { clientX: 200, clientY: 200 });

    expect(highlightTargetAtPoint).toHaveBeenCalledWith(200, 200);
  });

  it("drops onto folder target on mouseup", async () => {
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "/home/user/Documents" });

    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 200, clientY: 200, altKey: false });

    expect(handleFileDrop).toHaveBeenCalledWith(
      "/home/user/file.txt",
      "/home/user/Documents",
      false,
      expect.objectContaining({ onRefresh: expect.any(Function) })
    );
  });

  it("does nothing when dropping onto the file's own folder (no conflict dialog)", async () => {
    // /home/user/file.txt dropped onto its own parent /home/user is a no-op.
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "/home/user" });

    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 200, clientY: 200, altKey: false });

    expect(handleFileDrop).not.toHaveBeenCalled();
  });

  it("does nothing when dropping a folder onto itself", async () => {
    const entry = makeEntry("Documents", "directory"); // /home/user/Documents
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: entry.path });

    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 200, clientY: 200, altKey: false });

    expect(handleFileDrop).not.toHaveBeenCalled();
  });

  it("no-op detection survives mixed separators (Windows: parentDir is '/', data-path is '\\')", async () => {
    // The folder data-path comes from the DOM as a native backslash path, while
    // parentDir(source) yields forward slashes; a naive === would miss the no-op
    // and pop the conflict dialog. samePath must catch it.
    const entry = { path: "C:\\Users\\me\\file.txt", name: "file.txt", kind: "file" } as any;
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "C:\\Users\\me" });

    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 200, clientY: 200, altKey: false });

    expect(handleFileDrop).not.toHaveBeenCalled();
  });

  it("option+mouseup triggers copy (altKey=true)", async () => {
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "/home/user/Docs" });

    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 200, clientY: 200, altKey: true });

    expect(handleFileDrop).toHaveBeenCalledWith(
      "/home/user/file.txt",
      "/home/user/Docs",
      true,
      expect.any(Object)
    );
  });

  it("drops onto sidebar target adds bookmark", async () => {
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "sidebar" });

    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("Documents", "directory");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 50, clientY: 200, altKey: false });

    expect(bookmarksStore.addBookmark).toHaveBeenCalledWith("/home/user/Documents");
  });

  it("escape cancels active drag", () => {
    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    fireWindowEvent("keydown", { key: "Escape" });

    expect(clearHighlights).toHaveBeenCalled();
    expect(dragState.clear).toHaveBeenCalled();
  });

  it("mouseup without threshold does not drop (click-through)", async () => {
    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    await fireWindowEvent("mouseup", { clientX: 101, clientY: 101 });

    expect(handleFileDrop).not.toHaveBeenCalled();
    expect(dragState.clear).not.toHaveBeenCalled();
  });

  it("cleans up all listeners after drop", async () => {
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue(null);

    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 200, clientY: 200 });

    expect(registeredListeners["mousemove"] || []).toHaveLength(0);
    expect(registeredListeners["mouseup"] || []).toHaveLength(0);
    expect(registeredListeners["keydown"] || []).toHaveLength(0);
    expect(registeredListeners["blur"] || []).toHaveLength(0);
  });
});
