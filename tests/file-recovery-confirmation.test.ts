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

  it("forgetting names every folder that still holds files", () => {
    const copy = recoveryConfirmation("release", {
      retainedPath: "/source/.tauri-explorer-recovery-1",
      retainedPaths: ["/source/.tauri-explorer-recovery-1", "/target/.tauri-explorer-recovery-2"],
    })!;
    expect(copy.body).toContain("stay in /source/.tauri-explorer-recovery-1 and /target/.tauri-explorer-recovery-2");
  });

  it("forgetting names only the listed folders when the first one is gone", () => {
    // A discard that stopped after removing the source root keeps only the target's.
    const copy = recoveryConfirmation("release", {
      retainedPath: "/target/.tauri-explorer-recovery-2",
      retainedPaths: ["/target/.tauri-explorer-recovery-2"],
    })!;
    expect(copy.body).toContain("stay in /target/.tauri-explorer-recovery-2 for you");
    expect(copy.body).not.toContain("recovery-1");
  });

  it("forgetting without a recorded folder still says the files are kept", () => {
    for (const item of [{ retainedPath: null }, { retainedPath: null, retainedPaths: [] }]) {
      expect(recoveryConfirmation("release", item)!.body).toContain("stay where they are");
    }
  });
});
