import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tabState: { activeTab: unknown } = { activeTab: null };
vi.mock("$lib/state/window-tabs.svelte", () => ({
  windowTabsManager: {
    get activeTab() {
      return tabState.activeTab;
    },
  },
}));

const fileUndo = vi.fn();
vi.mock("$lib/state/commands/shared", () => ({
  getActiveExplorer: () => ({ undo: fileUndo }),
}));

import { keybindingsStore } from "$lib/state/keybindings.svelte";
import { editCommands } from "$lib/state/commands/file-commands";
import {
  registerGraphUndoRequester,
  requestGraphUndo,
} from "$lib/state/git-graph-undo";

function ctrlZ(): KeyboardEvent {
  return {
    key: "z",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  } as KeyboardEvent;
}

function availability(id: string): boolean {
  const command = editCommands.find((candidate) => candidate.id === id);
  return !command?.when || command.when();
}

function setGraphActive(paneId: string): void {
  tabState.activeTab = {
    kind: "explorer",
    activePaneId: paneId,
    panes: { [paneId]: { gitGraph: { repoPath: "/repo" } } },
  };
}

function setFilesActive(paneId: string): void {
  tabState.activeTab = {
    kind: "explorer",
    activePaneId: paneId,
    panes: { [paneId]: {} },
  };
}

describe("Ctrl+Z ownership for git graph undo", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    keybindingsStore._clearForTesting();
    keybindingsStore.registerDefaults({
      "edit.undo": "Ctrl+Z",
      "gitGraph.undo": "Ctrl+Z",
    });
    fileUndo.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    tabState.activeTab = null;
  });

  it("routes Ctrl+Z only to the active graph pane when a graph is visible", () => {
    const active = vi.fn();
    const inactive = vi.fn();
    const unregisterActive = registerGraphUndoRequester("p1", active);
    const unregisterInactive = registerGraphUndoRequester("p2", inactive);
    setGraphActive("p1");

    const id = keybindingsStore.findMatchingCommand(ctrlZ(), availability);
    expect(id).toBe("gitGraph.undo");
    editCommands.find((command) => command.id === id)!.handler();

    expect(active).toHaveBeenCalledOnce();
    expect(inactive).not.toHaveBeenCalled();
    expect(fileUndo).not.toHaveBeenCalled();
    unregisterActive();
    unregisterInactive();
  });

  it("retains file undo ownership outside the graph", () => {
    setFilesActive("p1");
    const id = keybindingsStore.findMatchingCommand(ctrlZ(), availability);
    expect(id).toBe("edit.undo");
    editCommands.find((command) => command.id === id)!.handler();
    expect(fileUndo).toHaveBeenCalledOnce();
  });

  it("does nothing for an unregistered graph pane", () => {
    expect(requestGraphUndo("missing")).toBe(false);
  });
});
