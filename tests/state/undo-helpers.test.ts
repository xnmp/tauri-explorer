import { describe, expect, it } from "vitest";
import type { HistoryAction } from "$lib/domain/file-history";
import { undoActionLabel } from "$lib/state/undo-helpers";

describe("undoActionLabel", () => {
  it("labels a native replacement completion by destination", () => {
    expect(undoActionLabel({ type: "replacement", path: "/dest/report.txt" })).toBe(
      "Replaced report.txt",
    );
  });

  it("uses the native batch presentation label when it contains replacements", () => {
    const action: HistoryAction = {
      type: "batch",
      actions: [
        { type: "replacement", path: "/dest/a.txt" },
        { type: "copy", copiedPath: "/dest/b.txt", parentDir: "/dest" },
      ],
      label: "Overwrote 2 items",
    };

    expect(undoActionLabel(action)).toBe("Overwrote 2 items");
  });
});
