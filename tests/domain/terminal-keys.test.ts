import { describe, it, expect } from "vitest";
import {
  isShellReservedKey,
  isHardcodedAppShortcut,
  resolveTerminalShortcut,
  TERMINAL_LINE_ACTIONS,
} from "$lib/domain/terminal-keys";

const key = (
  k: string,
  mods: Partial<Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "code">> = {},
) => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe("isShellReservedKey (#249, #260)", () => {
  it("keeps plain typing with the shell", () => {
    expect(isShellReservedKey(key("a"))).toBe(true);
    expect(isShellReservedKey(key("A", { shiftKey: true }))).toBe(true);
  });

  it("keeps unbound single-Ctrl readline combos with the shell (Ctrl+R, Ctrl+E…)", () => {
    expect(isShellReservedKey(key("r", { ctrlKey: true }))).toBe(true);
    expect(isShellReservedKey(key("e", { ctrlKey: true }), { appBound: false })).toBe(true);
  });

  it("gives app-bound single-Ctrl combos to the app (Ctrl+P quick open, #260)", () => {
    expect(isShellReservedKey(key("p", { ctrlKey: true }), { appBound: true })).toBe(false);
    expect(isShellReservedKey(key("t", { ctrlKey: true }), { appBound: true })).toBe(false);
  });

  it("shell-critical Ctrl combos stay with the shell even when app-bound", () => {
    for (const k of ["c", "d", "v", "x", "z", "a"]) {
      expect(isShellReservedKey(key(k, { ctrlKey: true }), { appBound: true })).toBe(true);
    }
  });

  it("gives Alt combos to the app (Alt+M chord prefix)", () => {
    expect(isShellReservedKey(key("m", { altKey: true }))).toBe(false);
    expect(isShellReservedKey(key("m", { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("gives Meta/Super combos to the app (Super+Alt pane splits)", () => {
    expect(isShellReservedKey(key("p", { metaKey: true }))).toBe(false);
    expect(isShellReservedKey(key("p", { metaKey: true, altKey: true }))).toBe(false);
  });

  it("gives Ctrl+Shift combos to the app (terminal-emulator convention)", () => {
    expect(isShellReservedKey(key("f", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

describe("isHardcodedAppShortcut (#260)", () => {
  it("recognizes the +page.svelte hardcoded shortcuts", () => {
    expect(isHardcodedAppShortcut(key("j", { ctrlKey: true }))).toBe(true);
    expect(isHardcodedAppShortcut(key(",", { ctrlKey: true }))).toBe(true);
    expect(isHardcodedAppShortcut(key("\\", { ctrlKey: true }))).toBe(true);
    expect(isHardcodedAppShortcut(key("Unidentified", { ctrlKey: true, code: "Backslash" }))).toBe(true);
  });

  it("rejects unmodified keys and Alt combos", () => {
    expect(isHardcodedAppShortcut(key("j"))).toBe(false);
    expect(isHardcodedAppShortcut(key("j", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isHardcodedAppShortcut(key("p", { ctrlKey: true }))).toBe(false);
  });
});

describe("resolveTerminalShortcut (#375)", () => {
  const kev = (k: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it("returns the mapped control sequence for a bound combo", () => {
    const map = { beginningOfLine: "Home", killLineBackward: "Ctrl+U" };
    expect(resolveTerminalShortcut(kev("Home"), map)).toBe("\x01");
    expect(resolveTerminalShortcut(kev("u", { ctrlKey: true }), map)).toBe("\x15");
  });

  it("supports Alt combos (Alt+Backspace → delete word)", () => {
    const map = { deleteWordBackward: "Alt+Backspace" };
    expect(resolveTerminalShortcut(kev("Backspace", { altKey: true }), map)).toBe("\x17");
    expect(resolveTerminalShortcut(kev("Backspace"), map)).toBeNull();
  });

  it("returns null with an empty map — native behavior is the default", () => {
    expect(resolveTerminalShortcut(kev("Home"), {})).toBeNull();
    expect(resolveTerminalShortcut(kev("c", { ctrlKey: true }), {})).toBeNull();
  });

  it("ignores unknown action ids and empty bindings", () => {
    expect(resolveTerminalShortcut(kev("Home"), { bogus: "Home", endOfLine: "" })).toBeNull();
  });

  it("exposes a stable action catalogue for the settings UI", () => {
    const ids = TERMINAL_LINE_ACTIONS.map((a) => a.id);
    expect(ids).toContain("beginningOfLine");
    expect(ids).toContain("endOfLine");
    expect(ids).toContain("deleteWordBackward");
    expect(ids).toContain("killLineBackward");
  });
});
