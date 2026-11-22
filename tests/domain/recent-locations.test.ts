import { describe, expect, it } from "vitest";
import { ejectedDriveHidesPath, isRecentLocationListed } from "$lib/domain/recent-locations";
import { TRASH_PATH } from "$lib/domain/virtual-path";

const none = new Set<string>();

describe("isRecentLocationListed (#1893)", () => {
  it("never lists the Recycle Bin, which is recorded in frecency for Quick Open", () => {
    expect(isRecentLocationListed(TRASH_PATH, "C:\\Users\\me", none, none)).toBe(false);
    expect(isRecentLocationListed(TRASH_PATH, "/home/me", none, none)).toBe(false);
    // Already-persisted entries with another spelling stay hidden too.
    expect(isRecentLocationListed("TRASH://", "C:\\Users\\me", none, none)).toBe(false);
  });

  it("still lists ordinary folders", () => {
    expect(isRecentLocationListed("C:\\Users\\me\\Projects", "C:\\Users\\me", none, none)).toBe(true);
    expect(isRecentLocationListed("/home/me/src", "/home/me", none, none)).toBe(true);
  });

  it("hides home, roots and folders shown elsewhere", () => {
    expect(isRecentLocationListed("/home/me", "/home/me", none, none)).toBe(false);
    expect(isRecentLocationListed("/", null, none, none)).toBe(false);
    expect(isRecentLocationListed("C:\\Users\\Me\\Docs\\", null, new Set(["c:/users/me/docs"]), none)).toBe(false);
  });

  it("hides paths on ejected drives", () => {
    expect(ejectedDriveHidesPath("E:\\photos", none)).toBe(true);
    expect(ejectedDriveHidesPath("E:\\photos", new Set(["e:"]))).toBe(false);
    expect(ejectedDriveHidesPath("C:\\photos", none)).toBe(false);
    expect(isRecentLocationListed("/media/me/usb/x", null, none, none)).toBe(false);
  });
});
