import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  nativeDrop: undefined as undefined | ((paths: string[], position: { x: number; y: number }) => Promise<void>),
  target: { type: "sidebar" } as { type: "sidebar" } | { type: "folder"; path: string },
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
  highlightTarget: vi.fn(),
  clearHighlights: vi.fn(),
}));
vi.mock("$lib/state/drag.svelte", () => ({
  dragState: { get current() { return state.dragData; }, readCrossWindow: () => null, clear: vi.fn() },
}));
vi.mock("$lib/state/drop-operations", () => ({ handleFileDropMany: transfer }));
vi.mock("$lib/state/bookmarks.svelte", () => ({ bookmarksStore: bookmarks }));
vi.mock("$lib/state/terminal.svelte", () => ({ terminalPanelStore: { insertPaths: vi.fn() } }));
vi.mock("$lib/domain/platform", () => ({ isCopyModifier: () => false }));
vi.mock("$lib/domain/path", () => ({
  parentDir: (path: string) => path.slice(0, path.lastIndexOf("/")),
  isInsideDir: () => false,
  samePath: (left: string, right: string) => left === right,
  splitFlattenedUriList: (path: string) => [path],
}));

import { useNativeDropHandler } from "$lib/composables/use-native-drop-handler";

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
