import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock, mutationMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), mutationMock: vi.fn() }));

vi.mock("$lib/api/common", () => ({
  invoke: invokeMock,
  extractError: (error: unknown) => String(error),
  virtualPathGuard: () => null,
  dataUriToBlobUrl: () => "blob:test",
  isTauri: () => false,
}));
vi.mock("$lib/api/file-mutations", () => ({ invokeFileMutation: mutationMock }));
vi.mock("$lib/plugins/fs-providers", () => ({ providerFor: () => undefined }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));

async function filesApi(hooks: boolean) {
  vi.resetModules();
  vi.stubEnv("VITE_E2E_HOOKS", hooks ? "1" : "0");
  invokeMock.mockReset().mockResolvedValue({
    format: "columns-v1", path: "/dir", path_prefix: null,
    columns: { names: [], paths: [], kinds: [], sizes: [], modified: [] },
  });
  mutationMock.mockReset().mockResolvedValue({ ok: true, data: { path: "/dir/new" } });
  return import("$lib/api/files");
}

afterEach(() => vi.unstubAllEnvs());

describe("files API test seams", () => {
  it("ignores installed interceptors in builds without hooks", async () => {
    const files = await filesApi(false);
    const begin = vi.fn(() => null);
    const afterMutation = vi.fn(async () => {});
    files.interceptDirectoryListings({ begin });
    files.interceptFileMutations(afterMutation);

    await expect(files.loadDirectory("/dir")).resolves.toMatchObject({ ok: true });
    await expect(files.createDirectory("/dir", "new")).resolves.toMatchObject({ ok: true });
    expect(begin).not.toHaveBeenCalled();
    expect(afterMutation).not.toHaveBeenCalled();
  });

  it("runs the listing continuation after decode and before the result returns", async () => {
    const files = await filesApi(true);
    const order: string[] = [];
    files.interceptDirectoryListings({
      begin: (path) => {
        order.push(`begin ${path}`);
        return async () => { order.push("settle"); };
      },
    });
    invokeMock.mockImplementation(async () => {
      order.push("invoke");
      return { format: "columns-v1", path: "/dir", path_prefix: null,
        columns: { names: [], paths: [], kinds: [], sizes: [], modified: [] } };
    });
    await files.loadDirectory("/dir");
    order.push("returned");
    expect(order).toEqual(["begin /dir", "invoke", "settle", "returned"]);
  });

  it("holds a successful create/rename until the mutation interceptor settles", async () => {
    const files = await filesApi(true);
    let release!: () => void;
    const seen: unknown[] = [];
    files.interceptFileMutations((command, target, result) => {
      seen.push([command, target, result]);
      return new Promise<void>((resolve) => { release = resolve; });
    });
    let settled = false;
    const creating = files.createDirectory("/dir", "new").then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(seen).toEqual([["create_directory", "/dir", "/dir/new"]]));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(creating).resolves.toEqual({ ok: true, data: { path: "/dir/new" } });
  });

  it("does not consult the mutation interceptor for a failed mutation", async () => {
    const files = await filesApi(true);
    const afterMutation = vi.fn(async () => {});
    files.interceptFileMutations(afterMutation);
    mutationMock.mockResolvedValue({ ok: false, error: "exists" });
    await expect(files.renameEntry("/dir/a", "b")).resolves.toEqual({ ok: false, error: "exists" });
    expect(afterMutation).not.toHaveBeenCalled();
  });

  it("removes an interceptor only through its own release", async () => {
    const files = await filesApi(true);
    const first = vi.fn(() => null);
    const second = vi.fn(() => null);
    const releaseFirst = files.interceptDirectoryListings({ begin: first });
    files.interceptDirectoryListings({ begin: second });
    releaseFirst(); // Stale release must not remove its replacement.
    await files.loadDirectory("/dir");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("/dir");
  });
});
