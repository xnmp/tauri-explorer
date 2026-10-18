import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keybindingsStore } from "$lib/state/keybindings.svelte";
import { startWindowKeyboard } from "$lib/state/window-keyboard";
import { createModalOwnership } from "$lib/state/modal-ownership.svelte";

const stops: (() => void)[] = [];
beforeEach(() => keybindingsStore._clearForTesting());
afterEach(() => { stops.splice(0).forEach((stop) => stop()); keybindingsStore._clearForTesting(); vi.unstubAllGlobals(); });

/** Minimal Element.matches behavior for comma-separated selector lists. */
function matchesAny(...matchedSelectors: string[]): (selectorList: string) => boolean {
  const matched = new Set(matchedSelectors);
  return (selectorList) => selectorList
    .split(",")
    .some((selector) => matched.has(selector.trim()));
}

function fixture(terminalFocus = false, ancestors: readonly string[] = [], ownership?: ReturnType<typeof createModalOwnership>) {
  const target = new EventTarget();
  // Exercise real EventTarget dispatch and the production binding matcher.
  const closest = (selector: string) => terminalFocus || ancestors.includes(selector) ? target : null;
  vi.stubGlobal("document", { body: target });
  Object.assign(target, { tagName: terminalFocus ? "TEXTAREA" : "DIV", closest });
  const executeCommand = vi.fn(async (_id: string) => {});
  const available = new Set<string>(["view.toggleTerminal", "general.filterCurrentDir", "general.openJobsPanel", "general.openSettings", "view.toggleDualPane"]);
  const affectedPanes = new Map<string, () => readonly string[]>();
  const whens = new Map<string, () => boolean>();
  const commandScopes = new Map<string, "pane" | "window">([["view.toggleTerminal", "pane"], ["general.filterCurrentDir", "pane"], ["general.openJobsPanel", "window"], ["general.openSettings", "window"], ["view.toggleDualPane", "pane"]]);
  let activePaneId = "a";
  const dialogs = {
    hasModalOpen: false, requestCloseTop: vi.fn(), openJobsPanel: vi.fn(), openSettings: vi.fn(),
    inputScope: (event: Event, paneId: string) => dialogs.hasModalOpen ? null : ownership?.inputScope(event, paneId),
    subscribeOwnership: ownership?.subscribe,
    isPaneBlocked: (paneId: string) => dialogs.hasModalOpen || !!ownership?.hasOpen || !!ownership?.hasPaneOpen(paneId),
  };
  const explorer = {
    showFilter: false,
    openFilter: vi.fn(() => { explorer.showFilter = true; }),
    closeFilter: vi.fn(() => { explorer.showFilter = false; }),
  };
  const stop = startWindowKeyboard(target, {
    bindings: keybindingsStore,
    getCommand: (id) => available.has(id) ? { scope: commandScopes.get(id)!, paneIds: affectedPanes.get(id), allowInDialogInput: id === "view.switchPane" || id.startsWith("pane.focus") || /tabs\.(next|prev)Tab/.test(id), when: whens.get(id) } : undefined,
    executeCommand,
    dialogs,
    toggleDualPane: vi.fn(),
    getActiveExplorer: () => explorer,
    getActivePaneId: () => activePaneId,
  });
  stops.push(stop);
  const bind = (id: string, shortcut: string, scope: "pane" | "window" = id.startsWith("tabs.") || id.startsWith("pane.focus") || id === "view.switchPane" ? "window" : "pane") => { available.add(id); commandScopes.set(id, scope); keybindingsStore.registerDefault(id, shortcut); };
  const press = (key: string, modifiers: Partial<KeyboardEvent> = {}, handledLocally = false) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });
    // The focused control's own handler runs before the window listener sees it.
    if (handledLocally) event.preventDefault();
    target.dispatchEvent(event);
    return event;
  };
  return { target, executeCommand, bind, press, stop, available, dialogs, explorer, whens,
    setAffectedPanes(id: string, panes: readonly string[]) { affectedPanes.set(id, () => panes); },
    setActivePane(id: string) { activePaneId = id; },
  };
}

