import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  nativeDrop: undefined as undefined | ((paths: string[], position: { x: number; y: number }) => Promise<void>),
  target: { type: "sidebar" } as { type: "sidebar" } | { type: "folder"; path: string },
  pointerTarget: { type: "sidebar" } as { type: "sidebar" } | { type: "folder"; path: string },
  dragData: { path: "/home/user/report.txt", name: "report.txt", kind: "file" } as { path: string; name: string; kind: string } | null,
}));

const bookmarks = vi.hoisted(() => ({ addBookmark: vi.fn() }));
const transfer = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("$lib/composables/use-external-drop.svelte", () => ({
  useExternalDrop: ({ onDrop }: { onDrop: typeof state.nativeDrop }) => {
    state.nativeDrop = onDrop;
    return { setup: vi.fn(), cleanup: vi.fn() };
  },
}));
vi.mock("$lib/composables/use-native-drop-target.svelte", () => ({
  resolveDropTarget: () => state.target,
  resolveDropTargetAtPoint: () => state.pointerTarget,
  highlightTarget: vi.fn(),
  highlightTargetAtPoint: vi.fn(),
  clearHighlights: vi.fn(),
}));
vi.mock("$lib/state/drag.svelte", () => ({
  dragState: { get current() { return state.dragData; }, start: vi.fn(), readCrossWindow: () => null, clear: vi.fn() },
}));
vi.mock("$lib/state/drop-operations", () => ({ handleFileDropMany: transfer }));
vi.mock("$lib/state/bookmarks.svelte", () => ({ bookmarksStore: bookmarks }));
vi.mock("$lib/state/terminal.svelte", () => ({ terminalPanelStore: { insertPaths: vi.fn() } }));
vi.mock("$lib/domain/platform", () => ({ isCopyModifier: () => false }));
vi.mock("$lib/domain/zoom", () => ({ getZoomFactor: () => 1 }));
vi.mock("$lib/composables/use-external-drag.svelte", () => ({ startExternalDrag: vi.fn() }));
vi.mock("$lib/domain/path", () => ({
  parentDir: (path: string) => path.slice(0, path.lastIndexOf("/")),
  basename: (path: string) => path.slice(path.lastIndexOf("/") + 1),
  isInsideDir: () => false,
  samePath: (left: string, right: string) => left === right,
  splitFlattenedUriList: (path: string) => [path],
}));

import { useNativeDropHandler } from "$lib/composables/use-native-drop-handler";
import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";

describe("native bookmark drops", () => {
  beforeEach(() => {
    state.target = { type: "sidebar" };
    state.dragData = { path: "/home/user/report.txt", name: "report.txt", kind: "file" };
    bookmarks.addBookmark.mockClear();
    transfer.mockClear();
    useNativeDropHandler({ getActiveExplorer: () => ({ currentPath: "/home/user" }) as any, refreshAllPanes: vi.fn() });
  });

  it("does nothing when a file is dropped on the Bookmarks header or empty space", async () => {
    await state.nativeDrop!(["/home/user/report.txt"], { x: 10, y: 10 });

    expect(bookmarks.addBookmark).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it("uses the existing transfer operation when a file is dropped on a specific bookmark", async () => {
    state.target = { type: "folder", path: "/home/user/Archive" };
    await state.nativeDrop!(["/home/user/report.txt"], { x: 10, y: 10 });

    expect(transfer).toHaveBeenCalledWith(
      ["/home/user/report.txt"],
      "/home/user/Archive",
      false,
      expect.objectContaining({ broadcastToOtherWindows: true }),
    );
  });
});

describe("pointer bookmark drops", () => {
  const listeners: Record<string, Function[]> = {};

  function fire(type: string, event: Record<string, unknown>) {
    return Promise.all((listeners[type] ?? []).map((listener) => listener(event)));
  }

  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    state.pointerTarget = { type: "sidebar" };
    bookmarks.addBookmark.mockClear();
    transfer.mockClear();
    vi.stubGlobal("window", {
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (type: string, listener: Function) => (listeners[type] ??= []).push(listener),
      removeEventListener: (type: string, listener: Function) => {
        listeners[type] = (listeners[type] ?? []).filter((item) => item !== listener);
      },
    });
    vi.stubGlobal("document", {
      createElement: () => ({ style: {}, remove: vi.fn() }),
      body: { appendChild: vi.fn() },
    });
  });

  it("does nothing when a file is dropped on empty Bookmarks space", async () => {
    const explorer = { currentPath: "/home/user", getSelectedEntries: () => [], refresh: vi.fn() } as any;
    const drag = usePointerDrag({ getExplorer: () => explorer });
    drag.handlePointerDown({ button: 0, preventDefault: vi.fn(), currentTarget: { querySelector: () => null } } as any, {
      path: "/home/user/report.txt", name: "report.txt", kind: "file",
    } as any, false);

    await fire("mousemove", { clientX: 110, clientY: 110 });
    await fire("mouseup", { clientX: 120, clientY: 120, altKey: false });

    expect(bookmarks.addBookmark).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });
});
