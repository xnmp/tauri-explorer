/**
 * Branch-line jump command wiring (#530).
 *
 * Own file so command-definitions.test.ts stays untouched. Drives the REAL
 * command modules, the REAL registry/keybindings store and the REAL per-pane
 * navigation bus — only `windowTabsManager` and the explorer collaborators are
 * faked. What is pinned is the observable contract of the shortcut: a
 * Ctrl+Arrow keydown resolves to the right command, and running that command
 * reaches the ACTIVE graph pane's stepper with the right direction.
 *
 * (Fake setup derived from tests/state/pane-focus-commands.test.ts / #297.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// A couple of view guards read `document.activeElement`; the node env has no
// document, so stub the single property they touch.
if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  (globalThis as { document?: unknown }).document = { activeElement: null };
}

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
    refresh: vi.fn(),
    getSelectedEntries: vi.fn(() => [] as unknown[]),
  };
  type Tab = {
    kind: string;
    activePaneId: string;
    panes: Record<string, { gitGraph: string | null }>;
  };
  const windowTabs = {
    tabs: [{ id: "t1" }] as unknown[],
    canRestoreSurface: false,
    dualPaneEnabled: false,
    activeTab: null as Tab | null,
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
import { registerGraphSelectionStepper } from "$lib/state/git-graph-nav";
import {
  getCommand,
  getAllCommands,
  getAvailableCommands,
  executeCommand,
  type Command,
} from "$lib/state/commands.svelte";

const OLDER = "gitGraph.selectOlderOnLine";
const NEWER = "gitGraph.selectNewerOnLine";

/** Active tab showing a commit graph in pane `p1`. */
function graphTab() {
  return { kind: "explorer", activePaneId: "p1", panes: { p1: { gitGraph: "/repo" } } };
}
/** Active tab showing the ordinary file listing. */
function fileListTab() {
  return { kind: "explorer", activePaneId: "p1", panes: { p1: { gitGraph: null } } };
}

/** A keydown as the webview delivers Ctrl+Arrow. */
function ctrlArrow(key: "ArrowUp" | "ArrowDown"): KeyboardEvent {
  return {
    key,
    code: key,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  } as unknown as KeyboardEvent;
}

const available = (commandId: string) => {
  const cmd = getCommand(commandId);
  return !cmd?.when || cmd.when();
};

beforeEach(() => {
  h.explorer.canGoBack = false;
  h.explorer.canGoForward = false;
  h.explorer.breadcrumbs = [];
  h.windowTabs.tabs = [{ id: "t1" }];
  h.windowTabs.canRestoreSurface = false;
  h.windowTabs.dualPaneEnabled = false;
  h.windowTabs.activeTab = graphTab();
  h.bookmarks.bookmarked = new Set();
  h.recent.count = 0;
  h.workspaces.count = 0;
  vi.clearAllMocks();
  h.getActiveExplorer.mockReturnValue(h.explorer as unknown);
  registerAllCommands();
});

describe("branch-line jump shortcuts (#530)", () => {
  it("binds Ctrl+Down to the older jump and Ctrl+Up to the newer one", () => {
    expect(getCommand(OLDER)?.shortcut).toBe("Ctrl+Down");
    expect(getCommand(NEWER)?.shortcut).toBe("Ctrl+Up");
  });

  it("resolves a Ctrl+Arrow keydown to the jump command while a graph is active", () => {
    expect(keybindingsStore.findMatchingCommand(ctrlArrow("ArrowDown"), available)).toBe(OLDER);
    expect(keybindingsStore.findMatchingCommand(ctrlArrow("ArrowUp"), available)).toBe(NEWER);
  });

  it("leaves Ctrl+Arrow unbound while the active pane shows the file listing", () => {
    h.windowTabs.activeTab = fileListTab();
    expect(keybindingsStore.findMatchingCommand(ctrlArrow("ArrowDown"), available)).toBeUndefined();
    expect(keybindingsStore.findMatchingCommand(ctrlArrow("ArrowUp"), available)).toBeUndefined();
  });

  it("routes each command to the ACTIVE pane's stepper with its direction", async () => {
    const active = vi.fn();
    const other = vi.fn();
    const stop = [
      registerGraphSelectionStepper("p1", active),
      registerGraphSelectionStepper("p2", other),
    ];
    try {
      expect(await executeCommand(OLDER)).toBe(true);
      expect(active).toHaveBeenCalledWith("older");
      expect(await executeCommand(NEWER)).toBe(true);
      expect(active).toHaveBeenCalledWith("newer");
      // A graph mounted in a background pane must never be stepped.
      expect(other).not.toHaveBeenCalled();
    } finally {
      stop.forEach((fn) => fn());
    }
  });

  it("is a no-op when the active pane has no graph mounted", async () => {
    const stepper = vi.fn();
    const stop = registerGraphSelectionStepper("p2", stepper);
    try {
      expect(await executeCommand(OLDER)).toBe(true);
      expect(stepper).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("is offered in the palette only while a graph pane is active", () => {
    const labels = () => new Map(getAvailableCommands().map((c) => [c.id, c.label]));
    h.windowTabs.activeTab = graphTab();
    expect(labels().get(OLDER)).toBe("Git Graph: Select Older Commit on Branch Line");
    expect(labels().get(NEWER)).toBe("Git Graph: Select Newer Commit on Branch Line");
    h.windowTabs.activeTab = fileListTab();
    expect(labels().has(OLDER)).toBe(false);
    expect(labels().has(NEWER)).toBe(false);
  });

  it("keeps the no-unguarded-shortcut-collision invariant over the real command set", () => {
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
      if (group.filter((c) => !c.when).length > 1) {
        conflicts.push(`${shortcut}: ${group.map((c) => c.id).join(", ")}`);
      }
    }
    expect(conflicts).toEqual([]);
  });
});