describe("pane dialog keyboard routing", () => {
  const scope = () => ({ paneId: "a", token: Symbol("pane") });
  it.each(["pane-a", "pane-b", "body", "no-element", "tab-strip", "toolbar", "sidebar"] as const)("Ctrl+T routes by %s target with live pane/window ownership", targetClass => {
    const ownership = createModalOwnership();
    ownership.register(() => {}, undefined, { scope: scope() });
    const f = fixture(false, [], ownership);
    f.bind("tabs.newTab", "Ctrl+T");
    if (targetClass !== "body") vi.stubGlobal("document", { body: new EventTarget() });
    if (targetClass.startsWith("pane-")) Object.assign(f.target, {
      closest: (selector: string) => selector === "[data-pane-id]" ? { getAttribute: () => targetClass === "pane-a" ? "a" : "b" } : null,
    });
    else if (targetClass === "no-element") Object.assign(f.target, { closest: undefined, tagName: undefined });
    else if (targetClass === "tab-strip") Object.assign(f.target, { tagName: "BUTTON" });
    const blocked = false;
    f.press("t", { ctrlKey: true });
    expect(f.executeCommand.mock.calls).toEqual(blocked ? [] : [["tabs.newTab"]]);
    f.executeCommand.mockClear();
    ownership.register(() => {});
    f.press("t", { ctrlKey: true });
    expect(f.executeCommand).not.toHaveBeenCalled();
  });
  it("Escape from the shared preview closes its active pane dialog after preview focus moved outside the overlay", () => {
    const ownership = createModalOwnership(), a = scope();
    const close = vi.fn();
    ownership.registerSurface(close, undefined, undefined, { scope: a });
    const f = fixture(false, [], ownership);
    vi.stubGlobal("document", { body: new EventTarget() });
    Object.assign(f.target, {
      closest: (selector: string) => selector === ".preview-pane" ? f.target : null,
    });
    f.dialogs.requestCloseTop.mockImplementation((event, scope) => { ownership.requestTopClose(event, scope); });
    f.press("Escape");
    expect(close).toHaveBeenCalledOnce();
    expect(f.dialogs.requestCloseTop).toHaveBeenCalledExactlyOnceWith(expect.any(Event), a);
  });
  it("allows configured pane/tab navigation from inputs while retaining dialog control keys", () => {
    const ownership = createModalOwnership(), a = scope();
    ownership.register(() => {}, undefined, { scope: a });
    const f = fixture(false, [], ownership);
    Object.assign(f.target, { tagName: "TEXTAREA" });
    f.bind("plugin.conflict", "Alt+Right");
    f.bind("view.switchPane", "Alt+Right");
    f.bind("tabs.nextTab", "Ctrl+Tab");
    f.bind("file.openSelected", "Ctrl+Enter");
    expect(f.press("ArrowRight", { altKey: true }).defaultPrevented).toBe(true);
    expect(f.press("Tab", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(f.press("Tab").defaultPrevented).toBe(false);
    expect(f.press("Enter", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(f.executeCommand.mock.calls.map(call => call[0])).toEqual(["view.switchPane", "tabs.nextTab"]);
  });
  it("eligible chords cannot admit unrelated commands sharing their prefix and suffix", () => {
    const ownership = createModalOwnership(); ownership.register(() => {}, undefined, { scope: scope() });
    const f = fixture(false, [], ownership);
    Object.assign(f.target, { tagName: "INPUT" });
    f.bind("file.delete", "Alt+M Ctrl+T"); f.bind("pane.focusRight", "Alt+M Ctrl+T");
    f.press("m", { altKey: true }); f.press("Control", { ctrlKey: true }); f.press("t", { ctrlKey: true });
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("pane.focusRight");
  });
  it("Escape in B leaves A open, while background Escape targets active A", () => {
    const ownership = createModalOwnership(), a = scope();
    ownership.register(() => {}, undefined, { scope: a });
    const f = fixture(false, [], ownership);
    Object.assign(f.target, { closest: (selector: string) => selector === "[data-pane-id]" ? { getAttribute: () => "b" } : null });
    expect(f.press("Escape").defaultPrevented).toBe(false);
    expect(f.dialogs.requestCloseTop).not.toHaveBeenCalled();
    Object.assign(f.target, { closest: () => null });
    f.press("Escape");
    expect(f.dialogs.requestCloseTop).toHaveBeenCalledExactlyOnceWith(expect.any(Event), a);
  });
  it("Escape in uncovered B retains its normal Clear Selection command while A stays open", () => {
    const ownership = createModalOwnership(), a = scope();
    ownership.register(() => {}, undefined, { scope: a });
    const f = fixture(false, [], ownership);
    f.setActivePane("b");
    Object.assign(f.target, { closest: (selector: string) => selector === "[data-pane-id]" ? { getAttribute: () => "b" } : null });
    f.bind("selection.clearSelection", "Escape");
    expect(f.press("Escape").defaultPrevented).toBe(true);
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("selection.clearSelection");
    expect(f.dialogs.requestCloseTop).not.toHaveBeenCalled();
    expect(ownership.hasPaneOpen("a")).toBe(true);
  });
  it("window ownership blocks pane navigation even from an uncovered event surface", () => {
    const ownership = createModalOwnership(); ownership.register(() => {}, undefined, { scope: scope() });
    ownership.register(() => {});
    const f = fixture(false, [], ownership);
    Object.assign(f.target, { closest: (selector: string) => selector === "[data-pane-id]" ? { getAttribute: () => "b" } : null });
    f.bind("pane.focusRight", "Alt+Right");
    expect(f.press("ArrowRight", { altKey: true }).defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
    f.press("Escape"); expect(f.dialogs.requestCloseTop).toHaveBeenCalledOnce();
  });
  it("ownership reservations immediately retire an in-progress Explorer chord", () => {
    const ownership = createModalOwnership(), f = fixture(false, [], ownership);
    f.bind("file.delete", "Alt+M T"); f.press("m", { altKey: true });
    const release = ownership.register(() => {}, undefined, { scope: scope() });
    release(); f.press("t");
    expect(f.executeCommand).not.toHaveBeenCalled();
  });
  it("window Escape wins over a formerly focused terminal surface", () => {
    const ownership = createModalOwnership(); ownership.register(() => {});
    const f = fixture(true, [], ownership);
    f.press("Escape"); expect(f.dialogs.requestCloseTop).toHaveBeenCalledOnce();
  });
  it("unavailable pane navigation leaves its binding with the dialog", () => {
    const ownership = createModalOwnership(); ownership.register(() => {}, undefined, { scope: scope() });
    const f = fixture(false, [], ownership);
    f.bind("pane.focusRight", "Alt+M T"); f.available.delete("pane.focusRight");
    expect(f.press("m", { altKey: true }).defaultPrevented).toBe(false);
    expect(f.press("t").defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
  });
});

describe("window keyboard ownership", () => {
  it.each([
    ["Ctrl+J M", [["j", { ctrlKey: true }], ["m", {}]]],
    ["Alt+M Ctrl+J", [["m", { altKey: true }], ["j", { ctrlKey: true }]]],
    ["Ctrl+, M", [[",", { ctrlKey: true }], ["m", {}]]],
    ["Alt+M Ctrl+F", [["m", { altKey: true }], ["f", { ctrlKey: true }]]],
    ["Ctrl+` M", [["`", { ctrlKey: true }], ["m", {}]]],
  ] as const)("configured %s dispatches without a hardcoded surface action", (shortcut, keys) => {
    const f = fixture();
    f.bind("navigation.goUp", shortcut);
    for (const [key, modifiers] of keys) f.press(key, modifiers);
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("navigation.goUp");
    expect(f.dialogs.openJobsPanel).not.toHaveBeenCalled();
    expect(f.dialogs.openSettings).not.toHaveBeenCalled();
    expect(f.explorer.openFilter).not.toHaveBeenCalled();
  });

  it("an unrelated key never evaluates chord availability guards (#1174)", () => {
    // `when` guards such as selection checks scan the whole listing; running
    // them for every chord on every arrow key made large folders lag.
    const f = fixture();
    const when = vi.fn(() => true);
    f.bind("navigation.goUp", "Ctrl+K U");
    f.whens.set("navigation.goUp", when);
    f.press("ArrowDown");
    f.press("Tab", { ctrlKey: true });
    expect(when).not.toHaveBeenCalled();
    f.press("k", { ctrlKey: true });
    f.press("u");
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("navigation.goUp");
  });

  it("a grid widget that handled an arrow key keeps it from window commands", () => {
    const f = fixture(false, ['[role="grid"]']);
    f.bind("navigation.goUp", "ArrowRight");
    f.press("ArrowRight", {}, true);
    expect(f.executeCommand).not.toHaveBeenCalled();
    // Keys the grid leaves alone still reach window commands.
    f.press("ArrowRight");
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("navigation.goUp");
  });

  it("consumes an unmatched Explorer suffix without opening native Find or a surface", () => {
    const f = fixture();
    f.bind("navigation.goUp", "Alt+M M");
    f.press("m", { altKey: true });
    expect(f.press("f", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(f.explorer.openFilter).not.toHaveBeenCalled();
    expect(f.executeCommand).not.toHaveBeenCalled();
    expect(keybindingsStore.isChordActive).toBe(false);
  });

  it("Ctrl+backtick belongs to the terminal after retiring the default shortcut", () => {
    const f = fixture(true);
    f.bind("navigation.goUp", "Ctrl+` M");
    f.press("`", { ctrlKey: true, code: "Backquote" });
    expect(f.executeCommand).not.toHaveBeenCalled();
  });

  it.each(["general.openTerminal", "view.toggleTerminal"])("a configured single %s toggle works while terminal input is focused", (commandId) => {
    const f = fixture(true);
    f.bind(commandId, "Ctrl+`");
    expect(f.press("`", { ctrlKey: true, code: "Backquote" }).defaultPrevented).toBe(true);
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith(commandId);
  });

  it("custom Quick Open chords remain terminal-owned while configured terminal-toggle chords work", () => {
    const f = fixture(true);
    f.bind("edit.copy", "Ctrl+C");
    f.bind("general.openQuickOpen", "Ctrl+P");
    keybindingsStore.setShortcut("edit.copy", "Alt+M M");
    keybindingsStore.setShortcut("general.openQuickOpen", "Alt+M P");
    expect(f.press("m", { altKey: true }).defaultPrevented).toBe(false);
    expect(f.press("p").defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
    f.bind("general.openTerminal", "Ctrl+`");
    keybindingsStore.setShortcut("general.openTerminal", "Alt+M Ctrl+T");
    expect(f.press("m", { altKey: true }).defaultPrevented).toBe(true);
    f.press("Control", { ctrlKey: true });
    f.press("t", { ctrlKey: true });
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("general.openTerminal");
  });

  it("input focus retires a custom chord before its suffix can execute", () => {
    const f = fixture();
    f.bind("navigation.goUp", "Ctrl+Alt+Up");
    keybindingsStore.setShortcut("navigation.goUp", "Alt+M M");
    f.press("m", { altKey: true });
    Object.assign(f.target, { tagName: "INPUT" });
    f.target.dispatchEvent(new Event("focusin"));
    expect(f.press("m").defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
    Object.assign(f.target, { tagName: "DIV" });
    f.press("m");
    expect(f.executeCommand).not.toHaveBeenCalled();
  });
  it("a terminal core shortcut dispatches its eligible command despite an earlier conflicting binding", () => {
    const f = fixture(true);
    f.bind("plugin.other", "Ctrl+P");
    f.bind("general.openQuickOpen", "Ctrl+P");
    f.press("p", { ctrlKey: true });
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("general.openQuickOpen");
  });

  it("a terminal toggle chord cannot dispatch another command sharing both prefix and suffix", () => {
    const f = fixture(true);
    f.bind("plugin.other", "Alt+M T");
    f.bind("general.openTerminal", "Alt+M T");
    f.press("m", { altKey: true });
    f.press("t");
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("general.openTerminal");
  });

  it.each(["blur", "dispose"] as const)("%s revokes a pending chord before a later key can complete it", (action) => {
    const f = fixture();
    f.bind("plugin.chord", "Alt+M T");
    f.press("m", { altKey: true });
    if (action === "blur") f.target.dispatchEvent(new Event("blur"));
    else f.stop();
    const result = keybindingsStore.findMatchingCommand({ key: "t", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent);
    expect(result).toBeUndefined();
  });
});


describe("window keyboard routing", () => {
  it.each(["Ctrl+F", "Ctrl+J", "Ctrl+,"])("terminal chord prefix %s keeps its command instead of a hardcoded action", (prefix) => {
    const f = fixture(true);
    f.bind("general.openTerminal", `${prefix} T`);
    f.press(prefix.slice(5).toLowerCase(), { ctrlKey: true });
    f.press("t");
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("general.openTerminal");
    expect(f.dialogs.openJobsPanel).not.toHaveBeenCalled();
    expect(f.dialogs.openSettings).not.toHaveBeenCalled();
    expect(f.explorer.openFilter).not.toHaveBeenCalled();
  });

  it("an unavailable core command leaves a conflicting key terminal-owned", () => {
    const f = fixture(true);
    f.bind("plugin.other", "Ctrl+P");
    f.bind("general.openQuickOpen", "Ctrl+P");
    f.available.delete("general.openQuickOpen");
    expect(f.press("p", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
  });

  it("an unavailable terminal chord cannot claim its prefix", () => {
    const f = fixture(true);
    f.bind("general.openTerminal", "Alt+M T");
    f.available.delete("general.openTerminal");
    expect(f.press("m", { altKey: true }).defaultPrevented).toBe(false);
    expect(f.press("t").defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
  });

  it("a mismatching terminal suffix retires the entire pending chord", () => {
    const f = fixture(true);
    f.bind("general.openTerminal", "Alt+M T");
    f.press("m", { altKey: true });
    expect(f.press("b").defaultPrevented).toBe(false);
    expect(f.press("t").defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
  });

  it("retains ordinary binding precedence outside the terminal", () => {
    const f = fixture();
    f.bind("plugin.other", "Ctrl+P");
    f.bind("general.openQuickOpen", "Ctrl+P");
    f.press("p", { ctrlKey: true });
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("plugin.other");
  });

  it("repeated Ctrl+F from an input consumes native find without toggling the filter", () => {
    const f = fixture();
    Object.assign(f.target, { tagName: "INPUT" });
    expect(f.press("f", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(f.press("f", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(f.explorer.openFilter).toHaveBeenCalledOnce();
    expect(f.explorer.closeFilter).not.toHaveBeenCalled();
  });

  it("modal Escape requests the top modal closure before the directory filter", () => {
    const f = fixture();
    f.dialogs.hasModalOpen = true;
    f.explorer.showFilter = true;
    f.press("Escape");
    expect(f.dialogs.requestCloseTop).toHaveBeenCalledOnce();
    expect(f.explorer.closeFilter).not.toHaveBeenCalled();
  });

  it("an already accepted modal Escape cannot request another closure", () => {
    const f = fixture();
    f.dialogs.hasModalOpen = true;
    f.press("Escape", {}, true);
    expect(f.dialogs.requestCloseTop).not.toHaveBeenCalled();
  });

  it("editable and modal contexts do not run ordinary commands or hardcoded settings/jobs", () => {
    const f = fixture();
    f.bind("plugin.run", "Ctrl+K");
    for (const context of ["input", "editable", "modal"]) {
      Object.assign(f.target, { tagName: context === "input" ? "INPUT" : "DIV", isContentEditable: context === "editable" });
      f.dialogs.hasModalOpen = context === "modal";
      for (const key of ["k", "j", ","]) expect(f.press(key, { ctrlKey: true }).defaultPrevented).toBe(false);
    }
    expect(f.executeCommand).not.toHaveBeenCalled();
    expect(f.dialogs.openJobsPanel).not.toHaveBeenCalled();
    expect(f.dialogs.openSettings).not.toHaveBeenCalled();
  });

  it("disposal removes listeners and releases held modifiers", () => {
    const f = fixture();
    f.bind("plugin.meta", "Cmd+K");
    f.press("Super");
    f.stop();
    f.stop();
    expect(f.press("k").defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
    expect(keybindingsStore.findMatchingCommand({ key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent)).toBeUndefined();
  });

  it("observes a rejected command without retaining keyboard ownership", async () => {
    const error = new Error("command failed");
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const f = fixture();
      f.bind("plugin.run", "Ctrl+K");
      f.executeCommand.mockRejectedValueOnce(error);
      f.press("k", { ctrlKey: true });
      await Promise.resolve();
      expect(report).toHaveBeenCalledWith("Keyboard command failed:", error);
      f.press("k", { ctrlKey: true });
      expect(f.executeCommand).toHaveBeenCalledTimes(2);
    } finally { report.mockRestore(); }
  });
});


describe("chord ownership transitions", () => {
  it.each(["editable-focus", "modal-key", "pointer"])("%s ends a chord before subsequent input can complete it", (transition) => {
    const f = fixture();
    f.bind("plugin.chord", "Alt+M T");
    f.press("m", { altKey: true });
    if (transition === "editable-focus") {
      Object.assign(f.target, { tagName: "INPUT" });
      f.target.dispatchEvent(new Event("focusin"));
      Object.assign(f.target, { tagName: "DIV" });
    } else if (transition === "modal-key") {
      f.dialogs.hasModalOpen = true;
      f.press("a");
      f.dialogs.hasModalOpen = false;
    } else f.target.dispatchEvent(new Event("pointerdown"));
    expect(f.press("t").defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
  });
});


it("handled splitter input retires chords while unhandled global shortcuts remain available", () => {
  const f = fixture();
  Object.assign(f.target, { closest: (selector: string) => selector === '[role="separator"]' ? f.target : null });
  f.bind("plugin.chord", "Alt+M T");
  f.bind("plugin.arrow", "ArrowRight");
  f.bind("general.openQuickOpen", "Ctrl+P");
  f.press("m", { altKey: true });
  const handled = new Event("keydown", { cancelable: true });
  Object.assign(handled, { key: "ArrowRight", code: "ArrowRight", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
  handled.preventDefault(); // The focused splitter accepted this resize.
  f.target.dispatchEvent(handled);
  f.press("t");
  expect(f.executeCommand).not.toHaveBeenCalled();
  f.press("p", { ctrlKey: true });
  expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("general.openQuickOpen");
});

describe("native button keyboard ownership", () => {
  it.each([
    ["Enter", "Enter"],
    [" ", "Space"],
  ])("leaves unmodified %s activation with the button", (key, shortcut) => {
    const f = fixture();
    Object.assign(f.target, { tagName: "BUTTON" });
    f.bind("plugin.buttonConflict", shortcut);

    expect(f.press(key).defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
  });

  it("retires a pending chord when the button accepts native activation", () => {
    const f = fixture();
    f.bind("plugin.chord", "Alt+M T");
    f.press("m", { altKey: true });
    Object.assign(f.target, { tagName: "BUTTON" });

    expect(f.press("Enter").defaultPrevented).toBe(false);
    Object.assign(f.target, { tagName: "DIV" });
    expect(f.press("t").defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
  });

  it("retains modified global shortcuts from a focused button", () => {
    const f = fixture();
    Object.assign(f.target, { tagName: "BUTTON" });
    f.bind("general.openQuickOpen", "Ctrl+P");

    expect(f.press("p", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("general.openQuickOpen");
  });
});

it.each([false, true])("honors accepted custom-button activation (pending chord: %s) without blocking unhandled shortcuts", (pendingChord) => {
  const f = fixture();
  Object.assign(f.target, { closest: (selector: string) => selector === '[role="button"]' ? f.target : null });
  f.bind("file.openSelected", "Enter");
  f.bind("general.openQuickOpen", "Ctrl+P");
  f.bind("plugin.chord", "Alt+M T");
  if (pendingChord) f.press("m", { altKey: true });
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: "Enter", code: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
  event.preventDefault(); // The row accepted Enter as its own activation.
  f.target.dispatchEvent(event);
  f.press("t");
  expect(f.executeCommand).not.toHaveBeenCalled();
  f.press("p", { ctrlKey: true });
  expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("general.openQuickOpen");
});

it("preserves Super-modified button shortcuts when WebKitGTK omits metaKey", () => {
  const f = fixture();
  Object.assign(f.target, { tagName: "BUTTON" });
  f.bind("plugin.modifiedActivation", "Cmd+Enter");
  f.press("Super");
  expect(f.press("Enter").defaultPrevented).toBe(true);
  expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("plugin.modifiedActivation");
});


describe("file-entry keyboard commands", () => {
  it.each([
    [" ", "Space", "view.togglePreviewPane"],
    ["Enter", "Enter", "file.openSelected"],
  ])("routes focused file-entry gridcell %s to its Explorer command", (key, shortcut, command) => {
    const f = fixture();
    Object.assign(f.target, {
      tagName: "BUTTON",
      role: "gridcell",
      matches: matchesAny(".file-list .entry-item"),
    });
    f.bind(command, shortcut);
    expect(f.press(key).defaultPrevented).toBe(true);
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith(command);
  });

  it.each([
    [" ", "Space", "view.togglePreviewPane"],
    ["Enter", "Enter", "file.openSelected"],
  ])("routes unmounted-cursor grid viewport %s to its Explorer command", (key, shortcut, command) => {
    const f = fixture();
    Object.assign(f.target, {
      tagName: "DIV",
      role: "grid",
      matches: matchesAny('.file-list .virtual-viewport[role="grid"]'),
    });
    f.bind(command, shortcut);

    expect(f.press(key).defaultPrevented).toBe(true);
    expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith(command);
  });

  it.each([
    ["mounted gridcell", "BUTTON", ".file-list .entry-item"],
    ["unmounted List cursor", "DIV", '.file-list .virtual-viewport[role="listbox"]'],
    ["unmounted List tree cursor", "DIV", '.file-list .virtual-viewport[role="tree"]'],
    ["unmounted-cursor viewport", "DIV", '.file-list .virtual-viewport[role="grid"]'],
  ])("does not redispatch a locally consumed arrow from the %s", (_surface, tagName, selector) => {
    const f = fixture();
    Object.assign(f.target, { tagName, matches: matchesAny(selector) });
    f.bind("plugin.arrow", "ArrowDown");
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, {
      key: "ArrowDown",
      code: "ArrowDown",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    });
    event.preventDefault();

    f.target.dispatchEvent(event);

    expect(f.executeCommand).not.toHaveBeenCalled();
  });

  it("leaves keys from a nested entry editor with the editor", () => {
    const f = fixture();
    Object.assign(f.target, {
      tagName: "INPUT",
      matches: matchesAny(),
      closest: (selector: string) => selector === ".entry-item" ? {} : null,
    });
    f.bind("plugin.arrow", "ArrowDown");
    f.bind("file.openSelected", "Enter");
    f.bind("view.togglePreviewPane", "Space");

    for (const key of ["ArrowDown", "Enter", " "]) {
      expect(f.press(key).defaultPrevented).toBe(false);
    }
    expect(f.executeCommand).not.toHaveBeenCalled();
  });
});


it.each([["Enter", "Enter"], [" ", "Space"]])(
  "keeps nested entry-control %s as native activation",
  (key, shortcut) => {
    const f = fixture();
    Object.assign(f.target, {
      tagName: "BUTTON",
      matches: () => false,
      closest: (selector: string) => selector === ".entry-item" ? {} : null,
    });
    f.bind("plugin.conflictingActivation", shortcut);
    expect(f.press(key).defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
  },
);


it.each([["Enter", "Enter"], [" ", "Space"]])(
  "keeps Miller-folder %s as native navigation",
  (key, shortcut) => {
    const f = fixture();
    Object.assign(f.target, {
      tagName: "BUTTON",
      matches: (selector: string) => selector === ".entry-item",
    });
    f.bind("plugin.conflictingActivation", shortcut);
    expect(f.press(key).defaultPrevented).toBe(false);
    expect(f.executeCommand).not.toHaveBeenCalled();
  },
);


it("keeps a file-entry Space accepted by type-ahead local", () => {
  const f = fixture();
  Object.assign(f.target, {
    tagName: "BUTTON",
    matches: matchesAny(".file-list .entry-item"),
  });
  f.bind("view.togglePreviewPane", "Space");
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: " ", code: "Space", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
  event.preventDefault();
  f.target.dispatchEvent(event);
  expect(f.executeCommand).not.toHaveBeenCalled();
});


it.each([false, true])("accepted media keys retire Explorer chords (pending: %s)", (pending) => {
  const f = fixture();
  Object.assign(f.target, { closest: (selector: string) => selector === ".video-preview" ? f.target : null });
  f.bind("file.openSelected", "Enter");
  f.bind("general.openQuickOpen", "Ctrl+P");
  f.bind("plugin.chord", "Alt+M T");
  if (pending) f.press("m", { altKey: true });
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: "Enter", code: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
  event.preventDefault();
  f.target.dispatchEvent(event);
  f.press("t");
  expect(f.executeCommand).not.toHaveBeenCalled();
  f.press("p", { ctrlKey: true });
  expect(f.executeCommand).toHaveBeenCalledExactlyOnceWith("general.openQuickOpen");
});


describe("command destination admission", () => {
  const rows = (["pane", "window"] as const).flatMap(scope =>
    (["pane-a", "pane-b", "body", "no-element", "tab-strip", "toolbar", "sidebar"] as const).flatMap(focus =>
      (["none", "active-pane", "other-pane", "window"] as const).map(modal => ({ scope, focus, modal }))));
  it.each(rows)("$scope command from $focus under $modal modality", ({ scope, focus, modal }) => {
    const ownership = createModalOwnership();
    if (modal !== "none") ownership.register(() => {}, undefined, { scope: modal === "window" ? null : { paneId: modal === "active-pane" ? "a" : "b", token: Symbol() } });
    const f = fixture(false, [], ownership);
    if (focus !== "body") vi.stubGlobal("document", { body: new EventTarget() });
    if (focus.startsWith("pane-")) Object.assign(f.target, { closest: (selector: string) => selector === "[data-pane-id]" ? { getAttribute: () => focus === "pane-a" ? "a" : "b" } : null });
    else if (focus === "no-element") Object.assign(f.target, { closest: undefined, tagName: undefined });
    else if (focus === "tab-strip") Object.assign(f.target, { tagName: "BUTTON" });
    f.bind("destination.command", "Ctrl+V", scope);
    f.press("v", { ctrlKey: true });
    const blocked = modal === "window" || (scope === "pane" && modal === "active-pane");
    expect(f.executeCommand.mock.calls).toEqual(blocked ? [] : [["destination.command"]]);
  });
  it.each([["edit.paste", "v", false], ["file.newFolder", "n", true]] as const)("covered active pane blocks %s from sidebar", (id, key, shiftKey) => {
    const ownership = createModalOwnership();
    ownership.register(() => {}, undefined, { scope: { paneId: "a", token: Symbol() } });
    const f = fixture(false, [], ownership);
    vi.stubGlobal("document", { body: new EventTarget() });
    f.bind(id, shiftKey ? "Ctrl+Shift+N" : "Ctrl+V", "pane");
    f.press(key, { ctrlKey: true, shiftKey });
    expect(f.executeCommand).not.toHaveBeenCalled();
  });
});


it.each(["a", "b", "c"])("cross-pane destination admission with a dialog on %s", coveredPane => {
  const ownership = createModalOwnership();
  ownership.register(() => {}, undefined, { scope: { paneId: coveredPane, token: Symbol() } });
  const f = fixture(false, [], ownership);
  vi.stubGlobal("document", { body: new EventTarget() });
  f.bind("pane.moveToOther", "Ctrl+V", "pane");
  f.setAffectedPanes("pane.moveToOther", ["a", "b"]);
  f.press("v", { ctrlKey: true });
  expect(f.executeCommand.mock.calls).toEqual(coveredPane === "c" ? [["pane.moveToOther"]] : []);
});

it.each(["f", "`"])("pane modal blocks fallback %s from window chrome using its command declaration", key => {
  const ownership = createModalOwnership();
  ownership.register(() => {}, undefined, { scope: { paneId: "a", token: Symbol() } });
  const f = fixture(false, [], ownership);
  vi.stubGlobal("document", { body: new EventTarget() });
  f.press(key, { ctrlKey: true });
  expect(f.explorer.openFilter).not.toHaveBeenCalled();
});

it.each(["Enter", " "])("pane dialog native button retains %j despite a rebound window command", key => {
  const ownership = createModalOwnership();
  ownership.register(() => {}, undefined, { scope: { paneId: "a", token: Symbol() } });
  const f = fixture(false, [], ownership);
  Object.assign(f.target, { tagName: "BUTTON" });
  f.bind("tabs.newTab", key === " " ? "Space" : key, "window");
  expect(f.press(key).defaultPrevented).toBe(false);
  expect(f.executeCommand).not.toHaveBeenCalled();
});
