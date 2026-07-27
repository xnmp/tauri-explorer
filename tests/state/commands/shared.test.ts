import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = {
  location: { origin: "http://localhost", pathname: "/" },
  __LAUNCH_DATA__: { home: "/home/user" },
} as unknown as Window & typeof globalThis;

const created = vi.hoisted(() => ({
  calls: [] as Array<{ label: string; options: Record<string, unknown> }>,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: vi.fn(function (label: string, options: Record<string, unknown>) {
    created.calls.push({ label, options });
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    outerPosition: async () => ({ x: 10, y: 20 }),
    outerSize: async () => ({ width: 1200, height: 800 }),
  }),
}));
vi.mock("../../../src/lib/state/window-tabs.svelte", () => ({
  windowTabsManager: { getActiveExplorer: () => undefined },
  tabSeedKey: (label: string) => label,
}));
vi.mock("../../../src/lib/state/settings.svelte", () => ({
  settingsStore: { warmWindow: false },
}));
vi.mock("../../../src/lib/state/persisted", () => ({ savePersisted: vi.fn() }));
vi.mock("../../../src/lib/state/warm-window", () => ({
  consumeWarmWindow: vi.fn(async () => false),
}));
vi.mock("../../../src/lib/state/window-appearance", () => ({
  explorerWindowAppearance: () => ({}),
}));

import { openNewWindow } from "../../../src/lib/state/commands/shared";

describe("openNewWindow", () => {
  beforeEach(() => {
    created.calls.length = 0;
  });

  it("creates a child window with its requested directory title", async () => {
    await openNewWindow("/work/alpha");
    expect(created.calls).toHaveLength(1);
    expect(created.calls[0].options.title).toBe("alpha - Tauri Explorer");
  });
});
