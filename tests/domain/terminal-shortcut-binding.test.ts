import { describe, expect, it } from "vitest";
import { terminalBindingFor } from "$lib/domain/terminal-shortcut-binding";
import { defaultTerminalShortcuts } from "$lib/domain/terminal-keys";

describe("terminalBindingFor", () => {
  const defaults = { endOfLine: "End" };

  it("shows the platform default when the user has not overridden it", () => {
    expect(terminalBindingFor("endOfLine", {}, defaults)).toEqual({ binding: "End", isDefault: true });
  });

  it("shows an action with no default as an unbound default", () => {
    expect(terminalBindingFor("deleteWordLeft", {}, defaults)).toEqual({ binding: "", isDefault: true });
  });

  it("lets a user override win, including an empty (disabled) one", () => {
    expect(terminalBindingFor("endOfLine", { endOfLine: "Ctrl+E" }, defaults)).toEqual({ binding: "Ctrl+E", isDefault: false });
    expect(terminalBindingFor("endOfLine", { endOfLine: "" }, defaults)).toEqual({ binding: "", isDefault: false });
  });

  it("resolves against the real platform defaults", () => {
    for (const isMac of [true, false]) {
      const real = defaultTerminalShortcuts(isMac);
      for (const [id, binding] of Object.entries(real)) {
        expect(terminalBindingFor(id, {}, real)).toEqual({ binding, isDefault: true });
      }
    }
  });
});
