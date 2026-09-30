import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Drive } from "$lib/api/drives";

// Backend-pushed drive changes (#888): push-driven updates, the slow backstop
// poll while pushes are live, and fast polling whenever nothing is pushed.
const mocks = vi.hoisted(() => ({
  list: vi.fn(), live: vi.fn(), listen: vi.fn(), watch: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("$lib/api/drives", () => ({
  listDrives: mocks.list, driveUpdatesLive: mocks.live, DRIVES_CHANGED_EVENT: "drives-changed",
}));
vi.mock("$lib/api/files", () => ({ watchDirectory: mocks.watch, unwatchDirectory: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
import {
  drivesStore, PUSHED_POLL_INTERVAL_MS, UNPUSHED_POLL_INTERVAL_MS,
} from "$lib/state/drives.svelte";

const usb = (path: string | null): Drive => ({
  name: "USB Backup", path, kind: "removable", deviceId: "/org/freedesktop/UDisks2/block_devices/sdb1",
});
let backend: Drive[] = [];
function push(live: boolean) {
  mocks.handlers.get("drives-changed")!({ payload: { live } });
}
/** A mount-table or GVfs change: no liveness, which only UDisks reports. */
function pushChange() {
  mocks.handlers.get("drives-changed")!({ payload: {} });
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  // No mount-base watches: only the push and poll sources are under test.
  vi.stubGlobal("navigator", { userAgent: "test" });
  backend = [usb(null)];
  mocks.list.mockImplementation(async () => ({ ok: true, data: backend }));
  mocks.listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handlers.set(name, handler);
    return () => mocks.handlers.delete(name);
  });
});
afterEach(async () => {
  await drivesStore.stopPolling();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); mocks.handlers.clear();
});

it("applies a pushed mount immediately and otherwise waits for the slow backstop", async () => {
  mocks.live.mockResolvedValue(true);
  await drivesStore.startPolling();
  expect(drivesStore.removable[0].path).toBeNull();
  const reads = mocks.list.mock.calls.length;

  backend = [usb("/media/USB Backup")];
  push(true);
  await settle();
  expect(drivesStore.removable[0].path).toBe("/media/USB Backup");
  expect([...drivesStore.mountedRoots]).toEqual(["/media/USB Backup"]);
  expect(mocks.list.mock.calls.length).toBe(reads + 1);

  // An unpushed change (e.g. an rclone mount) is found only by the backstop.
  backend = [];
  await vi.advanceTimersByTimeAsync(PUSHED_POLL_INTERVAL_MS - 1000);
  expect(drivesStore.removable).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(drivesStore.removable).toHaveLength(0);
});

it("polls quickly when the backend cannot push drive changes", async () => {
  mocks.live.mockResolvedValue(false);
  await drivesStore.startPolling();
  backend = [];
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS);
  expect(drivesStore.removable).toHaveLength(0);
});

it("polls quickly without an event bus (browser mode)", async () => {
  mocks.listen.mockRejectedValue(new Error("no Tauri"));
  await drivesStore.startPolling();
  expect(mocks.live).not.toHaveBeenCalled();
  backend = [];
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS);
  expect(drivesStore.removable).toHaveLength(0);
});

it("returns to fast polling when the push source falls back, and back again", async () => {
  mocks.live.mockResolvedValue(true);
  await drivesStore.startPolling();
  push(false);
  await settle();
  backend = [];
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS);
  expect(drivesStore.removable).toHaveLength(0);

  push(true);
  await settle();
  backend = [usb(null)];
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS * 4);
  expect(drivesStore.removable).toHaveLength(0);
});

it("a push that lands during an in-flight read is re-read, not coalesced away", async () => {
  mocks.live.mockResolvedValue(true);
  await drivesStore.startPolling();
  let release!: () => void;
  mocks.list.mockImplementationOnce(() => {
    const stale = backend;
    return new Promise((resolve) => { release = () => resolve({ ok: true, data: stale }); });
  });
  const reading = drivesStore.refresh();
  backend = [usb("/media/USB Backup")];
  push(true);
  release();
  await reading;
  await settle();
  expect(drivesStore.removable[0].path).toBe("/media/USB Backup");
});

it("a stale liveness answer cannot override a newer push", async () => {
  let answer!: (live: boolean) => void;
  mocks.live.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  const starting = drivesStore.startPolling();
  await vi.waitFor(() => expect(answer).toBeDefined());
  push(false);
  answer(true);
  await starting;
  backend = [];
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS);
  expect(drivesStore.removable).toHaveLength(0);
});

it("a change before the push listener existed is read once the feed is live", async () => {
  mocks.live.mockResolvedValue(true);
  const listen = mocks.listen.getMockImplementation()!;
  mocks.listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
    // The mount lands after the initial read but before this subscription:
    // its push went to nobody.
    if (name === "drives-changed") backend = [usb("/media/USB Backup")];
    return listen(name, handler);
  });
  await drivesStore.startPolling();
  expect(drivesStore.removable[0].path).toBe("/media/USB Backup");
});

it("a push without liveness refreshes at once but keeps the cadence", async () => {
  mocks.live.mockResolvedValue(true);
  await drivesStore.startPolling();
  backend = [usb("/media/USB Backup")];
  pushChange();
  await settle();
  expect(drivesStore.removable[0].path).toBe("/media/USB Backup");
  backend = [];
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS * 4);
  expect(drivesStore.removable).toHaveLength(1);
});

it("a mount-table push racing a UDisks outage cannot restore the slow poll", async () => {
  mocks.live.mockResolvedValue(true);
  await drivesStore.startPolling();
  // The monitor falls back, then a mount-table change is pushed right after.
  push(false);
  pushChange();
  await settle();
  backend = [];
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS);
  expect(drivesStore.removable).toHaveLength(0);
});

it("a push without liveness does not invalidate the pending liveness query", async () => {
  let answer!: (live: boolean) => void;
  mocks.live.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  const starting = drivesStore.startPolling();
  await vi.waitFor(() => expect(answer).toBeDefined());
  pushChange();
  answer(true);
  await starting;
  backend = [];
  await vi.advanceTimersByTimeAsync(UNPUSHED_POLL_INTERVAL_MS * 4);
  expect(drivesStore.removable).toHaveLength(1);
});

it("Linux watches no mount directories: the backend pushes mount changes", async () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
  mocks.live.mockResolvedValue(true);
  await drivesStore.startPolling();
  expect(mocks.watch).not.toHaveBeenCalled();
});

it("stopping removes the push listener", async () => {
  mocks.live.mockResolvedValue(true);
  await drivesStore.startPolling();
  expect(mocks.handlers.has("drives-changed")).toBe(true);
  await drivesStore.stopPolling();
  expect(mocks.handlers.has("drives-changed")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
