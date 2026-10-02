/**
 * #781: preserve renderer identities when abandoned warm-claim expiry loses the session.
 *
 * Retire-when: #781 closed
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeProcessEvidence, ProcessObservation } from "../../e2e-tauri/diagnostics/process-timeline";
import { monitorWarmClaimExpiry as monitor, type WarmClaimStage } from "../../e2e-tauri/diagnostics/warm-claim";

const collect = vi.fn();
const driver = { getWindowHandles: vi.fn() };
const output = fs.mkdtempSync(path.join(os.tmpdir(), "warm-claim-timeline-"));

function monitorWarmClaimExpiry<T>(
  claim: Parameters<typeof monitor>[0],
  action: (mark: (stage: WarmClaimStage) => void) => Promise<T>,
): Promise<T> {
  return monitor(claim, action, { collect, directory: output });
}

function renderer(pid: number): ProcessObservation {
  return {
    pid,
    executable: "/usr/libexec/webkit2gtk-4.1/WebKitWebProcess",
    startTime: String(pid * 10),
    parentPid: 10,
  };
}

function sample(webkit: ProcessObservation[]): NativeProcessEvidence {
  return { sampledAt: Date.now(), application: [], webkit, driver: [] };
}

describe("warm claim session-loss diagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.resetAllMocks();
    for (const file of fs.readdirSync(output)) fs.rmSync(path.join(output, file));
  });

  afterEach(() => vi.useRealTimers());

  afterAll(() => {
    fs.rmSync(output, { recursive: true, force: true });
  });

  it("writes the claimed label and exact vanished renderer after a handle poll loses the session", async () => {
    const surviving = renderer(20);
    const vanished = renderer(21);
    collect.mockImplementation(() => sample(
      Date.now() < 1_500 ? [surviving, vanished] : [surviving],
    ));
    const lostSession = new Error("session deleted because of page crash or hang");
    driver.getWindowHandles.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      throw lostSession;
    });

    const observed = monitorWarmClaimExpiry({
      sourceHandle: "source",
      survivorHandle: "survivor",
      parkedHandle: "parked",
      parkedLabel: "explorer-claimed",
    }, (mark) => {
      mark("source-close-requested");
      return driver.getWindowHandles();
    });
    const rejected = expect(observed).rejects.toBe(lostSession);
    await vi.advanceTimersByTimeAsync(600);
    await rejected;

    const files = fs.readdirSync(output);
    expect(files).toHaveLength(1);
    const record = JSON.parse(fs.readFileSync(path.join(output, files[0]), "utf8"));
    expect(record).toMatchObject({
      issue: 781,
      phase: "claim-expiry-failed",
      parkedLabel: "explorer-claimed",
      sourceHandle: "source",
      survivorHandle: "survivor",
      parkedHandle: "parked",
      failure: "Error: session deleted because of page crash or hang",
      milestones: [
        { stage: "monitor-started", at: 1_000 },
        { stage: "source-close-requested", at: 1_000 },
      ],
      rendererDisappearances: [
        { renderer: surviving, firstMissingAt: null },
        { renderer: vanished, firstMissingAt: 1_500 },
      ],
      observedRendererLifetimes: [
        { renderer: surviving, firstSeenAt: 1_000, firstMissingAt: null },
        { renderer: vanished, firstSeenAt: 1_000, firstMissingAt: 1_500 },
      ],
      untrackedRendererObservations: 0,
    });
    expect(record.nativeDuringExpiry.map((entry: NativeProcessEvidence) => entry.sampledAt))
      .toEqual([1_000, 1_500, 1_600]);
    expect(driver.getWindowHandles).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the initial and final process states when one command exceeds both waits", async () => {
    const vanished = renderer(21);
    collect.mockImplementation(() => sample(Date.now() < 2_000 ? [vanished] : []));
    const pending = monitorWarmClaimExpiry({
      sourceHandle: "source",
      survivorHandle: "survivor",
      parkedHandle: "parked",
      parkedLabel: "explorer-claimed",
    }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 52_000));
      throw new Error("driver timed out");
    });
    const rejected = expect(pending).rejects.toThrow("driver timed out");
    await vi.advanceTimersByTimeAsync(52_000);
    await rejected;

    const files = fs.readdirSync(output);
    expect(files).toHaveLength(1);
    const record = JSON.parse(fs.readFileSync(path.join(output, files[0]), "utf8"));
    expect(record.nativeDuringExpiry[0].sampledAt).toBe(1_000);
    expect(record.nativeDuringExpiry.some((entry: NativeProcessEvidence) =>
      entry.sampledAt === 52_000)).toBe(true);
    expect(record.nativeDuringExpiry.at(-1).sampledAt).toBe(53_000);
    expect(record.nativeDuringExpiry.length).toBeLessThanOrEqual(102);
    expect(record.rendererDisappearances).toEqual([
      { renderer: vanished, firstMissingAt: 2_000 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not write a failure artifact when claim expiry completes", async () => {
    collect.mockImplementation(() => sample([]));
    await expect(monitorWarmClaimExpiry({
      sourceHandle: "source",
      survivorHandle: "survivor",
      parkedHandle: "parked",
      parkedLabel: "explorer-claimed",
    }, async () => "closed")).resolves.toBe("closed");
    expect(fs.readdirSync(output)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
