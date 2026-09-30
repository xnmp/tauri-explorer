import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Drive } from "$lib/api/drives";

// A parked warm window runs no drive feed until it is activated, and
// activation loads drives before the window can be revealed (#931).
const mocks = vi.hoisted(() => ({ list: vi.fn(), live: vi.fn(), listen: vi.fn() }));
vi.mock("$lib/api/drives", () => ({
  listDrives: mocks.list, driveUpdatesLive: mocks.live, DRIVES_CHANGED_EVENT: "drives-changed",
}));
vi.mock("$lib/api/files", () => ({ watchDirectory: vi.fn(), unwatchDirectory: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
import { createDrivesStore, UNPUSHED_POLL_INTERVAL_MS } from "$lib/state/drives.svelte";
import { createForegroundGate } from "$lib/state/page-foreground";

const usb: Drive = { name: "USB Backup", path: "/media/USB Backup", kind: "removable" };
let store: ReturnType<typeof createDrivesStore>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { userAgent: "test" });
  mocks.list.mockResolvedValue({ ok: true, data: [usb] });
  mocks.live.mockResolvedValue(true);
  mocks.listen.mockResolvedValue(() => {});
});
afterEach(async () => {
  await store.stopPolling();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks();
});

it("a parked page reads, subscribes and polls nothing", async () => {
  store = createDrivesStore(createForegroundGate(false));
  void store.startPolling();
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS * 10);
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.listen).not.toHaveBeenCalled();
  expect(mocks.live).not.toHaveBeenCalled();
  expect(store.list).toEqual([]);
});

it("activation shows current drives as soon as the foreground is entered", async () => {
  const gate = createForegroundGate(false);
  store = createDrivesStore(gate);
  const started = store.startPolling();
  await gate.enterForeground();
  // The first read has been applied by the time activation may reveal the window.
  expect(store.removable).toEqual([usb]);
  await started;
  expect(mocks.listen).toHaveBeenCalledWith("drives-changed", expect.any(Function));
});

it("drives mounted while parked are shown on activation, not the boot-time list", async () => {
  const gate = createForegroundGate(false);
  store = createDrivesStore(gate);
  mocks.list.mockResolvedValue({ ok: true, data: [] });
  void store.startPolling();
  await vi.advanceTimersByTimeAsync(60_000);
  mocks.list.mockResolvedValue({ ok: true, data: [usb] });
  await gate.enterForeground();
  expect(store.removable).toEqual([usb]);
});

it("stopping a parked session settles it and activation afterwards starts nothing", async () => {
  const gate = createForegroundGate(false);
  store = createDrivesStore(gate);
  const started = store.startPolling();
  await store.stopPolling();
  await started;
  await gate.enterForeground();
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS * 4);
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.listen).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("a foreground page starts its feeds immediately", async () => {
  store = createDrivesStore(createForegroundGate(true));
  await store.startPolling();
  expect(store.removable).toEqual([usb]);
  expect(mocks.live).toHaveBeenCalled();
});
