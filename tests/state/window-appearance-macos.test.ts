/**
 * JS-created explorer windows (fresh Ctrl+N children and parked warm windows
 * both build their options here) match the Rust main window's macOS vibrancy
 * (#1733), and are unchanged on other platforms or with vibrancy off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const PERSISTED_BG: [number, number, number, number] = [30, 30, 32, 255];

async function appearance(platform: { isMac: boolean; isWindows: boolean }, settings: object) {
  vi.resetModules();
  vi.doMock("$lib/domain/platform", () => platform);
  vi.doMock("$lib/state/window-backdrop", () => ({ windowsBackdropEffects: () => undefined }));
  vi.doMock("$lib/state/settings.svelte", () => ({ settingsStore: settings }));
  vi.doMock("$lib/state/persisted", () => ({ EXPLORER_BG_RGBA_KEY: "bg", loadPersisted: () => PERSISTED_BG }));
  return (await import("$lib/state/window-appearance")).explorerWindowAppearance("Explorer");
}

afterEach(() => {
  vi.doUnmock("$lib/domain/platform");
  vi.doUnmock("$lib/state/window-backdrop");
  vi.doUnmock("$lib/state/settings.svelte");
  vi.doUnmock("$lib/state/persisted");
});

const MAC = { isMac: true, isWindows: false };
const LINUX = { isMac: false, isWindows: false };

describe("explorer window appearance under macOS vibrancy", () => {
  it("gives a vibrant macOS window the transparent Sidebar material and no opaque colour", async () => {
    const options = await appearance(MAC, { macOsVibrancy: true, vibrancyBlur: true });
    expect(options.transparent).toBe(true);
    expect(options.backgroundColor).toBeUndefined();
    expect(options.windowEffects).toEqual({ effects: ["sidebar"], state: "active" });
  });

  it("keeps the window transparent but without material when Native Blur is off", async () => {
    const options = await appearance(MAC, { macOsVibrancy: true, vibrancyBlur: false });
    expect(options.transparent).toBe(true);
    expect(options.backgroundColor).toBeUndefined();
    expect(options.windowEffects).toBeUndefined();
  });

  it("keeps an opaque, persisted-colour macOS window while vibrancy is off", async () => {
    const options = await appearance(MAC, { macOsVibrancy: false, vibrancyBlur: true });
    expect(options.transparent).toBe(false);
    expect(options.backgroundColor).toEqual(PERSISTED_BG);
    expect(options.windowEffects).toBeUndefined();
  });

  it("ignores a vibrancy setting carried to Linux", async () => {
    const off = await appearance(LINUX, { macOsVibrancy: false, vibrancyBlur: true });
    const on = await appearance(LINUX, { macOsVibrancy: true, vibrancyBlur: true });
    expect(on).toEqual(off);
    expect(on.windowEffects).toBeUndefined();
    expect(on.backgroundColor).toEqual(PERSISTED_BG);
  });
});
