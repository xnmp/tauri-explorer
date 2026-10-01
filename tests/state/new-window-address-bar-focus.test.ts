import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = {
  location: { origin: "http://localhost", pathname: "/" },
  __LAUNCH_DATA__: { home: "/home/user" },
} as unknown as Window & typeof globalThis;

const created = vi.hoisted(() => ({ calls: [] as Array<{ options: { url: string } }> }));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: vi.fn(function (_label: string, options: { url: string }) {
    created.calls.push({ options });
    return {
      once: vi.fn(async (event: string, handler: () => void) => {
        if (event === "tauri://created") queueMicrotask(handler);
        return vi.fn();
      }),
      close: vi.fn(async () => {}),
    };
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    outerPosition: async () => ({ x: 10, y: 20 }),
    outerSize: async () => ({ width: 1200, height: 800 }),
  }),
}));
vi.mock("../../src/lib/state/window-tabs.svelte", () => ({
  windowTabsManager: { getActiveExplorer: () => undefined, windowLabel: "main" },
  tabSeedKey: (label: string) => label,
}));
vi.mock("../../src/lib/state/settings.svelte", () => ({ settingsStore: { warmWindow: false } }));
vi.mock("../../src/lib/state/persisted", () => ({
  savePersisted: vi.fn(),
  removePersisted: vi.fn(),
}));
vi.mock("../../src/lib/state/warm-window", () => ({ consumeWarmWindow: vi.fn(async () => null) }));
vi.mock("../../src/lib/state/window-appearance", () => ({ explorerWindowAppearance: () => ({}) }));

import { openNewWindow } from "../../src/lib/state/commands/shared";

describe("new-window address-bar focus request", () => {
  beforeEach(() => created.calls.length = 0);

  it("includes the one-shot focus request in the child window URL", async () => {
    await openNewWindow("/work/alpha");

    const url = new URL(created.calls[0].options.url);
    expect(url.searchParams.get("path")).toBe("/work/alpha");
    expect(url.searchParams.get("focusAddressBar")).toBe("1");
  });
});
