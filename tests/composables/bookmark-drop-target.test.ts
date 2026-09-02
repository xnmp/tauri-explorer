/**
 * Bookmark rows are file-transfer destinations, while the Bookmarks section
 * itself remains a folder-pinning target.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/state/settings.svelte", () => ({
  settingsStore: { zoomLevel: 100 },
}));

import { resolveDropTargetAtPoint } from "$lib/composables/use-native-drop-target.svelte";

function bookmarkChild(path: string): HTMLElement {
  const bookmark = {
    getAttribute: (name: string) => name === "data-path" ? path : null,
  } as unknown as HTMLElement;
  const sidebar = {} as HTMLElement;

  return {
    closest: (selector: string) => {
      if (selector === ".bookmark-drop-target[data-path]") return bookmark;
      if (selector === ".quick-access") return sidebar;
      return null;
    },
  } as unknown as HTMLElement;
}

function sidebarChild(): HTMLElement {
  const sidebar = {} as HTMLElement;
  return {
    closest: (selector: string) => selector === ".quick-access" ? sidebar : null,
  } as unknown as HTMLElement;
}

describe("bookmark drop targets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves an individual bookmark to its destination folder for in-app file moves", () => {
    vi.stubGlobal("document", { elementFromPoint: () => bookmarkChild("/home/user/Archive") });

    expect(resolveDropTargetAtPoint(100, 120)).toEqual({
      type: "folder",
      path: "/home/user/Archive",
    });
  });

  it("keeps the Bookmarks header and empty section as the folder-pinning target", () => {
    vi.stubGlobal("document", { elementFromPoint: () => sidebarChild() });

    expect(resolveDropTargetAtPoint(100, 120)).toEqual({ type: "sidebar" });
  });
});
