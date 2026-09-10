/**
 * Real-backend regressions for watcher refresh timing. The probe delays real
 * listing IPC responses. Held-listing app writes use native mutation admission
 * and directory-changed receipts; external host writes independently exercise
 * notify-only adaptive cadence.
 */
import { browser } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryNames, navigateTo } from "./helpers";

const coalescingDir = fs.mkdtempSync(
  path.join(os.homedir(), ".tauri-explorer-e2e-watch-coalesce-"),
);
const adaptiveDir = fs.mkdtempSync(
  path.join(os.homedir(), ".tauri-explorer-e2e-watch-adaptive-"),
);

async function listingProbe(): Promise<{ calls: number; completed: number; starts: number[]; finishes: number[] }> {
  return await browser.execute(() => {
    const snapshot = document.documentElement.dataset.e2eDirectoryListingProbe;
    return snapshot
      ? JSON.parse(snapshot)
      : { calls: -1, completed: -1, starts: [], finishes: [] };
  });
}

async function installListingProbe(targetPath: string, delays: number[], writeOperation?: string): Promise<void> {
  await browser.execute(
    (pathToProbe: string, responseDelays: number[], operation?: string) => {
      window.dispatchEvent(
        new CustomEvent("e2e-directory-listing-probe", {
          detail: { targetPath: pathToProbe, delays: responseDelays, writeOperation: operation },
        }),
      );
    },
    targetPath,
    delays,
    writeOperation,
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
  // stable receipt count gives the fixture a quiet starting point. Each later
  // write still requires its own backend observation timestamp.
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
  const notBefore = Date.now();
  fs.writeFileSync(path.join(targetPath, filename), contents);
  await browser.waitUntil(
    async () => {
      const receipt = await watcherReceipt(targetPath);
      return (
        receipt.count > previousCount &&
        receipt.observedAt != null &&
        receipt.observedAt >= notBefore
      );
    },
    {
      timeout: 10_000,
      timeoutMsg: `the application never received the watcher event for ${filename}`,
    },
  );
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

  it("runs one trailing listing after repeated native mutations during a slow listing", async () => {
    await navigateTo(coalescingDir);
    await waitForWatcherReady(coalescingDir);
    await waitForWatcherQuiet(coalescingDir);
    const operation = `coalesce-${Date.now()}`;
    await installListingProbe(coalescingDir, [], operation);
    // The application performs and acknowledges all three later mutations
    // while holding this first real listing. WebDriver need not observe it
    // mid-flight, which WebKit cannot reliably do.
    fs.writeFileSync(path.join(coalescingDir, "trigger.txt"), "trigger\n");
    await browser.waitUntil(async () => await browser.execute((expected: string) => {
      const encoded = document.documentElement.dataset.e2eWatcherWriteOperation;
      if (!encoded) return false;
      const result = JSON.parse(encoded);
      return result.operation === expected && result.status !== "running";
    }, operation), { timeout: 25_000, timeoutMsg: "the in-listing write protocol never settled" });
    const result = await browser.execute(() => JSON.parse(
      document.documentElement.dataset.e2eWatcherWriteOperation!,
    ));
    expect(result.operation).toBe(operation);
    expect(result.status).toBe("completed");
    expect(result.acknowledgements).toHaveLength(3);
    expect(new Set(result.acknowledgements.map((ack: { count: number }) => ack.count)).size).toBe(3);
    await waitForCompletions(2, "the trailing watcher listing never completed");
    const trailing = await listingProbe();
    expect(trailing.calls).toBe(2);
    for (const ack of result.acknowledgements) {
      expect(ack.origin).toBe("mutation");
      expect(ack.startedAt).toBeGreaterThanOrEqual(trailing.starts[0]);
      expect(ack.observedAt).toBeGreaterThanOrEqual(ack.startedAt);
      expect(ack.receivedAt).toBeLessThanOrEqual(trailing.finishes[0]);
      await browser.waitUntil(async () => (await entryNames()).includes(ack.filename), {
        timeoutMsg: `the trailing listing did not show ${ack.filename}`,
      });
    }
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
