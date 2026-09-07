import { beforeEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  label: "", seed: undefined as { handoff: { requestId: string } } | undefined,
  acknowledge: undefined as ((event: { payload: unknown }) => void) | undefined,
  finishCreation: undefined as (() => void) | undefined,
  failCreation: undefined as (() => void) | undefined,
  close: vi.fn(async () => {}), unlisten: vi.fn(), stopCreated: vi.fn(), stopError: vi.fn(),
  removePersisted: vi.fn(),
}));
vi.stubGlobal("window", { location: { origin: "http://localhost", pathname: "/", search: "" } });
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: vi.fn(function(label: string) {
  harness.label = label;
  return { close: harness.close, once: async (event: string, callback: () => void) => {
    if (event === "tauri://created") harness.finishCreation = callback;
    else harness.failCreation = callback;
    return event === "tauri://created" ? harness.stopCreated : harness.stopError;
  } };
}) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_event: string, callback: typeof harness.acknowledge) => { harness.acknowledge = callback; return harness.unlisten; },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  outerPosition: async () => ({ x: 0, y: 0 }), outerSize: async () => ({ width: 1200, height: 800 }),
}) }));
vi.mock("$lib/state/window-tabs.svelte", () => ({
  windowTabsManager: { windowLabel: "source", getActiveExplorer: () => undefined },
  tabSeedKey: (label: string) => `tab-seed:${label}`,
}));
vi.mock("$lib/state/settings.svelte", () => ({ settingsStore: { warmWindow: false } }));
vi.mock("$lib/state/persisted", () => ({
  savePersisted: (_key: string, value: typeof harness.seed) => { harness.seed = value; },
  removePersisted: harness.removePersisted,
}));
vi.mock("$lib/state/warm-window", () => ({ consumeWarmWindow: async () => null }));
vi.mock("$lib/state/window-appearance", () => ({ explorerWindowAppearance: () => ({}) }));
import { openNewWindow } from "$lib/state/commands/shared";

beforeEach(() => { harness.label = ""; harness.seed = undefined; harness.finishCreation = undefined; harness.failCreation = undefined; harness.close.mockClear(); harness.unlisten.mockClear(); harness.stopCreated.mockClear(); harness.stopError.mockClear(); harness.removePersisted.mockClear(); });

it("keeps tear-off pending until the child consumes and adopts its seed", async () => {
  let resolved = false;
  const pending = openNewWindow("/repo", undefined, { path: "/repo" }).then((child) => { resolved = true; return child; });
  await vi.waitFor(() => expect(harness.label).not.toBe(""));
  expect(resolved).toBe(false);
  harness.acknowledge!({ payload: { requestId: harness.seed!.handoff.requestId, targetWindow: harness.label } });
  harness.finishCreation!();
  expect(await pending).not.toBeNull();
  expect(harness.close).not.toHaveBeenCalled();
  expect(harness.unlisten).toHaveBeenCalledOnce();
  expect(harness.stopCreated).toHaveBeenCalledOnce();
  expect(harness.stopError).toHaveBeenCalledOnce();
});

it("returns failure and retires the child after asynchronous native creation failure", async () => {
  const pending = openNewWindow("/repo", undefined, { path: "/repo" });
  await vi.waitFor(() => expect(harness.label).not.toBe(""));
  harness.failCreation!();
  expect(await pending).toBeNull();
  expect(harness.close).toHaveBeenCalledOnce();
  expect(harness.removePersisted).toHaveBeenCalledWith(`tab-seed:${harness.label}`);
  expect(harness.unlisten).toHaveBeenCalledOnce();
  expect(harness.stopCreated).toHaveBeenCalledOnce();
  expect(harness.stopError).toHaveBeenCalledOnce();
});
