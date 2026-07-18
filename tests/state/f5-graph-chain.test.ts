/**
 * #432 adversarial verification (verify/432-repro) — Claim 3:
 * "F5 in the terminal reaches the graph."
 *
 * Proves the FULL chain composes, not just the terminal-keys leaf:
 *   1. terminal key-ownership gate: F5 falls through to the app when bound
 *      (isShellReservedKey + keybindingsStore.matchesAnyBinding), and
 *   2. keybinding resolution routes F5 to `gitGraph.refresh` when a graph pane
 *      is active, and to `navigation.refresh` otherwise — the exact predicate
 *      +page.svelte feeds findMatchingCommand.
 *   3. the refresh bus dispatches ONLY to the active pane's registered handler.
 *
 * Attack edge: F5 with the terminal focused but NO graph pane must still map to
 * navigation.refresh (explorer refresh) and never be swallowed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Controllable window-tabs singleton so the commands' `when` guards (which read
// windowTabsManager.activeTab) can be driven from the test.
const tabState: { activeTab: unknown; activePaneId: string } = {
  activeTab: null,
  activePaneId: "",
};
vi.mock("$lib/state/window-tabs.svelte", () => ({
  windowTabsManager: {
    get activeTab() {
      return tabState.activeTab;
    },
    get activePaneId() {
      return tabState.activePaneId;
    },
  },
}));

// navigation.refresh's handler reaches into getActiveExplorer(); stub the shared
// helper so importing the command module doesn't drag in Tauri window APIs.
const explorerRefresh = vi.fn();
vi.mock("$lib/state/commands/shared", () => ({
  getActiveExplorer: () => ({ refresh: explorerRefresh }),
}));

import { isShellReservedKey } from "$lib/domain/terminal-keys";
import { keybindingsStore } from "$lib/state/keybindings.svelte";
import { navigationCommands } from "$lib/state/commands/navigation-commands";
import { registerGraphRefresher, refreshGraphPane } from "$lib/state/git-graph-refresh";

function f5(): KeyboardEvent {
  return {
    key: "F5",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  } as unknown as KeyboardEvent;
}

/** Mirror of +page.svelte:245-248 — the real availability predicate. */
function availability(id: string): boolean {
  const cmd = navigationCommands.find((c) => c.id === id);
  return !cmd?.when || cmd.when();
}

function setGraphActive(paneId: string): void {
  tabState.activePaneId = paneId;
  tabState.activeTab = {
    kind: "explorer",
    activePaneId: paneId,
    panes: { [paneId]: { gitGraph: { repoPath: "/repo" } } },
  };
}

function setPlainExplorerActive(paneId: string): void {
  tabState.activePaneId = paneId;
  tabState.activeTab = {
    kind: "explorer",
    activePaneId: paneId,
    panes: { [paneId]: {} },
  };
}

describe("#432 F5 full chain: terminal gate + keybinding resolution + bus", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    keybindingsStore._clearForTesting();
    // Register the two competing F5 owners exactly as commands.svelte does.
    keybindingsStore.registerDefaults({
      "navigation.refresh": "F5",
      "gitGraph.refresh": "F5",
    });
    explorerRefresh.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    tabState.activeTab = null;
    tabState.activePaneId = "";
  });

  it("terminal gate: F5 is app-bound so it falls through, not swallowed as shell typing", () => {
    // This is what +page.svelte computes: matchesAnyBinding drives appBound.
    const appBound = keybindingsStore.matchesAnyBinding(f5());
    expect(appBound).toBe(true);
    expect(isShellReservedKey(f5(), { appBound, isMac: false })).toBe(false);
  });

  it("resolves F5 to gitGraph.refresh when a graph pane is active", () => {
    setGraphActive("p1");
    const id = keybindingsStore.findMatchingCommand(f5(), availability);
    expect(id).toBe("gitGraph.refresh");
  });

  it("edge: F5 with terminal focused but NO graph pane resolves to navigation.refresh (not swallowed)", () => {
    setPlainExplorerActive("p1");
    // Terminal still lets it through …
    const appBound = keybindingsStore.matchesAnyBinding(f5());
    expect(isShellReservedKey(f5(), { appBound, isMac: false })).toBe(false);
    // … and it maps to the explorer refresh, never the graph.
    const id = keybindingsStore.findMatchingCommand(f5(), availability);
    expect(id).toBe("navigation.refresh");
  });

  it("the graph F5 command dispatches only to the ACTIVE pane's registered handler", () => {
    const activeHandler = vi.fn();
    const otherHandler = vi.fn();
    registerGraphRefresher("p1", activeHandler);
    registerGraphRefresher("p2", otherHandler);
    setGraphActive("p1");

    const id = keybindingsStore.findMatchingCommand(f5(), availability);
    expect(id).toBe("gitGraph.refresh");
    // Fire the resolved command's handler.
    navigationCommands.find((c) => c.id === id)!.handler();

    expect(activeHandler).toHaveBeenCalledTimes(1);
    expect(otherHandler).not.toHaveBeenCalled();
  });

  it("refreshGraphPane is a no-op for an unregistered / missing pane", () => {
    expect(refreshGraphPane(undefined)).toBe(false);
    expect(refreshGraphPane("nope")).toBe(false);
    const h = vi.fn();
    const unregister = registerGraphRefresher("p9", h);
    expect(refreshGraphPane("p9")).toBe(true);
    expect(h).toHaveBeenCalledTimes(1);
    unregister();
    expect(refreshGraphPane("p9")).toBe(false);
  });
});
