import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keybindingsStore } from "$lib/state/keybindings.svelte";
import { startWindowKeyboard } from "$lib/state/window-keyboard";

const stops: (() => void)[] = [];
beforeEach(() => keybindingsStore._clearForTesting());
afterEach(() => { stops.splice(0).forEach((stop) => stop()); keybindingsStore._clearForTesting(); });

function fixture(terminalFocus = false) {
  const target = new EventTarget();
  // Exercise real EventTarget dispatch and the production binding matcher.
  Object.assign(target, { tagName: terminalFocus ? "TEXTAREA" : "DIV", closest: () => terminalFocus ? target : null });
  const executeCommand = vi.fn(async (_id: string) => {});
  const available = new Set<string>();
  const dialogs = { hasModalOpen: false, closeAll: vi.fn(), openJobsPanel: vi.fn(), openSettings: vi.fn() };
  const terminal = { enabled: true, toggle: vi.fn() };
  const explorer = {
    showFilter: false,
    openFilter: vi.fn(() => { explorer.showFilter = true; }),
    closeFilter: vi.fn(() => { explorer.showFilter = false; }),
  };
  const stop = startWindowKeyboard(target, {
    bindings: keybindingsStore,
    getCommand: (id) => available.has(id) ? {} : undefined,
    executeCommand,
    dialogs, terminal,
    toggleDualPane: vi.fn(),
    getActiveExplorer: () => explorer,
  });
  stops.push(stop);
  const bind = (id: string, shortcut: string) => { available.add(id); keybindingsStore.registerDefault(id, shortcut); };
  const press = (key: string, modifiers: Partial<KeyboardEvent> = {}) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });
    target.dispatchEvent(event);
    return event;
  };
  return { target, executeCommand, bind, press, stop, available, dialogs, terminal, explorer };
}

describe("window keyboard ownership", () => {
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

  it("modal Escape closes the modal before the directory filter", () => {
    const f = fixture();
    f.dialogs.hasModalOpen = true;
    f.explorer.showFilter = true;
    f.press("Escape");
    expect(f.dialogs.closeAll).toHaveBeenCalledOnce();
    expect(f.explorer.closeFilter).not.toHaveBeenCalled();
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
