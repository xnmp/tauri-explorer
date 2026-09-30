import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isWarmWindowUrl,
  mayHostLabel,
  selectWindowByLabel,
  waitForListingEntry,
  waitForWindowOperation,
  type ListingWaitRequest,
  type RendererWaitResult,
  type WindowOperationResponse,
  type WindowOperationWaitRequest,
} from "../../e2e-tauri/window-transfer-waits";

type ObserverCallback = (records: MutationRecord[], observer: MutationObserver) => void;

function installMutationObserver() {
  const observers = new Set<FakeMutationObserver>();
  class FakeMutationObserver {
    constructor(private readonly callback: ObserverCallback) {
      observers.add(this);
    }

    observe(): void {}

    disconnect(): void {
      observers.delete(this);
    }

    takeRecords(): MutationRecord[] {
      return [];
    }

    notify(): void {
      this.callback([], this as unknown as MutationObserver);
    }
  }
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  return () => {
    for (const observer of [...observers]) observer.notify();
  };
}

class FakeCustomEvent {
  constructor(
    readonly type: string,
    readonly init: { detail: unknown },
  ) {}

  get detail(): unknown {
    return this.init.detail;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native window-label scan", () => {
  it("accepts a ready target reached after a slow complete handle scan", async () => {
    let elapsed = 0;
    let selected = "";
    const visited: string[] = [];
    await selectWindowByLabel({
      listHandles: async () => ["main", "parked-warm", "target"],
      switchTo: async (handle) => { selected = handle; visited.push(handle); },
      currentUrl: async () => "tauri://localhost/",
      currentLabel: async () => {
        elapsed += 11_000;
        return selected === "target" ? "requested-child" : undefined;
      },
      pause: async () => { throw new Error("a complete scan already found the target"); },
      now: () => elapsed,
    }, "requested-child", 20_000);

    expect(visited).toEqual(["main", "parked-warm", "target"]);
    expect(elapsed).toBe(33_000);
  });

  it("reports a missing target only after checking every current handle", async () => {
    let elapsed = 0;
    const visited: string[] = [];
    await expect(selectWindowByLabel({
      listHandles: async () => ["main", "parked-warm"],
      switchTo: async (handle) => { visited.push(handle); },
      currentUrl: async () => "tauri://localhost/",
      currentLabel: async () => { elapsed += 11_000; return undefined; },
      pause: async () => { throw new Error("expired scan must not repeat"); },
      now: () => elapsed,
    }, "requested-child", 20_000)).rejects.toThrow(
      "window requested-child did not become ready",
    );
    expect(visited).toEqual(["main", "parked-warm"]);
  });

  it("rescans when the child handle appears after the first pass", async () => {
    let elapsed = 0;
    let selected = "";
    let scans = 0;
    await selectWindowByLabel({
      listHandles: async () => (++scans === 1 ? ["main"] : ["main", "child"]),
      switchTo: async (handle) => { selected = handle; },
      currentUrl: async () => "tauri://localhost/",
      currentLabel: async () => selected === "child" ? "requested-child" : undefined,
      pause: async (ms) => { elapsed += ms; },
      now: () => elapsed,
    }, "requested-child", 20_000);
    expect(scans).toBe(2);
    expect(selected).toBe("child");
  });

  it("skips a handle that closed during the scan and selects the remaining child", async () => {
    let selected = "";
    let handles = ["closing", "child"];
    await selectWindowByLabel({
      listHandles: async () => handles,
      switchTo: async (handle) => {
        if (handle === "closing") {
          handles = ["child"];
          throw new Error("no such window");
        }
        selected = handle;
      },
      currentUrl: async () => "tauri://localhost/",
      currentLabel: async () => selected === "child" ? "requested-child" : undefined,
      pause: async () => { throw new Error("child was in the first scan"); },
      now: () => 0,
    }, "requested-child", 20_000);
    expect(selected).toBe("child");
  });

  it("keeps driver errors visible when the failing handle still exists", async () => {
    const driverError = new Error("driver session lost");
    await expect(selectWindowByLabel({
      listHandles: async () => ["main", "child"],
      switchTo: async () => { throw driverError; },
      currentUrl: async () => "tauri://localhost/",
      currentLabel: async () => undefined,
      pause: async () => {},
      now: () => 0,
    }, "requested-child", 20_000)).rejects.toBe(driverError);
  });
});

