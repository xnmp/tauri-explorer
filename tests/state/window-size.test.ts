/**
 * windowSizeStore (#467) — reactive window.innerWidth/innerHeight tracker
 * that feeds the preview pane's "auto" dock mode.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

describe("windowSizeStore", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has a safe default (0x0) when there is no `window` global (e.g. this test suite)", async () => {
    const { windowSizeStore } = await import("$lib/state/window-size.svelte");
    expect(windowSizeStore.width).toBe(0);
    expect(windowSizeStore.height).toBe(0);
  });

  it("sync() re-reads window.innerWidth/innerHeight", async () => {
    vi.stubGlobal("window", { innerWidth: 1920, innerHeight: 1080 });
    const { windowSizeStore } = await import("$lib/state/window-size.svelte");

    windowSizeStore.sync();

    expect(windowSizeStore.width).toBe(1920);
    expect(windowSizeStore.height).toBe(1080);
  });

  it("sync() picks up a changed size on a later call (simulating a resize event)", async () => {
    const size = { innerWidth: 1200, innerHeight: 900 };
    vi.stubGlobal("window", size);
    const { windowSizeStore } = await import("$lib/state/window-size.svelte");

    windowSizeStore.sync();
    expect(windowSizeStore.width).toBe(1200);

    size.innerWidth = 500;
    size.innerHeight = 1400;
    windowSizeStore.sync();

    expect(windowSizeStore.width).toBe(500);
    expect(windowSizeStore.height).toBe(1400);
  });
});
