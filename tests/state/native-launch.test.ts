import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), open: vi.fn(), createTab: vi.fn() }));
vi.mock("$lib/api/common", () => ({ invoke: h.invoke, isTauri: () => true }));
vi.mock("$lib/domain/platform", () => ({ isMac: false, isWindows: false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("$lib/state/window-launch", () => ({ openNewWindow: h.open }));
vi.mock("$lib/state/window-tabs.svelte", () => ({ windowTabsManager: { createTab: h.createTab } }));
import { startNativeLaunchReceiver } from "$lib/state/native-launch";
beforeEach(() => {
  h.invoke.mockReset(); h.listen.mockReset(); h.open.mockReset(); h.createTab.mockReset();
  h.open.mockResolvedValue(null);
});
const win = (path: string) => ({ path, newTab: false });
const tab = (path: string) => ({ path, newTab: true });

it("opens launches that preceded the listener and serializes later notifications", async () => {
  let notify!: () => void;
  const unlisten = vi.fn();
  h.listen.mockImplementation(async (_event, callback) => { notify = callback; return unlisten; });
  h.invoke.mockResolvedValueOnce([win("/early")]).mockResolvedValueOnce([win("/later")]).mockResolvedValue([]);
  const stop = startNativeLaunchReceiver();
  await vi.waitFor(() => expect(h.open).toHaveBeenCalledExactlyOnceWith("/early"));
  notify(); notify();
  await vi.waitFor(() => expect(h.open.mock.calls).toEqual([["/early"], ["/later"]]));
  expect(h.createTab).not.toHaveBeenCalled();
  stop(); expect(unlisten).toHaveBeenCalledTimes(1);
});

it("opens --new-tab launches as tabs in this window, in order with window launches (#1478)", async () => {
  const order: string[] = [];
  h.createTab.mockImplementation((path: string) => { order.push(`tab:${path}`); });
  h.open.mockImplementation(async (path: string) => { order.push(`window:${path}`); return null; });
  h.listen.mockImplementation(async () => vi.fn());
  h.invoke.mockResolvedValueOnce([tab("/a"), win("/b"), tab("/c")]).mockResolvedValue([]);
  const stop = startNativeLaunchReceiver();
  await vi.waitFor(() => expect(order).toEqual(["tab:/a", "window:/b", "tab:/c"]));
  expect(h.createTab.mock.calls).toEqual([["/a"], ["/c"]]);
  expect(h.open).toHaveBeenCalledExactlyOnceWith("/b");
  stop();
});

it("retires a late subscription without consuming launch requests after session disposal", async () => {
  let complete!: (stop: () => void) => void;
  h.listen.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const stop = startNativeLaunchReceiver(); stop();
  const unlisten = vi.fn(); complete(unlisten);
  await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  expect(h.invoke).not.toHaveBeenCalled(); expect(h.open).not.toHaveBeenCalled();
  expect(h.createTab).not.toHaveBeenCalled();
});
