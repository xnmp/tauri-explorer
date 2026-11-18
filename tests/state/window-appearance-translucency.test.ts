/**
 * JS-created explorer windows (fresh Ctrl+N children and parked warm windows
 * both build their options here) get the same window material as the Rust
 * main window (#1733, #1757): the platform's material while Translucency is
 * on, and an opaque, persisted-colour window otherwise or where the platform
 * has no material.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const PERSISTED_BG: [number, number, number, number] = [30, 30, 32, 255];

type Published = "vibrancy" | "acrylic" | "mica" | null | undefined;

async function appearance(platform: { isMac: boolean; isWindows: boolean }, published: Published, settings: object) {
  vi.resetModules();
  // The native side publishes the material on the page's global object.
  if (published !== undefined) vi.stubGlobal("window", { __TRANSLUCENCY_MATERIAL__: published });
  vi.doMock("$lib/domain/platform", () => platform);
  vi.doMock("$lib/state/settings.svelte", () => ({ settingsStore: settings }));
  vi.doMock("$lib/state/persisted", () => ({ EXPLORER_BG_RGBA_KEY: "bg", loadPersisted: () => PERSISTED_BG }));
  return (await import("$lib/state/window-appearance")).explorerWindowAppearance("Explorer");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("$lib/domain/platform");
  vi.doUnmock("$lib/state/settings.svelte");
  vi.doUnmock("$lib/state/persisted");
});

const MAC = { isMac: true, isWindows: false };
const WINDOWS = { isMac: false, isWindows: true };
const LINUX = { isMac: false, isWindows: false };

describe("explorer window appearance with Translucency on", () => {
  it("gives a macOS window the transparent, active Sidebar material and no opaque colour", async () => {
    const options = await appearance(MAC, "vibrancy", { translucency: true });
    expect(options.transparent).toBe(true);
    expect(options.backgroundColor).toBeUndefined();
    expect(options.windowEffects).toEqual({ effects: ["sidebar"], state: "active" });
  });

  it("gives a Windows window the material the native side picked for its build", async () => {
    const acrylic = await appearance(WINDOWS, "acrylic", { translucency: true });
    expect(acrylic.transparent).toBe(true);
    expect(acrylic.backgroundColor).toBeUndefined();
    expect(acrylic.windowEffects).toEqual({ effects: ["acrylic"] });

    const mica = await appearance(WINDOWS, "mica", { translucency: true });
    expect(mica.windowEffects).toEqual({ effects: ["mica"] });
  });

  it("keeps an opaque window where the platform offers no material (Windows 10, Linux)", async () => {
    const windows10 = await appearance(WINDOWS, null, { translucency: true });
    expect(windows10.transparent).toBe(false);
    expect(windows10.windowEffects).toBeUndefined();
    expect(windows10.backgroundColor).toEqual(PERSISTED_BG);

    const linux = await appearance(LINUX, undefined, { translucency: true });
    expect(linux).toEqual(await appearance(LINUX, undefined, { translucency: false }));
    expect(linux.windowEffects).toBeUndefined();
  });
});

describe("explorer window appearance with Translucency off", () => {
  it("keeps an opaque, persisted-colour window on macOS and Windows", async () => {
    for (const [platform, material] of [[MAC, "vibrancy"], [WINDOWS, "acrylic"]] as const) {
      const options = await appearance(platform, material, { translucency: false });
      expect(options.transparent).toBe(false);
      expect(options.backgroundColor).toEqual(PERSISTED_BG);
      expect(options.windowEffects).toBeUndefined();
    }
  });

  it("treats a malformed setting as off", async () => {
    const options = await appearance(MAC, "vibrancy", { translucency: "true" });
    expect(options.windowEffects).toBeUndefined();
  });
});
