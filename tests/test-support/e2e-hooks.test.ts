import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWindowSessionProbe } from "../../src/test-support/e2e-hooks";
const navigate = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const native = vi.hoisted(() => ({ get: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: native.get }));
vi.mock("$lib/state/window-tabs.svelte", () => ({ windowTabsManager: {
  windowLabel: "test-window", getActiveExplorer: () => ({ navigateTo: navigate }),
  whenNativeCloseObserved: () => Promise.resolve(false),
} }));
vi.mock("$lib/state/warm-window", () => ({ spawnWarmWindow: async () => {} }));
const launch = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("$lib/state/window-launch", () => ({ createWindowLauncher: launch.create }));
const pool = vi.hoisted(() => {
  let release!: () => void;
  const imported = new Promise<void>(resolve => { release = resolve; });
  return { imported, release, claim: vi.fn() };
});
vi.mock("$lib/api/warm-pool", async () => {
  await pool.imported;
  return { warmPoolClaim: pool.claim };
});
let dataset: Record<string, string>;
function request() {
  window.dispatchEvent(new CustomEvent("e2e-navigate", { detail: { path: "/fixture", token: "old" } }));
}
beforeEach(() => {
  vi.clearAllMocks();
  native.get.mockReturnValue({ listen: native.listen });
  native.listen.mockResolvedValue(native.unlisten);
  dataset = {};
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { documentElement: { dataset } });
});
afterEach(() => vi.unstubAllGlobals());

describe("page-owned native test hooks", () => {
  it("observes actual native Drops only after listener readiness, and retires on abort", async () => {
    let receive!: (event: { payload: unknown }) => void;
    native.listen.mockImplementation((_name, listener) => {
      receive = listener;
      return Promise.resolve(native.unlisten);
    });
    const lifetime = new AbortController();
    startWindowSessionProbe(lifetime.signal);
    expect(dataset.e2eNativeDragReady).toBeUndefined();
    await vi.waitFor(() => expect(dataset.e2eNativeDragReady).toBe("true"));
    const payload = { type: "drop", paths: ["/fixture/file"], source: { sessionId: "native-1" } };
    receive({ payload });
    expect(JSON.parse(dataset.e2eNativeDragDrop)).toEqual(payload);
    expect(JSON.parse(dataset.e2eNativeDragDrops)).toEqual([payload]);
    lifetime.abort();
    expect(native.unlisten).toHaveBeenCalledOnce();
    dataset.e2eNativeDragDrop = "replacement";
    receive({ payload });
    expect(dataset.e2eNativeDragDrop).toBe("replacement");
    expect(dataset.e2eNativeDragReady).toBeUndefined();
    expect(dataset.e2eNativeDragDrops).toBeUndefined();
  });

  it("releases listener registration that settles after the page is gone", async () => {
    let registered!: (unlisten: () => void) => void;
    native.listen.mockReturnValue(new Promise(resolve => { registered = resolve; }));
    const lifetime = new AbortController();
    startWindowSessionProbe(lifetime.signal);
    lifetime.abort();
    registered(native.unlisten);
    await vi.waitFor(() => expect(native.unlisten).toHaveBeenCalledOnce());
    expect(dataset).toEqual({});
  });

  it("reports unavailable native metadata without breaking other page hooks", async () => {
    native.get.mockImplementationOnce(() => { throw new Error("Native metadata unavailable"); });
    const lifetime = new AbortController();
    startWindowSessionProbe(lifetime.signal);
    await vi.waitFor(() => expect(dataset.e2eNativeDragReady).toContain("Native metadata unavailable"));
    expect(dataset.e2eHooksReady).toBe("true");
    lifetime.abort();
    expect(dataset).toEqual({});
  });

  it("uses the request token as the fresh native window label before acknowledging launch", async () => {
    launch.create.mockImplementation(({ uuid }: { uuid: () => string }) =>
      async () => ({ kind: "fresh", label: `explorer-${uuid()}` }));
    const lifetime = new AbortController();
    startWindowSessionProbe(lifetime.signal);
    window.dispatchEvent(new CustomEvent("e2e-window-operation", {
      detail: { token: "planned-child", op: "fresh-open", target: "/fixture" },
    }));
    await vi.waitFor(() => expect(dataset.e2eWindowResult).toBeDefined());
    expect(JSON.parse(dataset.e2eWindowResult)).toEqual({
      token: "planned-child",
      result: { kind: "fresh", label: "explorer-planned-child" },
    });
    lifetime.abort();
  });

  it("retires handlers and prevents an old navigation completion overwriting its replacement", async () => {
    let finish!: (value: boolean) => void;
    navigate.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const lifetime = new AbortController();
    startWindowSessionProbe(lifetime.signal);
    expect(dataset.e2eHooksReady).toBe("true");
    request();
    lifetime.abort();
    expect(dataset.e2eHooksReady).toBeUndefined();
    dataset.e2eNavigationComplete = "replacement";
    request();
    finish(true); await Promise.resolve();
    expect(navigate).toHaveBeenCalledOnce();
    expect(dataset.e2eNavigationComplete).toBe("replacement");
  });

  it("does not dispatch a native operation whose lazy import resolves after teardown", async () => {
    const lifetime = new AbortController();
    startWindowSessionProbe(lifetime.signal);
    window.dispatchEvent(new CustomEvent("e2e-window-operation", {
      detail: { token: "late-claim", op: "warm-claim" },
    }));
    lifetime.abort();
    pool.release();
    await vi.dynamicImportSettled();
    expect(pool.claim).not.toHaveBeenCalled();
    expect(dataset).toEqual({});
  });

  it("cannot publish warm readiness or install hooks after retirement", async () => {
    let finish!: (ready: boolean) => void;
    const warmReady = new Promise<boolean>(resolve => { finish = resolve; });
    const lifetime = new AbortController();
    startWindowSessionProbe(lifetime.signal, warmReady);
    lifetime.abort();
    startWindowSessionProbe(lifetime.signal, warmReady);
    finish(true); await Promise.resolve();
    request();
    expect(navigate).not.toHaveBeenCalled();
    expect(dataset).toEqual({});
  });
});
