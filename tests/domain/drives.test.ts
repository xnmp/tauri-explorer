import { describe, expect, it } from "vitest";
import { isUnderRoot, nextRemovableRoot } from "../../src/lib/domain/drives";

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
