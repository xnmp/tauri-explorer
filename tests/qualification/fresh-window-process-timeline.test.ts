/** #703: a blocked fresh-window lookup must retain process timing evidence. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FreshWindowDiagnostics,
  NativeProcessEvidence,
  ProcessObservation,
} from "../../e2e-tauri/fresh-window-diagnostics";

const driver = vi.hoisted(() => ({
  getWindowHandles: vi.fn(),
  switchToWindow: vi.fn(),
  execute: vi.fn(),
  waitUntil: vi.fn(),
}));
const element = vi.hoisted(() => ({ waitForExist: vi.fn() }));
const diagnostic = vi.hoisted(() => ({
  collect: vi.fn(),
  records: [] as FreshWindowDiagnostics[],
}));

vi.mock("@wdio/globals", () => ({
  browser: driver,
  $: vi.fn(() => element),
  $$: vi.fn(),
}));

vi.mock("../../e2e-tauri/fresh-window-diagnostics", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../e2e-tauri/fresh-window-diagnostics")
  >();
  return {
    ...actual,
    collectNativeProcessEvidence: diagnostic.collect,
    writeFreshWindowDiagnostics: vi.fn((record: FreshWindowDiagnostics) => {
      diagnostic.records.push(structuredClone(record));
      return "/tmp/fresh-window-diagnostic.json";
    }),
  };
});

const { switchToFreshWindow, waitForFreshWindowElement } = await import(
  "../../e2e-tauri/specs/helpers"
);

function process(pid: number, name: string, startTime: string): ProcessObservation {
  return {
    pid,
    executable: `/usr/libexec/webkit2gtk-4.1/${name}`,
    startTime,
    parentPid: 10,
  };
}

function sample(sampledAt: number, webkit: ProcessObservation[]): NativeProcessEvidence {
  return { sampledAt, application: [], webkit, driver: [] };
}

describe("fresh-window blocked lookup process timeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.resetAllMocks();
    diagnostic.records.length = 0;
    driver.getWindowHandles.mockResolvedValue(["main", "child"]);
    driver.waitUntil.mockImplementation(async (ready: () => Promise<boolean>) => {
      if (!(await ready())) throw new Error("fresh window was not ready");
    });
    let rendererRead = 0;
    driver.execute.mockImplementation(async () => {
      rendererRead += 1;
      if (rendererRead === 1) return "explorer-child";
      return {
        capturedAt: Date.now(),
        label: "explorer-child",
        hooksReady: true,
        fileListCount: 1,
        entryCount: 1,
        statusPath: "/tmp/child",
        url: "tauri://localhost/",
        readyState: "complete",
        visibility: "visible",
      };
    });
  });

  it("reports when the selected renderer first disappears during the blocked command", async () => {
    const mainRenderer = process(20, "WebKitWebProcess", "200");
    const selectedRenderer = process(21, "WebKitWebProcess", "210");
    diagnostic.collect
      .mockReturnValueOnce(sample(1_000, [mainRenderer, selectedRenderer]))
      .mockReturnValueOnce(sample(1_000, [mainRenderer, selectedRenderer]))
      .mockReturnValueOnce(sample(1_500, [mainRenderer]))
      .mockReturnValue(sample(1_500, [mainRenderer]));

    await switchToFreshWindow("explorer-child", ["main"]);
    const webDriverCallsBeforeLookup = driver.execute.mock.calls.length;
    let rejectLookup!: (error: Error) => void;
    element.waitForExist.mockReturnValue(new Promise((_, reject) => {
      rejectLookup = reject;
    }));

    const lookup = waitForFreshWindowElement(".file-list", 20_000);
    await vi.advanceTimersByTimeAsync(500);
    const sessionLoss = new Error("session deleted because of page crash or hang");
    rejectLookup(sessionLoss);

    await expect(lookup).rejects.toBe(sessionLoss);
    const failure = diagnostic.records.find((record) => record.phase === "lookup-failed");
    expect(failure?.lookup).toMatchObject({
      selector: ".file-list",
      startedAt: 1_000,
      failedAt: 1_500,
      error: expect.stringContaining("page crash or hang"),
    });
    expect(failure?.nativeDuringLookup?.map((entry) => entry.sampledAt)).toEqual([
      1_000,
      1_500,
      1_500,
    ]);
    expect(failure?.selectedRendererAtSelection).toMatchObject({
      pid: 21,
      startTime: "210",
    });
    expect(failure?.selectedRendererFirstMissingAt).toBe(1_500);
    expect(driver.execute).toHaveBeenCalledTimes(webDriverCallsBeforeLookup);
    expect(vi.getTimerCount()).toBe(0);
  });
});
