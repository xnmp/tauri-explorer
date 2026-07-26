/**
 * Directional pane focus command wiring (#501).
 *
 * Own file so command-definitions.test.ts stays untouched. Reuses that
 * suite's controllable-fake setup to drive the REAL command modules,
 * registry and keybindings store — only the collaborators are faked.
 *
 * (Derived from the #297 coverage suite.)
 */
/* eslint-disable */
/*
 * Original header:
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
    focusPaneInDirection: vi.fn(),
    splitPane: vi.fn(),
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
import { keybindingsStore } from "$lib/state/keybindings.svelte";
import {
  getCommand,
  getAllCommands,
  getAvailableCommands,
  executeCommand,
  getCommandShortcut,
  type Command,
} from "$lib/state/commands.svelte";

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

describe("directional pane focus shortcuts (#501)", () => {
  /** The four directions and the key that moves focus that way. */
  const DIRECTIONS = [
    { id: "pane.focusLeft", direction: "left", key: "l", shortcut: "Alt+L", code: "KeyL" },
    { id: "pane.focusRight", direction: "right", key: "'", shortcut: "Alt+'", code: "Quote" },
    { id: "pane.focusUp", direction: "up", key: "p", shortcut: "Alt+P", code: "KeyP" },
    { id: "pane.focusDown", direction: "down", key: ";", shortcut: "Alt+;", code: "Semicolon" },
  ] as const;

  /** A keydown as the webview delivers it: Alt held, no Ctrl/Meta/Shift. */
  function altKeydown(key: string, code: string): KeyboardEvent {
    return {
      key,
      code,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      metaKey: false,
    } as unknown as KeyboardEvent;
  }

  it("binds plain Alt+L/'/P/; — the split cluster without Cmd", () => {
    for (const { id, shortcut } of DIRECTIONS) {
      expect(getCommand(id)?.shortcut, `${id} default shortcut`).toBe(shortcut);
    }
  });

  it("leaves the Cmd+Alt split bindings alone", () => {
    expect(getCommand("pane.splitLeft")?.shortcut).toBe("Cmd+Alt+L");
    expect(getCommand("pane.splitRight")?.shortcut).toBe("Cmd+Alt+'");
    expect(getCommand("pane.splitUp")?.shortcut).toBe("Cmd+Alt+P");
    expect(getCommand("pane.splitDown")?.shortcut).toBe("Cmd+Alt+;");
  });

  it("resolves an Alt keydown to the focus command, not the split command", () => {
    h.windowTabs.dualPaneEnabled = true;
    const available = (commandId: string) => {
      const cmd = getCommand(commandId);
      return !cmd?.when || cmd.when();
    };
    for (const { id, key, code } of DIRECTIONS) {
      expect(
        keybindingsStore.findMatchingCommand(altKeydown(key, code), available),
        `Alt+${key} should run ${id}`,
      ).toBe(id);
    }
  });

  it("routes each command to focusPaneInDirection with its direction", async () => {
    h.windowTabs.dualPaneEnabled = true;
    for (const { id, direction } of DIRECTIONS) {
      h.windowTabs.focusPaneInDirection.mockClear();
      expect(await executeCommand(id)).toBe(true);
      expect(h.windowTabs.focusPaneInDirection).toHaveBeenCalledWith(direction);
    }
    // Moving focus must never create a pane.
    expect(h.windowTabs.splitPane).not.toHaveBeenCalled();
  });

  it("is offered only when the tab actually has more than one pane", () => {
    h.windowTabs.dualPaneEnabled = false;
    for (const { id } of DIRECTIONS) {
      expect(getCommand(id)?.when?.(), `${id} on a single pane`).toBe(false);
    }
    h.windowTabs.dualPaneEnabled = true;
    for (const { id } of DIRECTIONS) {
      expect(getCommand(id)?.when?.(), `${id} on a split tab`).toBe(true);
    }
  });

  it("appears in the palette with a direction-naming label", () => {
    h.windowTabs.dualPaneEnabled = true;
    const labels = new Map(getAvailableCommands().map((c) => [c.id, c.label]));
    expect(labels.get("pane.focusLeft")).toBe("Focus Pane Left");
    expect(labels.get("pane.focusRight")).toBe("Focus Pane Right");
    expect(labels.get("pane.focusUp")).toBe("Focus Pane Up");
    expect(labels.get("pane.focusDown")).toBe("Focus Pane Down");
  });
});
