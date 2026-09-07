/**
 * Command definitions coverage (#297).
 *
 * command-definitions.ts is a historically defect-dense hot spot (guard/`when`
 * conditions that gate shortcuts) with zero direct tests. This suite imports
 * the REAL command modules and the REAL `registerAllCommands` aggregator — no
 * re-implemented/simulated command logic — and pins:
 *
 *  - registerAllCommands wires every command + its default shortcut into the
 *    registry (a missing/renamed id is a regression);
 *  - the shortcut-conflict invariant validateShortcutConflicts enforces (no two
 *    palette commands share a shortcut without a `when` guard) — checked over
 *    the real command set, so a future clashing binding fails the suite;
 *  - the `when` guards that have repeatedly broken: tab navigation on a single
 *    tab (Ctrl+W/next/prev class), the bookmark add/remove toggle pair,
 *    back/forward/up navigation gating, and the recent/workspace count gates;
 *  - guards drive executeCommand's availability gate end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// A couple of view guards read `document.activeElement` (e.g. Space preview) to
// avoid firing while typing in an input. The node test env has no document;
// stub the single property those guards touch so getAvailableCommands can
// evaluate every guard without an environment crash.
if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  (globalThis as { document?: unknown }).document = { activeElement: null };
}

// --- Controllable fakes for the stores the guards read ---------------------
// The command `when`/handler closures read these lazily, so a mutable holder
// lets each test set the world and then exercise the REAL guard.
const h = vi.hoisted(() => {
  const explorer = {
    canGoBack: false,
    canGoForward: false,
    breadcrumbs: [] as unknown[],
    currentPath: "/home/user",
    state: { selectedPaths: new Set<string>(), currentPath: "/home/user" },
    goBack: vi.fn(),
    goForward: vi.fn(),
    goUp: vi.fn(),
    getSelectedEntries: vi.fn(() => [] as unknown[]),
  };
  const windowTabs = {
    tabs: [{ id: "t1" }] as unknown[],
    canRestoreSurface: false,
    dualPaneEnabled: false,
    activeTab: { kind: "explorer" } as { kind: string } | null,
    nextTab: vi.fn(),
    prevTab: vi.fn(),
    createTab: vi.fn(),
    closeSurface: vi.fn(),
    closeActiveTab: vi.fn(),
    restoreClosedSurface: vi.fn(() => null),
  };
  const bookmarks = { bookmarked: new Set<string>() };
  const recent = { count: 0 };
  const workspaces = { count: 0, list: [] as unknown[] };
  return {
    explorer,
    getActiveExplorer: vi.fn(() => explorer as unknown),
    windowTabs,
    bookmarks,
    recent,
    workspaces,
  };
});

vi.mock("$lib/state/commands/shared", () => ({
  getActiveExplorer: h.getActiveExplorer,
  openNewWindow: vi.fn(),
}));

vi.mock("$lib/state/window-tabs.svelte", () => ({
  windowTabsManager: h.windowTabs,
  tabSeedKey: (label: string) => `tab-seed:${label}`,
}));

vi.mock("$lib/state/bookmarks.svelte", () => ({
  bookmarksStore: {
    hasBookmark: (p: string) => h.bookmarks.bookmarked.has(p),
    addBookmark: vi.fn((p: string) => h.bookmarks.bookmarked.add(p)),
    removeBookmark: vi.fn((p: string) => h.bookmarks.bookmarked.delete(p)),
  },
}));

vi.mock("$lib/state/recent-files.svelte", () => ({
  recentFilesStore: {
    get count() {
      return h.recent.count;
    },
    clear: vi.fn(),
    add: vi.fn(),
  },
}));

vi.mock("$lib/state/workspaces.svelte", () => ({
  workspacesStore: {
    get count() {
      return h.workspaces.count;
    },
    get list() {
      return h.workspaces.list;
    },
    get: vi.fn(),
  },
}));

import { registerAllCommands } from "$lib/state/command-definitions";
import {
  getCommand,
  getAllCommands,
  getAvailableCommands,
  executeCommand,
  getCommandShortcut,
  type Command,
} from "$lib/state/commands.svelte";
import { keybindingsStore } from "$lib/state/keybindings.svelte";

beforeEach(() => {
  // Reset the controllable world to a neutral baseline.
  h.explorer.canGoBack = false;
  h.explorer.canGoForward = false;
  h.explorer.breadcrumbs = [];
  h.windowTabs.tabs = [{ id: "t1" }];
  h.windowTabs.canRestoreSurface = false;
  h.windowTabs.dualPaneEnabled = false;
  h.windowTabs.activeTab = { kind: "explorer" };
  h.bookmarks.bookmarked = new Set();
  h.recent.count = 0;
  h.workspaces.count = 0;
  vi.clearAllMocks();
  h.getActiveExplorer.mockReturnValue(h.explorer as unknown);
  registerAllCommands();
});

describe("registerAllCommands", () => {
  it("registers the core command surface with stable ids", () => {
    const ids = new Set(getAllCommands().map((c) => c.id));
    for (const id of [
      "navigation.focusAddressBar",
      "navigation.goBack",
      "navigation.goForward",
      "navigation.goUp",
      "surface.close",
      "tabs.newTab",
      "tabs.nextTab",
      "tabs.prevTab",
      "bookmarks.addCurrent",
      "bookmarks.removeCurrent",
      "general.openQuickOpen",
      "general.openCommandPalette",
    ]) {
      expect(ids.has(id), `missing command ${id}`).toBe(true);
    }
  });

  it("registers each command's default shortcut with the keybindings store", () => {
    // Ctrl+P re-trigger hot spot: the hidden Quick Open binding must survive.
    expect(getCommandShortcut("general.openQuickOpen")).toBe("Ctrl+P");
    expect(getCommand("general.openQuickOpen")?.hidden).toBe(true);
    expect(getCommandShortcut("surface.close")).toBe("Ctrl+W");
    expect(getCommandShortcut("tabs.newTab")).toBe("Ctrl+T");
    // The keybindings store resolves a display form (arrow glyphs); the raw
    // default lives on the command object.
    expect(getCommand("navigation.goBack")?.shortcut).toBe("Ctrl+Alt+Left");
    expect(getCommandShortcut("navigation.focusAddressBar")).toBe("Ctrl+L");
    expect(getCommandShortcut("navigation.goBack")).toBeTruthy();
  });

  it("resolves an Alt+I keystroke to Report Issue (#597)", () => {
    // The binding is only useful if the window-level dispatcher actually
    // resolves the keystroke to it, so drive the real matcher rather than
    // asserting the string on the command object alone.
    expect(getCommandShortcut("help.reportIssue")).toBe("Alt+I");
    const altI = {
      key: "i",
      code: "KeyI",
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      metaKey: false,
    } as KeyboardEvent;
    expect(keybindingsStore.findMatchingCommand(altI)).toBe("help.reportIssue");

    // Alt alone, or Alt+I with another modifier, must not claim it.
    expect(
      keybindingsStore.findMatchingCommand({ ...altI, altKey: false } as KeyboardEvent),
    ).not.toBe("help.reportIssue");
    expect(
      keybindingsStore.findMatchingCommand({ ...altI, ctrlKey: true } as KeyboardEvent),
    ).not.toBe("help.reportIssue");
  });

  it("has no two palette commands sharing a shortcut without a `when` guard", () => {
    // Pins the exact invariant validateShortcutConflicts warns about, over the
    // real command set: same-shortcut commands must be disambiguated by guards.
    const byShortcut = new Map<string, Command[]>();
    for (const cmd of getAllCommands()) {
      if (!cmd.shortcut) continue;
      const key = cmd.shortcut.toLowerCase();
      const group = byShortcut.get(key) ?? [];
      group.push(cmd);
      byShortcut.set(key, group);
    }
    const conflicts: string[] = [];
    for (const [shortcut, group] of byShortcut) {
      if (group.length <= 1) continue;
      const unguarded = group.filter((c) => !c.when);
      if (unguarded.length > 1) {
        conflicts.push(`${shortcut}: ${unguarded.map((c) => c.id).join(", ")}`);
      }
    }
    expect(conflicts).toEqual([]);
  });
});

describe("tab navigation guards (single-tab hot spot)", () => {
  it("hides next/prev tab and restore when only one tab is open", () => {
    h.windowTabs.tabs = [{ id: "t1" }];
    h.windowTabs.canRestoreSurface = false;
    expect(getCommand("tabs.nextTab")?.when?.()).toBe(false);
    expect(getCommand("tabs.prevTab")?.when?.()).toBe(false);
    expect(getCommand("tabs.nextTabAlt")?.when?.()).toBe(false);
    expect(getCommand("tabs.prevTabAlt")?.when?.()).toBe(false);
    expect(getCommand("tabs.restoreClosedTab")?.when?.()).toBe(false);
  });

  it("enables next/prev tab once a second tab exists", () => {
    h.windowTabs.tabs = [{ id: "t1" }, { id: "t2" }];
    expect(getCommand("tabs.nextTab")?.when?.()).toBe(true);
    expect(getCommand("tabs.prevTab")?.when?.()).toBe(true);
  });

  it("executeCommand refuses next-tab on a single tab and runs it with two", async () => {
    h.windowTabs.tabs = [{ id: "t1" }];
    expect(await executeCommand("tabs.nextTab")).toBe(false);
    expect(h.windowTabs.nextTab).not.toHaveBeenCalled();

    h.windowTabs.tabs = [{ id: "t1" }, { id: "t2" }];
    expect(await executeCommand("tabs.nextTab")).toBe(true);
    expect(h.windowTabs.nextTab).toHaveBeenCalledOnce();
  });

  it("surface.close (Ctrl+W) is always available and closes the surface", async () => {
    // Ctrl+W has no `when` — it collapses a pane or closes the tab itself.
    expect(getCommand("surface.close")?.when).toBeUndefined();
    expect(await executeCommand("surface.close")).toBe(true);
    expect(h.windowTabs.closeSurface).toHaveBeenCalledOnce();
  });

  it("gates restore-closed on canRestoreSurface", () => {
    h.windowTabs.canRestoreSurface = true;
    expect(getCommand("tabs.restoreClosedTab")?.when?.()).toBe(true);
  });
});

describe("bookmark add/remove toggle pair", () => {
  it("offers only Add when the folder is not bookmarked", () => {
    h.bookmarks.bookmarked = new Set();
    expect(getCommand("bookmarks.addCurrent")?.when?.()).toBe(true);
    expect(getCommand("bookmarks.removeCurrent")?.when?.()).toBe(false);
  });

  it("offers only Remove when the folder is bookmarked", () => {
    h.bookmarks.bookmarked = new Set([h.explorer.currentPath]);
    expect(getCommand("bookmarks.addCurrent")?.when?.()).toBe(false);
    expect(getCommand("bookmarks.removeCurrent")?.when?.()).toBe(true);
  });

  it("hides both when there is no active explorer", () => {
    h.getActiveExplorer.mockReturnValue(undefined);
    expect(getCommand("bookmarks.addCurrent")?.when?.()).toBe(false);
    expect(getCommand("bookmarks.removeCurrent")?.when?.()).toBe(false);
  });
});

describe("navigation guards follow the active explorer", () => {
  it("gates back/forward on the explorer's history flags", () => {
    h.explorer.canGoBack = false;
    h.explorer.canGoForward = true;
    expect(getCommand("navigation.goBack")?.when?.()).toBe(false);
    expect(getCommand("navigation.goForward")?.when?.()).toBe(true);
  });

  it("gates go-up on having more than one breadcrumb", () => {
    h.explorer.breadcrumbs = [{}];
    expect(getCommand("navigation.goUp")?.when?.()).toBe(false);
    h.explorer.breadcrumbs = [{}, {}];
    expect(getCommand("navigation.goUp")?.when?.()).toBe(true);
  });

  it("defaults guards to false when no explorer is active", () => {
    h.getActiveExplorer.mockReturnValue(undefined);
    expect(getCommand("navigation.goBack")?.when?.()).toBe(false);
    expect(getCommand("navigation.goForward")?.when?.()).toBe(false);
    expect(getCommand("navigation.goUp")?.when?.()).toBe(false);
  });

  it("routes the back handler to the active explorer only when available", async () => {
    h.explorer.canGoBack = true;
    expect(await executeCommand("navigation.goBack")).toBe(true);
    expect(h.explorer.goBack).toHaveBeenCalledOnce();
  });
});

describe("count-gated commands", () => {
  it("hides clear-recent until there are recent files", () => {
    h.recent.count = 0;
    expect(getCommand("recent.clearHistory")?.when?.()).toBe(false);
    h.recent.count = 3;
    expect(getCommand("recent.clearHistory")?.when?.()).toBe(true);
  });

  it("hides open-workspace until a workspace is saved", () => {
    h.workspaces.count = 0;
    expect(getCommand("workspace.openNamed")?.when?.()).toBe(false);
    h.workspaces.count = 1;
    expect(getCommand("workspace.openNamed")?.when?.()).toBe(true);
  });
});

describe("getAvailableCommands reflects live guards", () => {
  it("drops guarded-out commands and keeps guard-passing ones", () => {
    h.windowTabs.tabs = [{ id: "t1" }];
    h.recent.count = 0;
    const availableSingleTab = new Set(getAvailableCommands().map((c) => c.id));
    expect(availableSingleTab.has("tabs.nextTab")).toBe(false);
    expect(availableSingleTab.has("recent.clearHistory")).toBe(false);
    // hidden commands are never "available" even though the shortcut works.
    expect(availableSingleTab.has("general.openQuickOpen")).toBe(false);

    h.windowTabs.tabs = [{ id: "t1" }, { id: "t2" }];
    h.recent.count = 2;
    const availableMultiTab = new Set(getAvailableCommands().map((c) => c.id));
    expect(availableMultiTab.has("tabs.nextTab")).toBe(true);
    expect(availableMultiTab.has("recent.clearHistory")).toBe(true);
  });
});
