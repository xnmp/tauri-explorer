/**
 * Real-backend regressions for watcher refresh timing. The probe delays real
 * listing IPC responses; filesystem writes still travel through notify and
 * Tauri's directory-changed event before reaching useFileWatchers.
 */
import { browser } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo } from "./helpers";

const coalescingDir = fs.mkdtempSync(
  path.join(os.homedir(), ".tauri-explorer-e2e-watch-coalesce-"),
);
const adaptiveDir = fs.mkdtempSync(
  path.join(os.homedir(), ".tauri-explorer-e2e-watch-adaptive-"),
);

async function listingProbe(): Promise<{ calls: number; completed: number; starts: number[] }> {
  return await browser.execute(() => {
    const snapshot = document.documentElement.dataset.e2eDirectoryListingProbe;
    return snapshot
      ? JSON.parse(snapshot)
      : { calls: -1, completed: -1, starts: [] };
  });
}

async function installListingProbe(targetPath: string, delays: number[]): Promise<void> {
  await browser.execute(
    (pathToProbe: string, responseDelays: number[]) => {
      window.dispatchEvent(
        new CustomEvent("e2e-directory-listing-probe", {
          detail: { targetPath: pathToProbe, delays: responseDelays },
        }),
      );
    },
    targetPath,
    delays,
  );
}

async function waitForCalls(expected: number, message: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => (await listingProbe()).calls >= expected, {
    timeout,
    timeoutMsg: message,
  });
}

async function waitForCompletions(expected: number, message: string): Promise<void> {
  await browser.waitUntil(async () => (await listingProbe()).completed >= expected, {
    timeout: 10_000,
    timeoutMsg: message,
  });
}

describe("filesystem watcher refresh coalescing", () => {
  before(() => {
    fs.writeFileSync(path.join(coalescingDir, "existing.txt"), "ready\n");
    fs.writeFileSync(path.join(adaptiveDir, "existing.txt"), "ready\n");
  });

  afterEach(async () => {
    await browser.execute(() => {
      window.dispatchEvent(new CustomEvent("e2e-directory-listing-probe"));
    });
  });

  after(() => {
    fs.rmSync(coalescingDir, { recursive: true, force: true });
    fs.rmSync(adaptiveDir, { recursive: true, force: true });
  });

  it("runs one trailing listing after repeated events during a slow listing", async () => {
    await navigateTo(coalescingDir);
    await installListingProbe(coalescingDir, [5000]);

    fs.writeFileSync(path.join(coalescingDir, "event-1.txt"), "one\n");
    await waitForCalls(1, "the first watcher-triggered listing never started");

    // Each write is farther apart than the backend's 300ms watcher debounce,
    // so these are distinct real Tauri events, all inside the held listing.
    for (let event = 2; event <= 4; event += 1) {
      fs.writeFileSync(path.join(coalescingDir, `event-${event}.txt`), `${event}\n`);
      await browser.pause(800);
    }
    expect((await listingProbe()).calls).toBe(1);

    await waitForCalls(2, "the trailing watcher listing never started");
    await browser.pause(2500);
    expect((await listingProbe()).calls).toBe(2);
  });

  it("backs off after a slow real watcher listing and restores normal cadence", async () => {
    await navigateTo(adaptiveDir);
    // Controlled response times make the first listing a healthy baseline,
    // the second degraded, and the third healthy again. All four invocations
    // still execute the real Tauri directory-listing command.
    await installListingProbe(adaptiveDir, [250, 1500, 250, 250]);

    fs.writeFileSync(path.join(adaptiveDir, "baseline.txt"), "baseline\n");
    await waitForCalls(1, "the healthy baseline listing never started");
    await waitForCompletions(1, "the healthy baseline listing never completed");

    fs.writeFileSync(path.join(adaptiveDir, "slow.txt"), "slow\n");
    await waitForCalls(2, "the deliberately slow watcher listing never started");
    await waitForCompletions(2, "the deliberately slow watcher listing never completed");

    // A new real watcher event would normally list after two seconds. The
    // degraded observation must hold it beyond that normal cadence.
    fs.writeFileSync(path.join(adaptiveDir, "backed-off.txt"), "backoff\n");
    await browser.pause(3000);
    expect((await listingProbe()).calls).toBe(2);

    await waitForCalls(3, "the backed-off watcher listing never started");
    await waitForCompletions(3, "the healthy recovery listing never completed");
    const backedOff = await listingProbe();
    expect(backedOff.calls).toBe(3);
    expect(backedOff.starts[2] - backedOff.starts[1]).toBeGreaterThanOrEqual(6000);

    // The healthy third listing restores the normal two-second interval.
    fs.writeFileSync(path.join(adaptiveDir, "recovered.txt"), "recovered\n");
    await waitForCalls(4, "watcher cadence did not recover after a healthy listing", 6000);
    await waitForCompletions(4, "the recovered-cadence listing never completed");
    const recovered = await listingProbe();
    expect(recovered.calls).toBe(4);
    const recoveredGap = recovered.starts[3] - recovered.starts[2];
    expect(recoveredGap).toBeGreaterThanOrEqual(1800);
    expect(recoveredGap).toBeLessThan(4500);
  });
});
