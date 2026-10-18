/**
 * Tests for macOS pointer-event-based drag composable.
 * Validates threshold detection, target resolution, exit-window behavior,
 * and cleanup on cancel/escape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";

vi.mock("$lib/domain/zoom", () => ({
  getZoomFactor: () => 1,
}));

vi.mock("$lib/state/settings.svelte", () => ({
  settingsStore: { zoomLevel: 100 },
}));

vi.mock("$lib/state/drag.svelte", async original => {
  const module = await original<typeof import("$lib/state/drag.svelte")>();
  vi.spyOn(module.dragState, "start");
  vi.spyOn(module.dragState, "clear");
  vi.spyOn(module.dragState, "finish");
  return module;
});

vi.mock("$lib/state/bookmarks.svelte", () => ({
  bookmarksStore: { addBookmark: vi.fn() },
}));

vi.mock("$lib/state/drop-operations", () => ({
  handleFileDropMany: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/composables/use-external-drag.svelte", () => ({
  startExternalDrag: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/composables/use-native-drop-target.svelte", () => ({
  resolveDropTargetAtPoint: vi.fn().mockReturnValue(null),
  elementAtPoint: () => null,
  highlightTargetAtPoint: vi.fn(),
  clearHighlights: vi.fn(),
  captureHighlightCleanup: () => vi.fn(),
}));

import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
import { dropHover } from "$lib/state/drop-hover";
import { dragState } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { handleFileDropMany } from "$lib/state/drop-operations";
import { startExternalDrag } from "$lib/composables/use-external-drag.svelte";
import { resolveDropTargetAtPoint, highlightTargetAtPoint, clearHighlights } from "$lib/composables/use-native-drop-target.svelte";

function makeEntry(name: string, kind = "file") {
  return { path: `/home/user/${name}`, name, kind, size: 100, modified: 0 } as any;
}

/** `listed`: the pane's listing (its root and open peeks); every path by default. */
function makeMockExplorer(entries: any[] = [], selected: any[] = [], listed?: Set<string>) {
  return {
    currentPath: "/home/user",
    getSelectedEntries: () => selected,
    refresh: vi.fn(),
    entryMeta: { has: (path: string) => listed?.has(path) ?? true },
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
    vi.mocked(handleFileDropMany).mockClear();
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

  it("reduces a recursive selection at drag start, never on a plain click", () => {
    const folder = makeEntry("folder", "directory"), child = { ...makeEntry("folder/child.txt"), name: "child.txt" };
    const explorer = makeMockExplorer([folder, child], [folder, child]);
    const selected = vi.spyOn(explorer, "getSelectedEntries");
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });

    // A click on a selected row in a large selection does no selection work.
    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), child, true);
    fireWindowEvent("mouseup", { clientX: 100, clientY: 100 });
    expect(selected).not.toHaveBeenCalled();

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), child, true);
    fireWindowEvent("mousemove", { clientX: 103, clientY: 100 });
    expect(selected).not.toHaveBeenCalled();
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    fireWindowEvent("mousemove", { clientX: 120, clientY: 100 });
    expect(selected).toHaveBeenCalledTimes(1);
    // The covered child travels inside its selected folder.
    expect(dragState.start).toHaveBeenCalledWith(expect.objectContaining({ path: folder.path, paths: undefined }));
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

  it("re-hit-tests a stationary drag after layout changes and releases hover ownership on cancel", () => {
    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer });
    drag.handlePointerDown(makeMouseEvent(), makeEntry("file.txt"), false);
    fireWindowEvent("mousemove", { clientX: 200, clientY: 200 });
    vi.mocked(resolveDropTargetAtPoint).mockClear();
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "/elsewhere" });
    dropHover.refresh();
    expect(resolveDropTargetAtPoint).toHaveBeenCalledExactlyOnceWith(200, 200);
    expect(highlightTargetAtPoint).toHaveBeenLastCalledWith(200, 200);
    fireWindowEvent("keydown", { key: "Escape" });
    vi.mocked(resolveDropTargetAtPoint).mockClear();
    dropHover.refresh();
    expect(resolveDropTargetAtPoint).not.toHaveBeenCalled();
  });

  it("drops onto folder target on mouseup", async () => {
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "/home/user/Documents" });

    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 200, clientY: 200, altKey: false });

    expect(handleFileDropMany).toHaveBeenCalledWith(
      ["/home/user/file.txt"],
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

    const requested = vi.mocked(handleFileDropMany).mock.calls.flatMap((c) => c[0]);
    expect(requested).toEqual([]); // nothing was asked to transfer
  });

  it("does nothing when dropping a folder onto itself", async () => {
    const entry = makeEntry("Documents", "directory"); // /home/user/Documents
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: entry.path });

    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 200, clientY: 200, altKey: false });

    const requested = vi.mocked(handleFileDropMany).mock.calls.flatMap((c) => c[0]);
    expect(requested).toEqual([]); // nothing was asked to transfer
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

    const requested = vi.mocked(handleFileDropMany).mock.calls.flatMap((c) => c[0]);
    expect(requested).toEqual([]); // nothing was asked to transfer
  });

  it("Ctrl pressed after pointer drag start copies at mouseup", async () => {
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "/home/user/Docs" });

    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    const entry = makeEntry("file.txt");

    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), entry, false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 200, clientY: 200, ctrlKey: true });

    expect(handleFileDropMany).toHaveBeenCalledWith(
      ["/home/user/file.txt"],
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

    const requested = vi.mocked(handleFileDropMany).mock.calls.flatMap((c) => c[0]);
    expect(requested).toEqual([]); // nothing was asked to transfer
    expect(dragState.clear).not.toHaveBeenCalled();
  });

  it("an active drag outlives its source row's unmount and still drops (#1242)", async () => {
    // A spring-loaded peek opening above the source can push its row out of
    // the virtual window mid-drag; the gesture belongs to the pointer, not the row.
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "/home/user/Documents" });
    const explorer = makeMockExplorer();
    const drag = usePointerDrag({ getExplorer: () => explorer, refreshPanes: undefined });
    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), makeEntry("file.txt"), false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    drag.dispose();
    await tick();
    expect(dragState.clear).not.toHaveBeenCalled();
    fireWindowEvent("mousemove", { clientX: 150, clientY: 120 });
    await fireWindowEvent("mouseup", { clientX: 150, clientY: 120 });
    expect(handleFileDropMany).toHaveBeenCalledWith(["/home/user/file.txt"], "/home/user/Documents", false, expect.anything());
    expect(registeredListeners["mousemove"] || []).toHaveLength(0);
    expect(registeredListeners["mouseup"] || []).toHaveLength(0);
  });

  it("a source that leaves its listing while its row is out of the virtual window cancels at release instead of moving", async () => {
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "/home/user/Documents" });
    const listed = new Set(["/home/user/file.txt"]);
    const drag = usePointerDrag({ getExplorer: () => makeMockExplorer([], [], listed), refreshPanes: undefined });
    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), makeEntry("file.txt"), false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    drag.dispose(); // scrolled out of the virtual window: still listed, the drag survives
    await tick();
    expect(dragState.clear).not.toHaveBeenCalled();
    listed.delete("/home/user/file.txt"); // deleted or renamed elsewhere
    fireWindowEvent("mousemove", { clientX: 150, clientY: 120 });
    await fireWindowEvent("mouseup", { clientX: 150, clientY: 120 });
    expect(handleFileDropMany).not.toHaveBeenCalled();
    expect(dragState.clear).toHaveBeenCalled();
    expect(clearHighlights).toHaveBeenCalled();
    expect(registeredListeners["mousemove"] || []).toHaveLength(0);
    expect(registeredListeners["mouseup"] || []).toHaveLength(0);
  });

  it("a row unmounted because its source left the listing cancels the drag at once", async () => {
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "/home/user/Documents" });
    const listed = new Set(["/home/user/a.txt", "/home/user/b.txt"]);
    const [a, b] = [makeEntry("a.txt"), makeEntry("b.txt")];
    const drag = usePointerDrag({ getExplorer: () => makeMockExplorer([], [a, b], listed), refreshPanes: undefined });
    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), a, true);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    listed.delete("/home/user/b.txt"); // one of the dragged selection is gone
    drag.dispose();
    await tick(); // the listing is read once the update that unmounted the row applies
    expect(dragState.clear).toHaveBeenCalled();
    expect(registeredListeners["mousemove"] || []).toHaveLength(0);
    expect(registeredListeners["keydown"] || []).toHaveLength(0);
    await fireWindowEvent("mouseup", { clientX: 150, clientY: 120 });
    expect(handleFileDropMany).not.toHaveBeenCalled();
  });

  it("a surface that lists other directories decides membership itself (Miller ancestor columns)", async () => {
    vi.mocked(resolveDropTargetAtPoint).mockReturnValue({ type: "folder", path: "/home/user/Documents" });
    const columns = new Set(["/home/user/file.txt"]);
    // The pane's own listing is a descendant directory that does not hold the source.
    const drag = usePointerDrag({ getExplorer: () => makeMockExplorer([], [], new Set()), refreshPanes: undefined, isListed: path => columns.has(path) });
    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), makeEntry("file.txt"), false);
    fireWindowEvent("mousemove", { clientX: 110, clientY: 100 });
    await fireWindowEvent("mouseup", { clientX: 150, clientY: 120 });
    expect(handleFileDropMany).toHaveBeenCalledWith(["/home/user/file.txt"], "/home/user/Documents", false, expect.anything());
  });

  it("unmount before the drag threshold releases the press", () => {
    const drag = usePointerDrag({ getExplorer: () => makeMockExplorer(), refreshPanes: undefined });
    drag.handlePointerDown(makeMouseEvent({ clientX: 100, clientY: 100 }), makeEntry("file.txt"), false);
    drag.dispose();
    expect(registeredListeners["mousemove"] || []).toHaveLength(0);
    expect(registeredListeners["mouseup"] || []).toHaveLength(0);
    expect(dragState.start).not.toHaveBeenCalled();
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