describe("owned-page scan (#885, #931)", () => {
  const urls: Record<string, string> = {
    main: "tauri://localhost/",
    warm: "tauri://localhost/?warm=1&path=%2Fhome%2Frunner&home=%2Fhome%2Frunner",
    child: "tauri://localhost/?path=%2Fhome%2Frunner%2Fsource",
  };

  it("never scripts a warm page while looking for an ordinary window", async () => {
    let selected = "";
    const scripted: string[] = [];
    await selectWindowByLabel({
      listHandles: async () => ["main", "warm", "child"],
      switchTo: async (handle) => { selected = handle; },
      currentUrl: async () => urls[selected],
      currentLabel: async () => {
        scripted.push(selected);
        if (selected === "warm") throw new Error("session deleted because of page crash or hang");
        return selected === "child" ? "explorer-child" : "main";
      },
      pause: async () => { throw new Error("child was in the first scan"); },
      now: () => 0,
    }, "explorer-child", 20_000);
    expect(scripted).toEqual(["main", "child"]);
    expect(selected).toBe("child");
  });

  it("still finds a requested warm window, which the test then owns", async () => {
    let selected = "";
    await selectWindowByLabel({
      listHandles: async () => ["main", "warm"],
      switchTo: async (handle) => { selected = handle; },
      currentUrl: async () => urls[selected],
      currentLabel: async () => selected === "warm" ? "explorer-warm-1" : "main",
      pause: async () => { throw new Error("warm was in the first scan"); },
      now: () => 0,
    }, "explorer-warm-1", 20_000);
    expect(selected).toBe("warm");
  });

  it("classifies warm pages by their launch parameter only", () => {
    expect(isWarmWindowUrl(urls.warm)).toBe(true);
    expect(isWarmWindowUrl(urls.child)).toBe(false);
    expect(isWarmWindowUrl("tauri://localhost/?path=%2Fwarm%3D1")).toBe(false);
    expect(isWarmWindowUrl("not a url")).toBe(false);
    expect(isWarmWindowUrl("")).toBe(false);
    expect(mayHostLabel(urls.warm, "explorer-child")).toBe(false);
    expect(mayHostLabel(urls.warm, "explorer-warm-1")).toBe(true);
    expect(mayHostLabel(urls.child, "explorer-child")).toBe(true);
  });
});

describe("native transfer renderer waits", () => {
  it("ignores a stale operation result and resolves the matching result with one driver call", async () => {
    vi.useFakeTimers();
    const notifyMutation = installMutationObserver();
    const root = {
      dataset: {
        e2eWindowResult: JSON.stringify({ token: "previous", result: { moved: true } }),
      },
    };
    const dispatchEvent = vi.fn((event: FakeCustomEvent) => {
      const request = event.detail as WindowOperationWaitRequest;
      setTimeout(() => {
        root.dataset.e2eWindowResult = JSON.stringify({
          token: request.token,
          result: { moved: true, target: "explorer-child" },
        });
        notifyMutation();
      }, 50);
      return true;
    });
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", FakeCustomEvent);
    const executeAsync = async (
      script: typeof waitForWindowOperation,
      request: WindowOperationWaitRequest,
    ): Promise<RendererWaitResult<WindowOperationResponse>> => {
      return await new Promise((resolve, reject) => script(request, (result) => {
        if (result === undefined) reject(new Error("renderer wait returned no result"));
        else resolve(result);
      }));
    };

    const waiting = executeAsync(waitForWindowOperation, {
      token: "current",
      op: "tear-off",
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(50);

    await expect(waiting).resolves.toEqual({
      ok: true,
      value: {
        token: "current",
        result: { moved: true, target: "explorer-child" },
      },
    });
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });

  it("resolves a delayed listing mutation with one driver call", async () => {
    vi.useFakeTimers();
    const notifyMutation = installMutationObserver();
    const entries: Array<{ textContent: string }> = [{ textContent: "source.txt" }];
    vi.stubGlobal("document", {
      documentElement: {},
      querySelectorAll: vi.fn(() => entries),
    });
    const executeAsync = async (
      script: typeof waitForListingEntry,
      request: ListingWaitRequest,
    ): Promise<RendererWaitResult<true>> => {
      return await new Promise((resolve, reject) => script(request, (result) => {
        if (result === undefined) reject(new Error("renderer wait returned no result"));
        else resolve(result);
      }));
    };

    const waiting = executeAsync(waitForListingEntry, {
      name: "after-transfer.txt",
      timeoutMs: 1_000,
    });
    setTimeout(() => {
      entries.push({ textContent: "after-transfer.txt" });
      notifyMutation();
    }, 50);
    await vi.advanceTimersByTimeAsync(50);

    await expect(waiting).resolves.toEqual({ ok: true, value: true });
  });

  it("disconnects a timed-out listing observer and completes only once", async () => {
    vi.useFakeTimers();
    const notifyMutation = installMutationObserver();
    vi.stubGlobal("document", {
      documentElement: {},
      querySelectorAll: vi.fn(() => []),
    });
    const completed = vi.fn();

    waitForListingEntry({ name: "absent.txt", timeoutMs: 100 }, completed);
    await vi.advanceTimersByTimeAsync(100);
    expect(completed).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      reason: "native listing did not contain absent.txt",
    });
    // WebDriver treats these top-level keys as protocol failures even on HTTP 200.
    expect(Object.keys(completed.mock.calls[0][0])).not.toContain("error");
    expect(Object.keys(completed.mock.calls[0][0])).not.toContain("stackTrace");
    expect(Object.keys(completed.mock.calls[0][0])).not.toContain("stacktrace");

    notifyMutation();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(completed).toHaveBeenCalledOnce();
  });

  it("waits for the requested number of substring matches", async () => {
    vi.useFakeTimers();
    const notifyMutation = installMutationObserver();
    const entries: Array<{ textContent: string }> = [{ textContent: "original.txt" }];
    vi.stubGlobal("document", {
      documentElement: {},
      querySelectorAll: vi.fn(() => entries),
    });

    const waiting = new Promise<RendererWaitResult<true>>((resolve, reject) =>
      waitForListingEntry({
        name: "original", match: "contains", minCount: 2, timeoutMs: 1_000,
      }, (result) => result === undefined
        ? reject(new Error("renderer wait returned no result"))
        : resolve(result)));
    await vi.advanceTimersByTimeAsync(50);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    entries.push({ textContent: "original copy.txt" });
    notifyMutation();
    await expect(waiting).resolves.toEqual({ ok: true, value: true });
  });
});
