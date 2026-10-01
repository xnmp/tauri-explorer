import { describe, expect, it } from "vitest";
import { copySessionError } from "$lib/domain/copy-session";

describe("copy outcome presentation", () => {
  it("does not call an interrupted, unstarted suffix successful", () => {
    expect(copySessionError(["/src/a", "/src/b"], {
      items: [{ status: "skipped" }, { status: "unstarted" }], cancelled: false, warnings: ["worker interrupted"],
    })).toContain("b: Copy did not start");
  });

  it("keeps intentional cancellation quiet but still reports uncertain effects", () => {
    expect(copySessionError(["/src/a", "/src/b"], {
      items: [{ status: "failed", error: "Copy cancelled" }, { status: "unstarted" }], cancelled: true, warnings: [],
    })).toBeNull();
    expect(copySessionError(["/src/a"], {
      items: [{ status: "uncertain", error: "Copy cancelled after publication began" }], cancelled: true, warnings: [],
    })).toContain("Copy incomplete");
  });

  it("bounds a huge failure selection while stating the omitted count", () => {
    const paths = Array.from({ length: 10_000 }, (_, index) => `/src/item-${index}`);
    const error = copySessionError(paths, { items: paths.map(() => ({ status: "failed", error: "disk full" })), cancelled: false, warnings: [] });
    expect(error).toContain("item-19: disk full");
    expect(error).not.toContain("item-20:");
    expect(error).toContain("9980 additional items could not be copied");
    expect(error!.length).toBeLessThan(1000);
  });
});
