import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = {
  location: { origin: "http://localhost", pathname: "/", search: "" },
  dispatchEvent: vi.fn(),
} as unknown as Window & typeof globalThis;

const activation = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: unknown }) => Promise<void>) | undefined,
}));
const navigation = vi.hoisted(() => {
  let resolve = () => {};
  return {
    navigateTo: vi.fn(() => new Promise<void>((done) => { resolve = done; })),
    resolve: () => resolve(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => Promise<void>) => {
    activation.listener = handler;
    return () => {};
  }),
  emitTo: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "explorer-warm-123",
    setPosition: vi.fn(async () => {}),
    setSize: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
    setSkipTaskbar: vi.fn(async () => {}),
    unminimize: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
    setAlwaysOnTop: vi.fn(async () => {}),
  }),
}));
vi.mock("@tauri-apps/api/dpi", () => ({
  PhysicalPosition: vi.fn(function (x: number, y: number) { return { x, y }; }),
  PhysicalSize: vi.fn(function (width: number, height: number) { return { width, height }; }),
}));
vi.mock("../../src/lib/api/files", () => ({ logStartupTiming: vi.fn(async () => {}) }));
vi.mock("../../src/lib/api/warm-pool", () => ({
  warmPoolBeginSpawn: vi.fn(),
  warmPoolCancelSpawn: vi.fn(),
  warmPoolClaim: vi.fn(),
  warmPoolDiscard: vi.fn(),
  warmPoolRegister: vi.fn(async () => {}),
}));
vi.mock("../../src/lib/state/window-tabs.svelte", () => ({
  windowTabsManager: {
    getActiveExplorer: () => ({
      currentPath: "/parked/path",
      navigateTo: navigation.navigateTo,
      setViewMode: vi.fn(),
    }),
  },
}));
vi.mock("../../src/lib/state/window-appearance", () => ({
  explorerWindowAppearance: vi.fn(() => ({})),
}));
vi.mock("../../src/lib/state/settings.svelte", () => ({
  settingsStore: { init: vi.fn(async () => {}) },
}));
vi.mock("../../src/lib/state/theme.svelte", () => ({
  themeStore: { syncFromSettings: vi.fn() },
}));
vi.mock("../../src/lib/state/window-title.svelte", () => ({
  resolveLaunchHomePath: () => "/home/user",
}));

import { runWarmWindow, type WarmActivatePayload } from "../../src/lib/state/warm-window";

describe("warm child address-bar focus request", () => {
  beforeEach(() => {
    activation.listener = undefined;
    navigation.navigateTo.mockClear();
    window.dispatchEvent = vi.fn();
  });

  it("waits for the requested directory before focusing the address bar", async () => {
    await runWarmWindow(false);
    const reveal = activation.listener!({
      payload: { path: "/requested/path" } satisfies WarmActivatePayload,
    });

    await vi.waitFor(() => expect(navigation.navigateTo).toHaveBeenCalledWith("/requested/path"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.dispatchEvent).not.toHaveBeenCalled();

    navigation.resolve();
    await reveal;
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "explorer:focus-address-bar" }),
    );
  });
});
