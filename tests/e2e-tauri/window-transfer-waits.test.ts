import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
    let driverCalls = 0;
    const executeAsync = async (
      script: typeof waitForWindowOperation,
      request: WindowOperationWaitRequest,
    ): Promise<RendererWaitResult<WindowOperationResponse>> => {
      driverCalls += 1;
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
    expect(driverCalls).toBe(1);
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
    let driverCalls = 0;
    const executeAsync = async (
      script: typeof waitForListingEntry,
      request: ListingWaitRequest,
    ): Promise<RendererWaitResult<true>> => {
      driverCalls += 1;
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
    expect(driverCalls).toBe(1);
  });
});
