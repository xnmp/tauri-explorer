import { describe, expect, it, vi } from "vitest";

import { openRecycleBinWithFeedback } from "$lib/state/recycle-bin";

describe("openRecycleBinWithFeedback", () => {
  it("reports a native launcher failure to the user", async () => {
    const reportError = vi.fn();

    await openRecycleBinWithFeedback(
      async () => ({ ok: false, error: "No application is registered for the trash folder" }),
      reportError,
    );

    expect(reportError).toHaveBeenCalledWith(
      "Could not open Recycle Bin: No application is registered for the trash folder",
    );
  });
});
