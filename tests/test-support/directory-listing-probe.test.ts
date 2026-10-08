import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("$lib/api/common", () => ({
  invoke: invokeMock,
  extractError: (error: unknown) => String(error),
  virtualPathGuard: () => null,
  dataUriToBlobUrl: () => "blob:test",
  isTauri: () => false,
}));
vi.mock("$lib/state/window-tabs.svelte", () => ({ windowTabsManager: { windowLabel: "probe-window" } }));
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
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    });
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

  const gateKey = "e2e-launch-listing-gate:probe-window";
  const releaseKey = "e2e-launch-listing-release:probe-window";
  const receiptKey = "e2e-launch-listing-receipt:probe-window";
  const receipt = () => JSON.parse(localStorage.getItem(receiptKey) ?? "null");
  function arm(token = "unique-request") {
    localStorage.setItem(gateKey, JSON.stringify({ token, targetPath: "/probe" }));
    const event = Object.assign(new Event("storage"), { key: gateKey });
    window.dispatchEvent(event);
  }

  it("reconciles a release stored before a fresh page boots", async () => {
    session.abort();
    localStorage.setItem(gateKey, JSON.stringify({ token: "early", targetPath: "/probe" }));
    localStorage.setItem(releaseKey, "early");
    session = new AbortController();
    startDirectoryListingProbe(session.signal);
    const settled = vi.fn();
    const listing = loadDirectory("/probe").then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(receipt()).toMatchObject({ token: "early", status: "released" });
    await listing;
  });

  it("records terminal cancellation when a held page session ends", async () => {
    arm();
    const settled = vi.fn();
    const listing = loadDirectory("/probe").then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    expect(receipt()).toMatchObject({ status: "held" });
    session.abort();
    await listing;
    expect(receipt()).toMatchObject({ status: "cancelled" });
    expect(document.documentElement.dataset.e2eLaunchListingGate).toBeUndefined();
  });

  it("holds only the captured path, rejects wrong tokens, and releases old work on rearm", async () => {
    arm("first");
    await expect(loadDirectory("/elsewhere")).resolves.toMatchObject({ ok: true });
    const settled = vi.fn();
    const listing = loadDirectory("/probe").then(settled);
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new CustomEvent("e2e-launch-listing-release", { detail: { token: "wrong" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    arm("replacement");
    await listing;
    expect(receipt()).toMatchObject({ token: "replacement", status: "armed" });
    const next = loadDirectory("/probe");
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new CustomEvent("e2e-launch-listing-release", { detail: { token: "replacement" } }));
    await expect(next).resolves.toMatchObject({ ok: true });
    expect(receipt()).toMatchObject({ token: "replacement", status: "released" });
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
