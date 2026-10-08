import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTerminalKeyHandler } from "$lib/state/terminal-key-handler";
import { keybindingsStore } from "$lib/state/keybindings.svelte";
import { effectiveTerminalShortcuts, resolveTerminalShortcut } from "$lib/domain/terminal-keys";

beforeEach(() => keybindingsStore._clearForTesting());
afterEach(() => keybindingsStore._clearForTesting());
const event = (key: string, modifiers = {}) => ({ type: "keydown", key, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn(), ...modifiers } as unknown as KeyboardEvent);
function fixture(available = true) {
  keybindingsStore.registerDefaults({ "general.openTerminal": "Alt+M T", "navigation.goUp": "Ctrl+Alt+Up" });
  const effects = { copySelection: vi.fn(), clearSelection: vi.fn(), paste: vi.fn(), write: vi.fn() };
  const handle = createTerminalKeyHandler({ bindings: keybindingsStore, isAvailable: () => available, isMac: false,
    hasSelection: () => true, getSelection: () => "selected terminal text", ...effects,
    lineEditingSequence: (key) => resolveTerminalShortcut(key, effectiveTerminalShortcuts({}, true)) });
  return { handle, effects };
}
it.each([
  ["Ctrl+V M", event("v", { ctrlKey: true }), event("m")],
  ["Alt+M Ctrl+V", event("m", { altKey: true }), event("v", { ctrlKey: true })],
  ["Ctrl+C M", event("c", { ctrlKey: true }), event("m")],
  ["Alt+Left M", event("ArrowLeft", { altKey: true }), event("m")],
])("eligible %s dispatches without clipboard, selection or PTY effects", (shortcut, prefix, suffix) => {
  const { handle, effects } = fixture();
  keybindingsStore.setShortcut("general.openTerminal", shortcut);
  expect(handle(prefix)).toBe(false);
  expect(keybindingsStore.findMatchingCommand(prefix)).toBe("chord:waiting");
  expect(handle(suffix)).toBe(false);
  expect(keybindingsStore.findMatchingCommand(suffix)).toBe("general.openTerminal");
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
});
it("unrelated Explorer chords cannot claim terminal clipboard paste", () => {
  const { handle, effects } = fixture();
  keybindingsStore.setShortcut("navigation.goUp", "Ctrl+V M");
  handle(event("v", { ctrlKey: true }));
  expect(effects.paste).toHaveBeenCalledOnce();
  expect(effects.write).not.toHaveBeenCalled();
});
it("unavailable terminal chords leave clipboard paste owned by the terminal", () => {
  const { handle, effects } = fixture(false);
  keybindingsStore.setShortcut("general.openTerminal", "Ctrl+V M");
  handle(event("v", { ctrlKey: true }));
  expect(effects.paste).toHaveBeenCalledOnce();
});
it("ordinary terminal copy retains its exact text and clears selection", () => {
  const { handle, effects } = fixture();
  expect(handle(event("c", { ctrlKey: true }))).toBe(false);
  expect(effects.copySelection).toHaveBeenCalledExactlyOnceWith("selected terminal text");
  expect(effects.clearSelection).toHaveBeenCalledOnce();
});
it("ordinary terminal line editing writes the existing readline sequence", () => {
  const { handle, effects } = fixture();
  handle(event("ArrowLeft", { altKey: true }));
  expect(effects.write).toHaveBeenCalledExactlyOnceWith("\x1bb");
});
