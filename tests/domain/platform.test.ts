import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("domain/platform", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    vi.resetModules();
  });

  function stubNavigator(platform: string) {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform },
      configurable: true,
      writable: true,
    });
  }

  describe("isMac", () => {
    it("returns true when navigator.platform starts with Mac", async () => {
      stubNavigator("MacIntel");
      const { isMac } = await import("$lib/domain/platform");
      expect(isMac).toBe(true);
    });

    it("returns false on Linux", async () => {
      stubNavigator("Linux x86_64");
      const { isMac } = await import("$lib/domain/platform");
      expect(isMac).toBe(false);
    });

    it("returns false on Windows", async () => {
      stubNavigator("Win32");
      const { isMac } = await import("$lib/domain/platform");
      expect(isMac).toBe(false);
    });

    it("returns false when navigator is undefined", async () => {
      // @ts-expect-error -- intentionally removing navigator
      delete globalThis.navigator;
      const { isMac } = await import("$lib/domain/platform");
      expect(isMac).toBe(false);
    });
  });

  describe("isCopyModifier", () => {
    it("checks altKey on macOS", async () => {
      stubNavigator("MacIntel");
      const { isCopyModifier } = await import("$lib/domain/platform");

      const withAlt = { altKey: true, ctrlKey: false } as MouseEvent;
      const withCtrl = { altKey: false, ctrlKey: true } as MouseEvent;
      const neither = { altKey: false, ctrlKey: false } as MouseEvent;

      expect(isCopyModifier(withAlt)).toBe(true);
      expect(isCopyModifier(withCtrl)).toBe(false);
      expect(isCopyModifier(neither)).toBe(false);
    });

    it("checks ctrlKey on Linux/Windows", async () => {
      stubNavigator("Linux x86_64");
      const { isCopyModifier } = await import("$lib/domain/platform");

      const withCtrl = { altKey: false, ctrlKey: true } as MouseEvent;
      const withAlt = { altKey: true, ctrlKey: false } as MouseEvent;
      const neither = { altKey: false, ctrlKey: false } as MouseEvent;

      expect(isCopyModifier(withCtrl)).toBe(true);
      expect(isCopyModifier(withAlt)).toBe(false);
      expect(isCopyModifier(neither)).toBe(false);
    });
  });
});
