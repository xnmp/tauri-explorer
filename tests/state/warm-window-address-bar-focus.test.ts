import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: { path: string } }) => Promise<void>) | undefined,
  dispatchEvent: vi.fn(),
  navigateTo: vi.fn<() => Promise<void>>(),
}));

(globalThis as { window?: unknown }).window = {
  location: { origin: "http://localhost", pathname: "/", search: "" },
  dispatchEvent: harness.dispatchEvent,
} as unknown as Window & typeof globalThis;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, listener: typeof harness.listener) => {
    harness.listener = listener;
    return () => {};
  }),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "explorer-warm-test",
    setTitle: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
    setSkipTaskbar: vi.fn(async () => {}),
    unminimize: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
    setAlwaysOnTop: vi.fn(async () => {}),
  }),
}));
vi.mock("@tauri-apps/api/dpi", () => ({
  PhysicalPosition: vi.fn(),
  PhysicalSize: vi.fn(),
}));
vi.mock("../../src/lib/state/window-tabs.svelte", () => ({
  windowTabsManager: {
    getActiveExplorer: () => ({
      currentPath: "/parked",
      navigateTo: harness.navigateTo,
      setViewMode: vi.fn(),
    }),
  },
}));
vi.mock("../../src/lib/state/settings.svelte", () => ({
  settingsStore: { init: vi.fn(async () => {}) },
}));
vi.mock("../../src/lib/state/theme.svelte", () => ({
  themeStore: { syncFromSettings: vi.fn() },
}));
vi.mock("../../src/lib/api/common", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("../../src/lib/api/files", () => ({ logStartupTiming: vi.fn(async () => {}) }));

import { runWarmWindow, type WarmActivatePayload } from "../../src/lib/state/warm-window";

describe("warm-window address-bar focus", () => {
  beforeEach(() => {
    harness.listener = undefined;
    harness.dispatchEvent.mockClear();
    harness.navigateTo.mockReset();
  });

  it("waits for delayed navigation before requesting address-bar focus", async () => {
    let finishNavigation!: () => void;
    harness.navigateTo.mockImplementation(() => new Promise<void>((resolve) => {
      finishNavigation = resolve;
    }));

    await runWarmWindow(false);
    const activation = harness.listener!({
      payload: { path: "/requested" } satisfies WarmActivatePayload,
    });

    await vi.waitFor(() => expect(harness.navigateTo).toHaveBeenCalledWith("/requested"));
    expect(harness.dispatchEvent).not.toHaveBeenCalled();

    finishNavigation();
    await activation;

    expect(harness.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "explorer:focus-address-bar" }),
    );
  });
});
