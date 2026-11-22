import { describe, expect, it } from "vitest";
import { isUnderRoot, nextRemovableRoot, sidebarCloudDrives } from "../../src/lib/domain/drives";

describe("isUnderRoot", () => {
  it("matches the root itself and children, not siblings", () => {
    expect(isUnderRoot("/run/media/usb", "/run/media/usb")).toBe(true);
    expect(isUnderRoot("/run/media/usb/photos", "/run/media/usb")).toBe(true);
    expect(isUnderRoot("/run/media/usb2", "/run/media/usb")).toBe(false);
    expect(isUnderRoot("/home/user", "/run/media/usb")).toBe(false);
  });
});

describe("nextRemovableRoot", () => {
  const roots = ["/run/media/usb", "/run/media/usb/nested"];

  it("picks the longest present root under the path", () => {
    expect(nextRemovableRoot(null, "/run/media/usb/nested/x", roots)).toBe(
      "/run/media/usb/nested",
    );
    expect(nextRemovableRoot(null, "/run/media/usb/other", roots)).toBe("/run/media/usb");
  });

  it("remembers the previous root after the drive disappears", () => {
    // Drive unplugged: roots list no longer contains it, path still under it.
    expect(nextRemovableRoot("/run/media/usb", "/run/media/usb/photos", [])).toBe(
      "/run/media/usb",
    );
  });

  it("resets when the user navigates elsewhere", () => {
    expect(nextRemovableRoot("/run/media/usb", "/home/user", [])).toBe(null);
  });

  it("returns null for empty path or when nothing matches", () => {
    expect(nextRemovableRoot("/run/media/usb", "", roots)).toBe(null);
    expect(nextRemovableRoot(null, "/home/user", roots)).toBe(null);
  });

  it("is idempotent on its own output (safe to re-run in one effect)", () => {
    const cases: Array<[string | null, string, string[]]> = [
      [null, "/run/media/usb/photos", roots],
      ["/run/media/usb", "/run/media/usb/photos", []],
      ["/run/media/usb", "/home/user", []],
    ];
    for (const [prev, path, present] of cases) {
      const once = nextRemovableRoot(prev, path, present);
      expect(nextRemovableRoot(once, path, present)).toBe(once);
    }
  });
});

describe("sidebarCloudDrives", () => {
  // Shape produced by the Windows backend for Google Drive for desktop (drives.rs).
  const windowsGoogle = {
    name: "Google Drive", path: "G:\\", kind: "cloud", detail: "G:", provider: "googledrive",
  };
  const wsl = { name: "Ubuntu", path: "\\\\wsl$\\Ubuntu\\home", kind: "cloud", provider: "wsl" };
  const fixed = { name: "C:", path: "C:\\", kind: "fixed" };

  it("keeps the Google Drive for desktop letter in the Windows sidebar (#1894)", () => {
    expect(sidebarCloudDrives([fixed, windowsGoogle, wsl], true)).toEqual([windowsGoogle, wsl]);
  });

  it("still omits the Linux Google Drive shortcut (#731)", () => {
    const gvfs = { name: "Google Drive", path: "/run/user/1000/gvfs/google-drive:host=gmail.com,user=a", kind: "cloud", provider: "googledrive" };
    const rclone = { name: "Remote", path: "/home/user/remote", kind: "cloud" };
    expect(sidebarCloudDrives([gvfs, rclone], false)).toEqual([rclone]);
  });
});
