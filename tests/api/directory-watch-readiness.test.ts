import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("$lib/api/common", () => ({
  invoke, isTauri: () => true, extractError: String,
  virtualPathGuard: () => null, dataUriToBlobUrl: () => "blob:test",
}));
vi.mock("$lib/api/native-resource-session", () => ({ getNativeResourceSession: async () => "session" }));
vi.mock("$lib/plugins/fs-providers", () => ({ providerFor: () => undefined }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("native watch readiness diagnostics", () => {
  it("retains other owners and pending or failed releases until the last acknowledgement", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_E2E_HOOKS", "1");
    const dataset: Record<string, string> = {};
    vi.stubGlobal("document", { documentElement: { dataset } });
    let nextId = 0;
    const releases: ReturnType<typeof deferred>[] = [];
    invoke.mockReset().mockImplementation((command: string, args: { path: string }) => {
      if (command === "watch_directory") return Promise.resolve({ id: String(++nextId), path: args.path });
      const release = deferred();
      releases.push(release);
      return release.promise;
    });
    const files = await import("$lib/api/files");
    const paths = (): string[] => JSON.parse(dataset.e2eReadyDirectoryWatches ?? "[]");
    const first = await files.watchDirectory("/a");
    const second = await files.watchDirectory("/a");
    const releaseFirst = files.unwatchDirectory(first);
    await settle();
    expect(paths()).toEqual(["/a"]);
    releases[0].resolve();
    await releaseFirst;
    expect(paths()).toEqual(["/a"]);

    const failure = files.unwatchDirectory(second);
    const failed = expect(failure).rejects.toThrow("retry");
    await settle();
    releases[1].reject(new Error("retry"));
    await failed;
    expect(paths()).toEqual(["/a"]);

    const retry = files.unwatchDirectory(second);
    await settle();
    const replacement = await files.watchDirectory("/a");
    releases[2].resolve();
    await retry;
    expect(paths()).toEqual(["/a"]);
    const last = files.unwatchDirectory(replacement);
    await settle();
    expect(paths()).toEqual(["/a"]);
    releases[3].resolve();
    await last;
    expect(paths()).toEqual([]);
  });

  it("does not access diagnostic DOM when hooks are disabled", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_E2E_HOOKS", "0");
    vi.stubGlobal("document", { get documentElement() { throw new Error("production touched hook DOM"); } });
    invoke.mockReset().mockResolvedValue({ id: "p", path: "/a" });
    const files = await import("$lib/api/files");
    const lease = await files.watchDirectory("/a");
    await files.unwatchDirectory(lease);
  });
});
