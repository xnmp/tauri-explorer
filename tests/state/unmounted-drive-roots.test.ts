import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listDrives: vi.fn() }));
vi.mock("$lib/api/drives", () => mocks);
import { drivesStore } from "$lib/state/drives.svelte";
it("unmounted volumes remain listed but never count as mounted or remembered roots", async () => {
  mocks.listDrives.mockResolvedValue({ ok: true, data: [
    { name: "USB Backup", path: "", kind: "removable", device_id: "sdb1" },
    { name: "Other", path: "/media/Other", kind: "removable" },
  ] });
  await drivesStore.refresh();
  expect(drivesStore.removable).toHaveLength(2);
  expect([...drivesStore.mountedRoots]).toEqual(["/media/Other"]);
  expect(drivesStore.removableRoots).toEqual(["/media/Other"]);
  mocks.listDrives.mockResolvedValue({ ok: true, data: [] });
  await drivesStore.refresh();
  expect(drivesStore.removable).toEqual([]);
  expect(drivesStore.mountedRoots.size).toBe(0);
});
