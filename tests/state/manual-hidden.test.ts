import { describe, it, expect, vi } from "vitest";

// Avoid the localStorage/config-file side effects; we only test key handling.
vi.mock("$lib/state/persisted", () => ({
  loadPersisted: () => ({}),
  savePersisted: vi.fn(),
  writeConfigQueued: vi.fn(),
}));
vi.mock("$lib/api/files", () => ({
  readConfigFile: vi.fn().mockResolvedValue({ ok: false }),
}));

import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";

describe("manualHiddenStore folder keys are separator-agnostic", () => {
  it("hides under parentDir() form ('/') and finds it under raw currentPath ('\\') on Windows", () => {
    // The context menu hides under parentDir(e.path) (forward slashes); the
    // display filter looks up by the raw backend currentPath (backslashes).
    manualHiddenStore.hide("C:/Users/me/Documents", ["secret.txt"]);

    expect(manualHiddenStore.isHidden("C:\\Users\\me\\Documents", "secret.txt")).toBe(true);
    expect(manualHiddenStore.namesIn("C:\\Users\\me\\Documents").has("secret.txt")).toBe(true);

    // Unhiding via the other separator form must also match.
    manualHiddenStore.unhide("C:\\Users\\me\\Documents", ["secret.txt"]);
    expect(manualHiddenStore.isHidden("C:/Users/me/Documents", "secret.txt")).toBe(false);
  });

  it("still works for plain unix paths", () => {
    manualHiddenStore.hide("/home/u/docs", ["a.txt"]);
    expect(manualHiddenStore.isHidden("/home/u/docs", "a.txt")).toBe(true);
    manualHiddenStore.unhide("/home/u/docs", ["a.txt"]);
    expect(manualHiddenStore.isHidden("/home/u/docs", "a.txt")).toBe(false);
  });
});
