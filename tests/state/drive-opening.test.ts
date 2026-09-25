import { expect, it, vi } from "vitest";
import { createDriveOpener } from "$lib/state/drive-opening";

const volume = { name: "USB Backup", path: "", kind: "removable" as const, device_id: "/org/freedesktop/UDisks2/block_devices/sdb1" };
function setup() {
  const deps = { mount: vi.fn().mockResolvedValue({ ok: true, data: "/media/USB Backup" }), navigate: vi.fn(), error: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) };
  return { ...deps, open: createDriveOpener(deps) };
}
it("mounts before navigating, preserving spaces in the returned path", async () => {
  const s = setup();
  let finish!: (value: unknown) => void;
  s.mount.mockImplementation(() => new Promise(r => { finish = r; }));
  const opening = s.open(volume);
  expect(s.mount).toHaveBeenCalledWith(volume.device_id);
  expect(s.navigate).not.toHaveBeenCalled();
  finish({ ok: true, data: "/media/USB Backup" });
  await opening;
  expect(s.navigate).toHaveBeenCalledExactlyOnceWith("/media/USB Backup");
  expect(s.refresh).toHaveBeenCalledOnce();
});
it("opens mounted volumes directly on every platform", async () => {
  const s = setup();
  for (const path of ["E:\\", "/Volumes/Backup", "/media/Google Drive"]) await s.open({ ...volume, path });
  expect(s.mount).not.toHaveBeenCalled();
  expect(s.navigate.mock.calls).toEqual([["E:\\"], ["/Volumes/Backup"], ["/media/Google Drive"]]);
});
it.each(["Not authorized", "Linux storage service (UDisks2) unavailable"])("reports %s without navigating", async error => {
  const s = setup(); s.mount.mockResolvedValue({ ok: false, error });
  await s.open(volume);
  expect(s.navigate).not.toHaveBeenCalled();
  expect(s.error).toHaveBeenCalledWith(expect.stringContaining(error));
});
it.each(["", "relative/path", "/media/bad\0path"])("rejects invalid mount result %j", async data => {
  const s = setup(); s.mount.mockResolvedValue({ ok: true, data });
  await s.open(volume);
  expect(s.navigate).not.toHaveBeenCalled();
  expect(s.error).toHaveBeenCalledOnce();
});
it("coalesces repeated clicks while a mount is pending", async () => {
  const s = setup(); let finish!: (value: unknown) => void;
  s.mount.mockImplementation(() => new Promise(r => { finish = r; }));
  const first = s.open(volume); const second = s.open(volume);
  expect(s.mount).toHaveBeenCalledOnce();
  finish({ ok: true, data: "/media/USB Backup" });
  await Promise.all([first, second]);
  expect(s.navigate).toHaveBeenCalledOnce();
});
