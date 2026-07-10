import { describe, it, expect } from "vitest";
import { isShellReservedKey } from "$lib/domain/terminal-keys";

const key = (mods: Partial<Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey">>) => ({
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe("isShellReservedKey (#249)", () => {
  it("keeps plain typing with the shell", () => {
    expect(isShellReservedKey(key({}))).toBe(true);
    expect(isShellReservedKey(key({ shiftKey: true }))).toBe(true);
  });

  it("keeps single-Ctrl readline combos with the shell (Ctrl+C, Ctrl+D, Ctrl+R…)", () => {
    expect(isShellReservedKey(key({ ctrlKey: true }))).toBe(true);
  });

  it("gives Alt combos to the app (Alt+M chord prefix)", () => {
    expect(isShellReservedKey(key({ altKey: true }))).toBe(false);
    expect(isShellReservedKey(key({ ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("gives Meta/Super combos to the app (Super+Alt pane splits)", () => {
    expect(isShellReservedKey(key({ metaKey: true }))).toBe(false);
    expect(isShellReservedKey(key({ metaKey: true, altKey: true }))).toBe(false);
  });

  it("gives Ctrl+Shift combos to the app (terminal-emulator convention)", () => {
    expect(isShellReservedKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});
