import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWindowSessionProbe } from "../src/test-support/window-session-probe";
const navigate = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("$lib/state/window-tabs.svelte", () => ({ windowTabsManager: {
  windowLabel: "test-window", getActiveExplorer: () => ({ navigateTo: navigate }),
} }));
vi.mock("$lib/state/warm-window", () => ({ spawnWarmWindow: async () => {} }));
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
  dataset = {};
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { documentElement: { dataset } });
});
afterEach(() => vi.unstubAllGlobals());

describe("page-owned native test hooks", () => {
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
