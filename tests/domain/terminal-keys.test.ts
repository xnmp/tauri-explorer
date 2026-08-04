import { describe, it, expect } from "vitest";
import {
  isShellReservedKey,
  resolveTerminalShortcut,
  defaultTerminalShortcuts,
  effectiveTerminalShortcuts,
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

  it("keeps non-core app bindings with the focused terminal while preserving core navigation", () => {
    // A terminal application must receive app-level bindings such as Ctrl+Q
    // (micro quit) and Ctrl+T (new tab) even when Explorer binds them too.
    expect(isShellReservedKey(key("q", { ctrlKey: true }), { appBound: true })).toBe(true);
    expect(isShellReservedKey(key("t", { ctrlKey: true }), { appBound: true })).toBe(true);

    // The explicit core-navigation allowlist remains available from the
    // terminal: Quick Open, Command Palette, and previous/next tab.
    expect(isShellReservedKey(key("p", { ctrlKey: true }), { appBound: true })).toBe(false);
    expect(isShellReservedKey(key("p", { ctrlKey: true, shiftKey: true }), { appBound: true })).toBe(false);
    expect(isShellReservedKey(key("PageUp", { ctrlKey: true }), { appBound: true })).toBe(false);
    expect(isShellReservedKey(key("PageDown", { ctrlKey: true }), { appBound: true })).toBe(false);
  });

  it("shell-critical Ctrl combos stay with the shell even when app-bound", () => {
    for (const k of ["c", "d", "v", "x", "z", "a"]) {
      expect(isShellReservedKey(key(k, { ctrlKey: true }), { appBound: true })).toBe(true);
    }
  });

  it("keeps Alt combos with the terminal", () => {
    expect(isShellReservedKey(key("m", { altKey: true }))).toBe(true);
    expect(isShellReservedKey(key("m", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("keeps non-core Meta/Super combos with the terminal", () => {
    expect(isShellReservedKey(key("q", { metaKey: true }))).toBe(true);
    expect(isShellReservedKey(key("p", { metaKey: true, altKey: true }))).toBe(true);
  });

  it("keeps non-core Ctrl+Shift combos with the terminal", () => {
    expect(isShellReservedKey(key("f", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("keeps function keys with the terminal even when Explorer binds them", () => {
    expect(isShellReservedKey(key("F5"), { appBound: true })).toBe(true);
    expect(isShellReservedKey(key("F5"), { appBound: false })).toBe(true);
    expect(isShellReservedKey(key("F5"))).toBe(true);
    expect(isShellReservedKey(key("F12"), { appBound: true })).toBe(true);
    expect(isShellReservedKey(key("F1"), { appBound: false })).toBe(true);
  });

  it("still keeps printable and navigation keys with the shell (not misread as F-keys)", () => {
    expect(isShellReservedKey(key("f"), { appBound: true })).toBe(true);
    expect(isShellReservedKey(key("ArrowUp"), { appBound: true })).toBe(true);
    expect(isShellReservedKey(key("5"), { appBound: true })).toBe(true);
    expect(isShellReservedKey(key("Enter"), { appBound: true })).toBe(true);
  });

  it("keeps non-core ⌘ combos with the terminal while allowing Cmd+P", () => {
    for (const k of ["c", "v", "x", "a", "z"]) {
      expect(isShellReservedKey(key(k, { metaKey: true }), { appBound: true, isMac: true })).toBe(true);
    }
    expect(isShellReservedKey(key("c", { metaKey: true }), { appBound: true })).toBe(true);
    expect(isShellReservedKey(key("p", { metaKey: true }), { appBound: true, isMac: true })).toBe(false);
    expect(isShellReservedKey(key("c", { metaKey: true, shiftKey: true }), { isMac: true })).toBe(true);
    expect(isShellReservedKey(key("c", { metaKey: true, altKey: true }), { isMac: true })).toBe(true);
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
    expect(ids).toContain("wordLeft");
    expect(ids).toContain("wordRight");
  });
});

describe("platform default shortcuts (#404)", () => {
  const kev = (k: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it("is empty off-mac — every key keeps native behavior", () => {
    expect(defaultTerminalShortcuts(false)).toEqual({});
    expect(resolveTerminalShortcut(kev("Home"), effectiveTerminalShortcuts({}, false))).toBeNull();
  });

  it("mac defaults: Home/End move to line start/end, Option+arrows move by word", () => {
    const map = effectiveTerminalShortcuts({}, true);
    expect(resolveTerminalShortcut(kev("Home"), map)).toBe("\x01");
    expect(resolveTerminalShortcut(kev("End"), map)).toBe("\x05");
    expect(resolveTerminalShortcut(kev("ArrowLeft", { altKey: true }), map)).toBe("\x1bb");
    expect(resolveTerminalShortcut(kev("ArrowRight", { altKey: true }), map)).toBe("\x1bf");
  });

  it("a user's empty binding disables a mac default (native key restored)", () => {
    const map = effectiveTerminalShortcuts({ beginningOfLine: "" }, true);
    expect(resolveTerminalShortcut(kev("Home"), map)).toBeNull();
    // Other defaults unaffected.
    expect(resolveTerminalShortcut(kev("End"), map)).toBe("\x05");
  });

  it("a user override replaces the default binding", () => {
    const map = effectiveTerminalShortcuts({ wordLeft: "Ctrl+Left" }, true);
    expect(resolveTerminalShortcut(kev("ArrowLeft", { altKey: true }), map)).toBeNull();
    expect(resolveTerminalShortcut(kev("ArrowLeft", { ctrlKey: true }), map)).toBe("\x1bb");
  });
});
