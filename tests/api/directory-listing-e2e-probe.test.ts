import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("$lib/api/common", () => ({
  invoke: invokeMock,
  extractError: (error: unknown) => String(error),
  virtualPathGuard: () => null,
  dataUriToBlobUrl: () => "blob:test",
}));
vi.mock("$lib/plugins/fs-providers", () => ({ providerFor: () => undefined }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));

vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", { documentElement: { dataset: {} } });

const { startStreamingDirectory, watchDirectory } = await import("$lib/api/files");

describe("directory listing Tauri E2E probe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ path: "/probe", entries: [], listing_id: null });
    for (const key of Object.keys(document.documentElement.dataset)) {
      delete document.documentElement.dataset[key];
    }
  });

  afterEach(() => {
    window.dispatchEvent(new CustomEvent("e2e-directory-listing-probe"));
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("configures and reports a delayed real listing through DOM state", async () => {
    window.dispatchEvent(
      new CustomEvent("e2e-directory-listing-probe", {
        detail: { targetPath: "/probe", delays: [500] },
      }),
    );

    const completed = vi.fn();
    const listing = startStreamingDirectory("/probe").then((result) => {
      completed();
      return result;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(completed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(listing).resolves.toMatchObject({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("start_streaming_directory", { path: "/probe" });
    expect(JSON.parse(document.documentElement.dataset.e2eDirectoryListingProbe ?? "null"))
      .toMatchObject({ calls: 1, completed: 1 });
  });

  it("publishes a directory watch only after the backend accepts it", async () => {
    let acceptWatch!: () => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acceptWatch = resolve;
        }),
    );
    const watching = watchDirectory("/watched");
    await Promise.resolve();

    expect(document.documentElement.dataset.e2eReadyDirectoryWatches).toBeUndefined();
    acceptWatch();
    await watching;

    expect(invokeMock).toHaveBeenCalledWith("watch_directory", { path: "/watched" });
    expect(
      JSON.parse(document.documentElement.dataset.e2eReadyDirectoryWatches ?? "[]"),
    ).toContain("/watched");
  });
});
