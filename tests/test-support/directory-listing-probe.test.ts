import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("$lib/api/common", () => ({
  invoke: invokeMock,
  extractError: (error: unknown) => String(error),
  virtualPathGuard: () => null,
  dataUriToBlobUrl: () => "blob:test",
  isTauri: () => false,
}));
vi.mock("$lib/plugins/fs-providers", () => ({ providerFor: () => undefined }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));

vi.stubEnv("VITE_E2E_HOOKS", "1");
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", { documentElement: { dataset: {} } });

const { loadDirectory, watchDirectory } = await import("$lib/api/files");
const { startDirectoryListingProbe } = await import("../../src/test-support/directory-listing-probe");

describe("directory listing native E2E probe", () => {
  let session: AbortController;

  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      format: "columns-v1", path: "/probe", path_prefix: null,
      columns: { names: [], paths: [], kinds: [], sizes: [], modified: [] },
    });
    for (const key of Object.keys(document.documentElement.dataset)) {
      delete document.documentElement.dataset[key];
    }
    session = new AbortController();
    startDirectoryListingProbe(session.signal);
  });

  afterEach(() => {
    session.abort();
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("delays a real listing of the armed path and reports it through DOM state", async () => {
    window.dispatchEvent(
      new CustomEvent("e2e-directory-listing-probe", {
        detail: { targetPath: "/probe", delays: [500] },
      }),
    );

    const completed = vi.fn();
    const listing = loadDirectory("/probe").then((result) => {
      completed();
      return result;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(completed).not.toHaveBeenCalled();
    expect(JSON.parse(document.documentElement.dataset.e2eDirectoryListingProbe ?? "null"))
      .toMatchObject({ calls: 1, completed: 0 });

    await vi.advanceTimersByTimeAsync(1);
    await expect(listing).resolves.toMatchObject({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("list_directory_fresh", { path: "/probe" });
    expect(JSON.parse(document.documentElement.dataset.e2eDirectoryListingProbe ?? "null"))
      .toMatchObject({ calls: 1, completed: 1 });
  });

  it("leaves listings of other paths untouched", async () => {
    window.dispatchEvent(
      new CustomEvent("e2e-directory-listing-probe", { detail: { targetPath: "/probe", delays: [500] } }),
    );
    await expect(loadDirectory("/elsewhere")).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(document.documentElement.dataset.e2eDirectoryListingProbe ?? "null"))
      .toMatchObject({ calls: 0, completed: 0 });
  });

  it("disarms on an empty request and when its page session ends", async () => {
    window.dispatchEvent(
      new CustomEvent("e2e-directory-listing-probe", { detail: { targetPath: "/probe", delays: [500] } }),
    );
    window.dispatchEvent(new CustomEvent("e2e-directory-listing-probe"));
    expect(document.documentElement.dataset.e2eDirectoryListingProbe).toBeUndefined();

    window.dispatchEvent(
      new CustomEvent("e2e-directory-listing-probe", { detail: { targetPath: "/probe", delays: [500] } }),
    );
    session.abort();
    expect(document.documentElement.dataset.e2eDirectoryListingProbe).toBeUndefined();
    // Retired: neither the listener nor the interceptor survives the session.
    window.dispatchEvent(
      new CustomEvent("e2e-directory-listing-probe", { detail: { targetPath: "/probe", delays: [500] } }),
    );
    await expect(loadDirectory("/probe")).resolves.toMatchObject({ ok: true });
    expect(document.documentElement.dataset.e2eDirectoryListingProbe).toBeUndefined();
  });

  it("publishes a directory watch only after the backend accepts it", async () => {
    let acceptWatch!: (lease: { id: string; path: string }) => void;
    invokeMock.mockImplementation(
      (command: string) => command === "native_resource_session"
        ? Promise.resolve("session")
        :
        new Promise<{ id: string; path: string }>((resolve) => {
          acceptWatch = resolve;
        }),
    );
    const watching = watchDirectory("/WATCHED/");
    await Promise.resolve();
    await Promise.resolve();

    expect(document.documentElement.dataset.e2eReadyDirectoryWatches).toBeUndefined();
    acceptWatch({ id: "lease", path: "/watched" });
    await watching;

    expect(invokeMock).toHaveBeenCalledWith("native_resource_session", {
      historyChannel: expect.any(Function),
    });
    expect(invokeMock).toHaveBeenCalledWith("watch_directory", { path: "/WATCHED/", sessionId: "session" });
    expect(
      JSON.parse(document.documentElement.dataset.e2eReadyDirectoryWatches ?? "[]"),
    ).toContain("/watched");
    expect(
      JSON.parse(document.documentElement.dataset.e2eReadyDirectoryWatches ?? "[]"),
    ).not.toContain("/WATCHED/");
  });
});
