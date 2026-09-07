import { beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("$lib/api/common", () => ({
  invoke,
  extractError: (error: unknown) => String(error),
  virtualPathGuard: () => null,
  dataUriToBlobUrl: () => "blob:test",
}));
vi.mock("$lib/plugins/fs-providers", () => ({ providerFor: () => undefined }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));

beforeEach(() => { vi.resetModules(); invoke.mockReset(); });

it("shares one lazy session across concurrent Git and directory watches and their releases", async () => {
  let acknowledge!: (id: string) => void;
  invoke.mockImplementation((command, args) => {
    if (command === "native_resource_session") return new Promise<string>(resolve => { acknowledge = resolve; });
    if (command === "git_watch_repo") return Promise.resolve({ id: args.repoPath, repoRoot: args.repoPath });
    if (command === "watch_directory") return Promise.resolve({ id: `directory:${args.path}`, path: args.path });
    return Promise.resolve();
  });
  const [git, files] = await Promise.all([import("$lib/api/git"), import("$lib/api/files")]);
  expect(invoke).not.toHaveBeenCalled();
  const first = git.gitWatchRepo("/a");
  const second = files.watchDirectory("/b");
  expect(invoke.mock.calls).toEqual([["native_resource_session"]]);
  acknowledge("7");
  expect(await first).toEqual({ ok: true, data: { id: "/a", repoRoot: "/a" } });
  expect(await second).toEqual({ id: "directory:/b", path: "/b" });
  expect(invoke).toHaveBeenCalledWith("git_watch_repo", { repoPath: "/a", sessionId: "7" });
  expect(invoke).toHaveBeenCalledWith("watch_directory", { path: "/b", sessionId: "7" });
  expect(await git.gitUnwatchRepo({ id: "/a", repoRoot: "/a" })).toEqual({ ok: true, data: undefined });
  await files.unwatchDirectory({ id: "directory:/b", path: "/b" });
  expect(invoke).toHaveBeenCalledWith("git_unwatch_repo", { leaseId: "/a", sessionId: "7" });
  expect(invoke).toHaveBeenLastCalledWith("unwatch_directory", { leaseId: "directory:/b", sessionId: "7" });
  expect(invoke.mock.calls.filter(([command]) => command === "native_resource_session")).toHaveLength(1);
});

it("retries a failed acknowledgement without sending an unscoped watch", async () => {
  invoke.mockRejectedValueOnce("session unavailable");
  const api = await import("$lib/api/git");
  expect(await api.gitWatchRepo("/a")).toEqual({ ok: false, error: "session unavailable" });
  expect(invoke.mock.calls).toEqual([["native_resource_session"]]);
  invoke.mockResolvedValueOnce("8").mockResolvedValueOnce({ id: "lease", repoRoot: "/a" });
  expect((await api.gitWatchRepo("/a")).ok).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith("git_watch_repo", { repoPath: "/a", sessionId: "8" });
  expect(invoke.mock.calls.filter(([command]) => command === "native_resource_session")).toHaveLength(2);
});

it("does not re-acknowledge after stale Git or directory commands are rejected", async () => {
  invoke.mockResolvedValueOnce("9").mockRejectedValue("renderer replaced");
  const [git, files] = await Promise.all([import("$lib/api/git"), import("$lib/api/files")]);
  expect((await git.gitWatchRepo("/a")).ok).toBe(false);
  await expect(files.watchDirectory("/b")).rejects.toBe("renderer replaced");
  expect(invoke.mock.calls).toEqual([
    ["native_resource_session"],
    ["git_watch_repo", { repoPath: "/a", sessionId: "9" }],
    ["watch_directory", { path: "/b", sessionId: "9" }],
  ]);
});
