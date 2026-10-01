import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Drive } from "$lib/api/drives";

// A parked warm window reads its drive list once but runs no feed (re-read,
// pushes, poll) until it is activated; activation re-reads (#931).
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

it("a parked page reads its drives once but subscribes to and polls nothing", async () => {
  store = createDrivesStore(createForegroundGate(false));
  void store.startPolling();
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS * 10);
  expect(mocks.list).toHaveBeenCalledTimes(1);
  expect(store.removable).toEqual([usb]);
  expect(mocks.listen).not.toHaveBeenCalled();
  expect(mocks.live).not.toHaveBeenCalled();
});

it("activation starts the feeds and re-reads drives", async () => {
  const gate = createForegroundGate(false);
  store = createDrivesStore(gate);
  const started = store.startPolling();
  await gate.enterForeground();
  // enterForeground settles once the activation read has been applied.
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
  expect(mocks.list).toHaveBeenCalledTimes(1); // the parked boot read only
  expect(mocks.listen).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("a foreground page starts its feeds immediately, with one first read", async () => {
  store = createDrivesStore(createForegroundGate(true));
  await store.startPolling();
  expect(store.removable).toEqual([usb]);
  expect(mocks.live).toHaveBeenCalled();
  expect(mocks.list).toHaveBeenCalledTimes(2); // first read + the post-subscribe re-read
});

it("a foreground session stopped as soon as it starts leaks no poll", async () => {
  store = createDrivesStore(createForegroundGate(true));
  void store.startPolling();
  await store.stopPolling();
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS * 4);
  expect(vi.getTimerCount()).toBe(0);
  expect(mocks.list).toHaveBeenCalledTimes(1);
});
