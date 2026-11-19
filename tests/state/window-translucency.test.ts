/**
 * A window's material (#1757) is fixed once its settings have loaded; a page
 * that follows the setting (the site demo's frame, whose backdrop is the host
 * page) changes material whenever the Translucency setting does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function load(page: Record<string, unknown>, settings: { translucency: unknown }) {
  vi.resetModules();
  vi.stubGlobal("window", { location: { search: "" }, ...page });
  vi.doMock("$lib/domain/platform", () => ({ isMac: false, isWindows: false }));
  vi.doMock("$lib/state/settings.svelte", () => ({ settingsStore: settings }));
  return import("$lib/state/window-translucency.svelte");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("$lib/domain/platform");
  vi.doUnmock("$lib/state/settings.svelte");
});

describe("window material", () => {
  it("keeps the material an inferred window settled with", async () => {
    const settings = { translucency: true };
    const m = await load({ __TRANSLUCENCY_MATERIAL__: "acrylic" }, settings);
    m.settleWindowMaterial();
    settings.translucency = false;
    expect(m.windowMaterial()).toBe("acrylic");
    expect(m.newWindowMaterial()).toBeNull();
  });

  it("follows the setting for its whole life once told to, even after settling", async () => {
    const settings = { translucency: false };
    const m = await load({ __TRANSLUCENCY_MATERIAL__: "acrylic" }, settings);
    m.followTranslucencySetting();
    m.settleWindowMaterial();
    expect(m.windowMaterial()).toBeNull();
    settings.translucency = true;
    expect(m.windowMaterial()).toBe("acrylic");
    settings.translucency = false;
    expect(m.windowMaterial()).toBeNull();
  });

  it("follows the setting even where the creator named a material", async () => {
    const settings = { translucency: false };
    const m = await load({ __TRANSLUCENCY_MATERIAL__: "acrylic", __WINDOW_MATERIAL__: "acrylic" }, settings);
    expect(m.windowMaterial()).toBe("acrylic");
    m.followTranslucencySetting();
    expect(m.windowMaterial()).toBeNull();
  });

  it("never shows a material the platform does not offer, nor for a malformed setting", async () => {
    const settings: { translucency: unknown } = { translucency: true };
    const m = await load({}, settings);
    m.followTranslucencySetting();
    expect(m.windowMaterial()).toBeNull();
    const n = await load({ __TRANSLUCENCY_MATERIAL__: "acrylic" }, { translucency: "true" });
    n.followTranslucencySetting();
    expect(n.windowMaterial()).toBeNull();
  });
});
