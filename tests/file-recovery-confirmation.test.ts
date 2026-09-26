import { describe, expect, it } from "vitest";
import { recoveryConfirmation } from "$lib/domain/file-recovery";

describe("recovery confirmations", () => {
  it("restoring loses nothing and needs no confirmation", () => {
    expect(recoveryConfirmation("restore", { retainedPath: "/r" })).toBeNull();
  });

  it("discard states that files and Undo are destroyed", () => {
    const copy = recoveryConfirmation("discard", { retainedPath: "/r" })!;
    expect(copy.body).toContain("permanently deletes");
    expect(copy.body).toContain("Undo");
  });

  it("forgetting states that nothing is deleted and names where the files stay", () => {
    const copy = recoveryConfirmation("release", { retainedPath: "/volume/.tauri-explorer-recovery-9e41" })!;
    expect(copy.title).toMatch(/Forget/);
    expect(copy.body).toContain("Nothing is deleted");
    expect(copy.body).toContain("/volume/.tauri-explorer-recovery-9e41");
    expect(copy.body).not.toContain("permanently deletes");
  });

  it("forgetting without a recorded folder still says the files are kept", () => {
    const copy = recoveryConfirmation("release", { retainedPath: null })!;
    expect(copy.body).toContain("stay where they are");
  });
});
