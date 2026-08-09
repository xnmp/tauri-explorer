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

interface WatcherReceipt {
  count: number;
  observedAt: number | null;
}

async function watcherReceipt(targetPath: string): Promise<WatcherReceipt> {
  return await browser.execute((pathToRead: string) => {
    const encoded = document.documentElement.dataset.e2eDirectoryWatcherReceipts;
    const receipts = encoded ? JSON.parse(encoded) : {};
    return receipts[pathToRead] ?? { count: 0, observedAt: null };
  }, targetPath);
}

async function waitForWatcherReady(targetPath: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      await browser.execute((pathToFind: string) => {
        const listenerReady =
          document.documentElement.dataset.e2eDirectoryWatcherListenerReady === "true";
        const encoded = document.documentElement.dataset.e2eReadyDirectoryWatches;
        const readyPaths: string[] = encoded ? JSON.parse(encoded) : [];
        return listenerReady && readyPaths.includes(pathToFind);
      }, targetPath),
    {
      timeout: 10_000,
      timeoutMsg: `the application watcher never became ready for ${targetPath}`,
    },
  );
}

async function waitForWatcherQuiet(targetPath: string): Promise<WatcherReceipt> {
  const before = await watcherReceipt(targetPath);
  // The backend emits only after 300 ms of quiet and polls every 100 ms. A
  // stable application receipt count across 700 ms proves the measured probe
  // does not start with an earlier notification still in the pipeline.
  await browser.pause(700);
  const after = await watcherReceipt(targetPath);
  expect(after.count).toBe(before.count);
  return after;
}

async function writeAndWaitForReceipt(
  targetPath: string,
  filename: string,
  contents: string,
  previousCount: number,
): Promise<WatcherReceipt> {
  fs.writeFileSync(path.join(targetPath, filename), contents);
  await browser.waitUntil(async () => (await watcherReceipt(targetPath)).count > previousCount, {
    timeout: 10_000,
    timeoutMsg: `the application never received the watcher event for ${filename}`,
  });
  return await watcherReceipt(targetPath);
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
    await waitForWatcherReady(coalescingDir);
    let receipt = await waitForWatcherQuiet(coalescingDir);
    await installListingProbe(coalescingDir, [5000]);

    receipt = await writeAndWaitForReceipt(
      coalescingDir,
      "event-1.txt",
      "one\n",
      receipt.count,
    );
    await waitForCalls(1, "the first watcher-triggered listing never started");

    // Advance only after the application acknowledges each distinct real
    // Tauri event, keeping all three inside the held listing.
    for (let event = 2; event <= 4; event += 1) {
      receipt = await writeAndWaitForReceipt(
        coalescingDir,
        `event-${event}.txt`,
        `${event}\n`,
        receipt.count,
      );
    }

    await waitForCalls(2, "the trailing watcher listing never started");
    const trailing = await listingProbe();
    expect(trailing.calls).toBe(2);
    // WebKitWebDriver can serialize an executeScript observation behind the
    // outstanding Tauri listing promise, so assert the recorded app-world
    // start times rather than assuming the driver can inspect it mid-flight.
    expect(trailing.starts[1] - trailing.starts[0]).toBeGreaterThanOrEqual(4800);
    await browser.pause(2500);
    expect((await listingProbe()).calls).toBe(2);
  });

  it("backs off after a slow real watcher listing and restores normal cadence", async () => {
    await navigateTo(adaptiveDir);
    await waitForWatcherReady(adaptiveDir);
    let receipt = await waitForWatcherQuiet(adaptiveDir);
    // Controlled response times make the first listing a healthy baseline,
    // the second degraded, and the third healthy again. All four invocations
    // still execute the real Tauri directory-listing command.
    await installListingProbe(adaptiveDir, [250, 1500, 250, 250]);

    receipt = await writeAndWaitForReceipt(
      adaptiveDir,
      "baseline.txt",
      "baseline\n",
      receipt.count,
    );
    await waitForCalls(1, "the healthy baseline listing never started");
    await waitForCompletions(1, "the healthy baseline listing never completed");

    receipt = await writeAndWaitForReceipt(adaptiveDir, "slow.txt", "slow\n", receipt.count);
    await waitForCalls(2, "the deliberately slow watcher listing never started");
    await waitForCompletions(2, "the deliberately slow watcher listing never completed");

    // A new real watcher event would normally list after two seconds. The
    // degraded observation must hold it beyond that normal cadence.
    receipt = await writeAndWaitForReceipt(
      adaptiveDir,
      "backed-off.txt",
      "backoff\n",
      receipt.count,
    );
    await browser.pause(3000);
    expect((await listingProbe()).calls).toBe(2);

    await waitForCalls(3, "the backed-off watcher listing never started");
    await waitForCompletions(3, "the healthy recovery listing never completed");
    const backedOff = await listingProbe();
    expect(backedOff.calls).toBe(3);
    expect(backedOff.starts[2] - backedOff.starts[1]).toBeGreaterThanOrEqual(6000);

    // The healthy third listing restores the normal two-second interval.
    await writeAndWaitForReceipt(
      adaptiveDir,
      "recovered.txt",
      "recovered\n",
      receipt.count,
    );
    await waitForCalls(4, "watcher cadence did not recover after a healthy listing", 6000);
    await waitForCompletions(4, "the recovered-cadence listing never completed");
    const recovered = await listingProbe();
    expect(recovered.calls).toBe(4);
    const recoveredGap = recovered.starts[3] - recovered.starts[2];
    expect(recoveredGap).toBeGreaterThanOrEqual(1800);
    expect(recoveredGap).toBeLessThan(4500);
  });
});
