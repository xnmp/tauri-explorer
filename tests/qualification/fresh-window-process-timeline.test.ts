/** #703: a blocked fresh-window lookup must retain process timing evidence. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FreshWindowDiagnostics,
  FreshWindowSelectedDiagnostics,
  FreshWindowSelectionFailure,
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
  outputDirectory: "",
  writtenPaths: [] as string[],
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
      const written = actual.writeFreshWindowDiagnostics(record, diagnostic.outputDirectory);
      if (written) diagnostic.writtenPaths.push(written);
      return written;
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
    diagnostic.writtenPaths.length = 0;
    diagnostic.outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-window-selection-"));
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

  afterEach(() => {
    fs.rmSync(diagnostic.outputDirectory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("reports when the selected renderer first disappears during the blocked command", async () => {
    const mainRenderer = process(20, "WebKitWebProcess", "200");
    const selectedRenderer = process(21, "WebKitWebProcess", "210");
    diagnostic.collect
      .mockReturnValueOnce(sample(1_000, [mainRenderer, selectedRenderer]))
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
    const failure = diagnostic.records.find((record): record is FreshWindowSelectedDiagnostics =>
      record.phase === "lookup-failed");
    expect(failure?.lookup).toMatchObject({
      selector: ".file-list",
      startedAt: 1_000,
      failedAt: 1_500,
      error: expect.stringContaining("page crash or hang"),
    });
    expect(failure?.nativeDuringLookup?.map((entry) =>
      "sampledAt" in entry ? entry.sampledAt : null)).toEqual([1_000, 1_500, 1_500]);
    expect(failure?.selectedRendererAtSelection).toMatchObject({
      pid: 21,
      startTime: "210",
    });
    expect(failure?.selectedRendererFirstMissingAt).toBe(1_500);
    expect(driver.execute).toHaveBeenCalledTimes(webDriverCallsBeforeLookup);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the failing label's process timeline when selection never succeeds", async () => {
    const renderer = process(21, "WebKitWebProcess", "210");
    diagnostic.collect.mockImplementation(() => sample(Date.now(), [renderer]));
    driver.waitUntil.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      throw new Error("fresh native window explorer-child did not become ready");
    });

    const selection = switchToFreshWindow("explorer-child", ["main"]);
    const rejected = expect(selection).rejects.toThrow("did not become ready");
    await vi.advanceTimersByTimeAsync(1_100);
    await rejected;

    const failure = diagnostic.records.find((record): record is FreshWindowSelectionFailure =>
      record.phase === "selection-failed");
    expect(failure?.requestedLabel).toBe("explorer-child");
    expect(failure?.nativeDuringSelection.map((entry) =>
      "sampledAt" in entry ? entry.sampledAt : null)).toEqual([1_000, 1_500, 2_000, 2_100]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records a handle-command failure without issuing another WebDriver command", async () => {
    diagnostic.collect.mockImplementation(() => sample(Date.now(), []));
    const lostSession = new Error("invalid WebDriver session");
    driver.getWindowHandles.mockRejectedValue(lostSession);

    await expect(switchToFreshWindow("explorer-child", ["main"])).rejects.toBe(lostSession);

    const failure = diagnostic.records.find((record): record is FreshWindowSelectionFailure =>
      record.phase === "selection-failed");
    expect(failure).toMatchObject({
      requestedLabel: "explorer-child",
      selectionError: "Error: invalid WebDriver session",
      existingHandles: ["main"],
    });
    expect(failure?.nativeDuringSelection).toHaveLength(2);
    expect(driver.getWindowHandles).toHaveBeenCalledTimes(1);
    expect(driver.switchToWindow).not.toHaveBeenCalled();
    expect(driver.execute).not.toHaveBeenCalled();
    expect(diagnostic.writtenPaths).toHaveLength(1);
    const persisted = JSON.parse(fs.readFileSync(
      diagnostic.writtenPaths[0], "utf8",
    )) as FreshWindowSelectionFailure;
    expect(persisted.phase).toBe("selection-failed");
    expect(persisted.selectionError).toContain("invalid WebDriver session");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures the final process state when WebDriver rejects after the nominal selection timeout", async () => {
    const initialRenderer = process(21, "WebKitWebProcess", "210");
    const newRenderer = process(22, "WebKitWebProcess", "220");
    diagnostic.collect.mockImplementation(() => sample(
      Date.now(),
      Date.now() < 1_500 ? [initialRenderer]
        : Date.now() < 2_000 ? [initialRenderer, newRenderer] : [],
    ));
    driver.waitUntil.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 22_000));
      throw new Error("fresh native window explorer-child did not become ready");
    });

    const selection = switchToFreshWindow("explorer-child", ["main"]);
    const rejected = expect(selection).rejects.toThrow("did not become ready");
    await vi.advanceTimersByTimeAsync(22_000);
    await rejected;

    const failure = diagnostic.records.find((record): record is FreshWindowSelectionFailure =>
      record.phase === "selection-failed");
    const final = failure?.nativeDuringSelection.at(-1);
    expect(final && "sampledAt" in final ? final.sampledAt : null).toBe(23_000);
    expect(failure?.nativeDuringSelection.some((entry) =>
      "sampledAt" in entry && entry.sampledAt === 22_000)).toBe(true);
    expect(failure?.nativeDuringSelection.length).toBeLessThanOrEqual(43);
    expect(failure?.baselineRendererDisappearances).toEqual([
      { renderer: initialRenderer, firstMissingAt: 2_000 },
    ]);
    expect(failure?.observedRendererLifetimes).toEqual([
      { renderer: initialRenderer, firstSeenAt: 1_000, firstMissingAt: 2_000 },
      { renderer: newRenderer, firstSeenAt: 1_500, firstMissingAt: 2_000 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the selected renderer's first disappearance after the lookup sample window rolls", async () => {
    const selectedRenderer = process(21, "WebKitWebProcess", "210");
    diagnostic.collect.mockImplementation(() => sample(
      Date.now(), Date.now() < 2_000 ? [selectedRenderer] : [],
    ));
    await switchToFreshWindow("explorer-child", ["main"]);
    const sessionLoss = new Error("invalid WebDriver session");
    element.waitForExist.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 22_000));
      throw sessionLoss;
    });

    const lookup = waitForFreshWindowElement(".file-list", 20_000);
    const rejected = expect(lookup).rejects.toBe(sessionLoss);
    await vi.advanceTimersByTimeAsync(22_000);
    await rejected;

    const failure = diagnostic.records.find((record): record is FreshWindowSelectedDiagnostics =>
      record.phase === "lookup-failed");
    expect(failure?.selectedRendererFirstMissingAt).toBe(2_000);
    expect(failure?.nativeDuringLookup?.at(-1)).toMatchObject({ sampledAt: 23_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds tracked identities and reports omitted observations from an oversized process table", async () => {
    const renderers = Array.from({ length: 300 }, (_, index) =>
      process(index + 20, "WebKitWebProcess", String((index + 20) * 10)));
    diagnostic.collect.mockImplementation(() => sample(Date.now(), renderers));
    driver.waitUntil.mockRejectedValue(new Error("fresh window timed out"));

    await expect(switchToFreshWindow("explorer-child", ["main"]))
      .rejects.toThrow("fresh window timed out");

    const failure = diagnostic.records.find((record): record is FreshWindowSelectionFailure =>
      record.phase === "selection-failed");
    expect(failure?.observedRendererLifetimes).toHaveLength(256);
    expect(failure?.untrackedRendererObservations).toBeGreaterThan(0);
    expect(failure?.nativeDuringSelection.at(-1)).toMatchObject({ sampledAt: 1_000 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
