import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";

const { driver, invoke } = vi.hoisted(() => ({
  driver: { execute: vi.fn(), waitUntil: vi.fn() },
  invoke: vi.fn(),
}));
vi.mock("@wdio/globals", () => ({ browser: driver, $: vi.fn(), $$: vi.fn() }));
vi.mock("$lib/api/common", () => ({ invoke, extractError: String }));
vi.mock("$lib/api/e2e-hooks", () => ({ E2E_HOOKS_ENABLED: true }));
vi.mock("$lib/api/native-resource-session", () => ({ getNativeResourceSession: async () => "session" }));

import { gitWatchRepo, gitUnwatchRepo } from "../../src/lib/api/git";
import { waitForGitWatch } from "../../e2e-tauri/specs/helpers";

let documentStub: { documentElement: { dataset: Record<string, string> } };
beforeEach(() => {
  vi.resetAllMocks();
  documentStub = { documentElement: { dataset: {} } };
  vi.stubGlobal("document", documentStub);
  // WebDriver serializes the predicate: imported helpers must run on the
  // runner side, with only the resulting key crossing into the renderer.
  driver.execute.mockImplementation(async (predicate, target) =>
    runInNewContext(`(${predicate.toString()})(target)`, { document: documentStub, target }));
  driver.waitUntil.mockImplementation(async (predicate, options) => {
    if (!await predicate()) throw new Error(options.timeoutMsg);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("native Git-watch readiness", () => {
  it.each([
    ["Windows", "C:\\Users\\runner\\folder-00\\nested", "C:/Users/runner/folder-00/nested/"],
    ["UNC", "\\\\SERVER\\Share\\folder\\nested", "//server/share/folder/nested/"],
    ["WSL", "\\\\WSL.LOCALHOST\\Ubuntu\\home\\User\\nested", "//wsl.localhost/Ubuntu/home/User/nested/"],
    ["POSIX", "/home/runner/folder-00/nested", "/home/runner/folder-00/nested/"],
  ])("accepts the API's acknowledged %s lease and rejects its release", async (_platform, requested, resolved) => {
    invoke.mockResolvedValueOnce({ id: "lease", repoRoot: resolved });
    const acquired = await gitWatchRepo(requested);
    expect(acquired.ok).toBe(true);
    await expect(waitForGitWatch(requested)).resolves.toBeUndefined();

    if (!acquired.ok) throw new Error(acquired.error);
    invoke.mockResolvedValueOnce(undefined);
    expect((await gitUnwatchRepo(acquired.data)).ok).toBe(true);
    await expect(waitForGitWatch(requested)).rejects.toThrow("Git lease was never acknowledged");
  });

  it("does not accept missing, unacknowledged, or neighboring repository coverage", async () => {
    await expect(waitForGitWatch("C:\\repo\\nested")).rejects.toThrow("Git lease was never acknowledged");
    invoke.mockRejectedValueOnce("native acquisition failed");
    expect((await gitWatchRepo("C:\\repo\\nested")).ok).toBe(false);
    await expect(waitForGitWatch("C:\\repo\\nested")).rejects.toThrow("Git lease was never acknowledged");

    invoke.mockResolvedValueOnce({ id: "other", repoRoot: "C:/repo/nested-other" });
    expect((await gitWatchRepo("C:/repo/nested-other")).ok).toBe(true);
    await expect(waitForGitWatch("C:\\repo\\nested")).rejects.toThrow("Git lease was never acknowledged");
  });
});
