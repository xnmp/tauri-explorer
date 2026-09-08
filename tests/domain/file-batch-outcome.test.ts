import { describe, expect, it } from "vitest";
import {
  affectedBatchPaths,
  fileBatchError,
  type FileBatchOutcome,
} from "$lib/domain/file-batch-outcome";

describe("file batch outcomes", () => {
  it("reports uncertain effects distinctly and counts work that never started", () => {
    const outcome: FileBatchOutcome = {
      succeeded: ["/docs/removed.txt"],
      failed: [{ path: "/docs/denied.txt", error: "Permission denied" }],
      uncertain: [{ path: "/docs/unknown.txt", error: "worker exited" }],
      unstarted: ["/docs/later-a.txt", "/docs/later-b.txt"],
    };

    expect(fileBatchError(outcome)).toBe(
      "/docs/denied.txt: Permission denied; "
      + "/docs/unknown.txt: outcome is uncertain; inspect the affected files before continuing: worker exited; "
      + "2 items were not started",
    );
  });

  it("publishes only confirmed and potentially affected paths", () => {
    const outcome: FileBatchOutcome = {
      succeeded: ["/docs/removed.txt"],
      failed: [{ path: "/docs/denied.txt", error: "Permission denied" }],
      uncertain: [{ path: "/docs/unknown.txt", error: "worker exited" }],
      unstarted: ["/docs/later.txt"],
    };

    expect(affectedBatchPaths(outcome)).toEqual([
      "/docs/removed.txt",
      "/docs/unknown.txt",
    ]);
  });

  it("returns no error for an entirely successful batch", () => {
    expect(fileBatchError({ succeeded: ["/docs/removed.txt"], failed: [] })).toBeNull();
  });

  it("reports a committed warning while retaining the completed path for reconciliation", () => {
    const outcome: FileBatchOutcome = {
      succeeded: ["/docs/removed.txt"],
      failed: [],
      warnings: [{ path: "/docs/removed.txt", error: "Undo is unavailable" }],
    };

    expect(fileBatchError(outcome)).toBe("/docs/removed.txt: Undo is unavailable");
    expect(affectedBatchPaths(outcome)).toEqual(["/docs/removed.txt"]);
  });
});
