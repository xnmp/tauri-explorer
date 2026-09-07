import { beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("$lib/api/common", () => ({ invoke, extractError: (error: unknown) => String(error) }));

beforeEach(() => { vi.resetModules(); invoke.mockReset(); });

it("acknowledges one lazy session before concurrent watch calls and retains it for release", async () => {
  let acknowledge!: (id: string) => void;
  invoke.mockImplementation((command, args) => {
    if (command === "git_watch_session") return new Promise<string>(resolve => { acknowledge = resolve; });
    if (command === "git_watch_repo") return Promise.resolve({ id: args.repoPath, repoRoot: args.repoPath });
    return Promise.resolve();
  });
  const api = await import("$lib/api/git");
  expect(invoke).not.toHaveBeenCalled();
  const first = api.gitWatchRepo("/a"), second = api.gitWatchRepo("/b");
  expect(invoke.mock.calls).toEqual([["git_watch_session"]]);
  acknowledge("7");
  expect(await first).toEqual({ ok: true, data: { id: "/a", repoRoot: "/a" } });
  expect(await second).toEqual({ ok: true, data: { id: "/b", repoRoot: "/b" } });
  expect(invoke).toHaveBeenCalledWith("git_watch_repo", { repoPath: "/a", sessionId: "7" });
  expect(invoke).toHaveBeenCalledWith("git_watch_repo", { repoPath: "/b", sessionId: "7" });
  expect(await api.gitUnwatchRepo({ id: "/a", repoRoot: "/a" })).toEqual({ ok: true, data: undefined });
  expect(invoke).toHaveBeenLastCalledWith("git_unwatch_repo", { leaseId: "/a", sessionId: "7" });
});

it("retries a failed acknowledgement without sending an unscoped watch", async () => {
  invoke.mockRejectedValueOnce("session unavailable");
  const api = await import("$lib/api/git");
  expect(await api.gitWatchRepo("/a")).toEqual({ ok: false, error: "session unavailable" });
  expect(invoke.mock.calls).toEqual([["git_watch_session"]]);
  invoke.mockResolvedValueOnce("8").mockResolvedValueOnce({ id: "lease", repoRoot: "/a" });
  expect((await api.gitWatchRepo("/a")).ok).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith("git_watch_repo", { repoPath: "/a", sessionId: "8" });
});

it("cannot silently adopt a replacement generation after a watch is rejected", async () => {
  invoke.mockResolvedValueOnce("9").mockRejectedValueOnce("renderer replaced").mockRejectedValueOnce("renderer replaced");
  const api = await import("$lib/api/git");
  expect((await api.gitWatchRepo("/a")).ok).toBe(false);
  expect((await api.gitWatchRepo("/b")).ok).toBe(false);
  expect(invoke.mock.calls).toEqual([
    ["git_watch_session"],
    ["git_watch_repo", { repoPath: "/a", sessionId: "9" }],
    ["git_watch_repo", { repoPath: "/b", sessionId: "9" }],
  ]);
});
