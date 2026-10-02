import { expect, it, vi } from "vitest";
vi.mock("$lib/domain/platform", () => ({ isMac: true }));
import { formatShortcut } from "$lib/domain/keybinding-parser";
it("shows platform-appropriate modifiers for both chord steps", () => {
  expect(formatShortcut("Ctrl+K Ctrl+C")).toBe("Cmd+K Cmd+C");
  expect(formatShortcut("Ctrl+Meta+K Alt+M")).toBe("Ctrl+Cmd+K Alt+M");
});
