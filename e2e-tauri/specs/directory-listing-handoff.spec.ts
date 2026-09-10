/** Initial listing and pane observation must form one lossless handoff. */
import { browser, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryNames } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-listing-handoff-"));
const observedDirectory = path.join(scratch, "first-observed");
const quietDirectory = path.join(scratch, "quiet-first-load");

interface ListingProbe {
  calls: number;
  completed: number;
  starts: number[];
  finishes: number[];
}

interface WriteAcknowledgement {
  filename: string;
  startedAt: number;
  receivedAt: number;
  observedAt: number;
  count: number;
}

interface WriteOperation {
  operation?: string;
  status?: string;
  acknowledgements?: WriteAcknowledgement[];
  error?: string;
}

async function waitForHooks(): Promise<void> {
  await browser.waitUntil(
    async () => await browser.execute(
      () => document.documentElement.dataset.e2eHooksReady === "true",
    ),
    { timeout: 15_000, timeoutMsg: "dev e2e hooks never became ready" },
  );
}

async function installListingProbe(targetPath: string, writeOperation?: string): Promise<void> {
  await browser.execute((target: string, operation?: string) => {
    window.dispatchEvent(new CustomEvent("e2e-directory-listing-probe", {
      detail: { targetPath: target, delays: [], writeOperation: operation },
    }));
  }, targetPath, writeOperation);
}

async function beginNavigation(targetPath: string): Promise<string> {
  const token = crypto.randomUUID();
  await browser.execute((target: string, navigationToken: string) => {
    delete document.documentElement.dataset.e2eNavigationComplete;
    window.dispatchEvent(new CustomEvent("e2e-reset-view"));
    window.dispatchEvent(new CustomEvent("e2e-navigate", {
      detail: { path: target, token: navigationToken },
    }));
  }, targetPath, token);
  return token;
}

async function waitForNavigation(token: string, targetPath: string): Promise<void> {
  await browser.waitUntil(
    async () => await browser.execute(
      (navigationToken: string) =>
        document.documentElement.dataset.e2eNavigationComplete === navigationToken,
      token,
    ),
    { timeout: 25_000, timeoutMsg: `navigation to ${targetPath} was not acknowledged` },
  );
}

async function listingProbe(): Promise<ListingProbe> {
  return await browser.execute(() => {
    const encoded = document.documentElement.dataset.e2eDirectoryListingProbe;
    return encoded
      ? JSON.parse(encoded)
      : { calls: -1, completed: -1, starts: [], finishes: [] };
  });
}

async function writeOperation(): Promise<WriteOperation> {
  return await browser.execute(() => {
    const encoded = document.documentElement.dataset.e2eWatcherWriteOperation;
    return encoded ? JSON.parse(encoded) : {};
  });
}

async function waitForListingCompletions(expected: number, context: string): Promise<void> {
  await browser.waitUntil(async () => (await listingProbe()).completed >= expected, {
    timeout: 25_000,
    timeoutMsg: context,
  });
}

async function waitForWatcherReady(targetPath: string): Promise<void> {
  await browser.waitUntil(
    async () => await browser.execute((target: string) => {
      const paths: string[] = JSON.parse(
        document.documentElement.dataset.e2eReadyDirectoryWatches ?? "[]",
      );
      return document.documentElement.dataset.e2eDirectoryWatcherListenerReady === "true"
        && paths.includes(target);
    }, targetPath),
    {
      timeout: 15_000,
      timeoutMsg: `directory observation was not ready for ${targetPath}`,
    },
  );
}

async function handoffDiagnostics(targetPath: string): Promise<Record<string, unknown>> {
  return await browser.execute((target: string) => {
    const data = document.documentElement.dataset;
    const receipts = JSON.parse(data.e2eDirectoryWatcherReceipts ?? "{}");
    return {
      listenerReady: data.e2eDirectoryWatcherListenerReady ?? null,
      readyPaths: JSON.parse(data.e2eReadyDirectoryWatches ?? "[]"),
      targetReceipt: receipts[target] ?? null,
      listing: JSON.parse(data.e2eDirectoryListingProbe ?? "null"),
      operation: JSON.parse(data.e2eWatcherWriteOperation ?? "null"),
    };
  }, targetPath);
}

describe("initial directory listing observation handoff", () => {
  before(() => {
    fs.mkdirSync(observedDirectory);
    fs.mkdirSync(quietDirectory);
    fs.writeFileSync(path.join(observedDirectory, "seed.txt"), "initial scan\n");
    fs.writeFileSync(path.join(quietDirectory, "quiet.txt"), "one scan\n");
  });

  afterEach(async () => {
    await browser.execute(() => {
      window.dispatchEvent(new CustomEvent("e2e-directory-listing-probe"));
    });
  });

  after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("observes writes made after the first scan but before its result is published", async () => {
    await waitForHooks();
    const operation = `handoff-${crypto.randomUUID().slice(0, 8)}`;
    await installListingProbe(observedDirectory, operation);
    const navigationToken = await beginNavigation(observedDirectory);

    await browser.waitUntil(async () => {
      const result = await writeOperation();
      return result.operation === operation;
    }, {
      timeout: 5_000,
      timeoutMsg: "the held first-listing write protocol never started",
    });
    const firstMarker = `${operation}-0.txt`;
    await browser.waitUntil(
      async () => fs.existsSync(path.join(observedDirectory, firstMarker)),
      {
        timeout: 5_000,
        timeoutMsg: "the first held-listing marker was not written to disk",
      },
    );
    const pendingDiagnostics = await handoffDiagnostics(observedDirectory);

    try {
      await browser.waitUntil(async () => {
        const result = await writeOperation();
        return result.operation === operation && result.status !== "running";
      }, {
        timeout: 22_000,
        timeoutMsg: "the held first-listing write protocol never settled",
      });
    } catch (error) {
      // WebKit reports the probe's rejected async task through execute/sync,
      // which can make the published terminal dataset temporarily unreadable.
      // Preserve the last pre-timeout state and rethrow the original failure.
      console.log(JSON.stringify({
        case: "initial-directory-listing-handoff-failure",
        firstMarker,
        firstMarkerOnDisk: true,
        ...pendingDiagnostics,
        terminalReadError: String(error),
      }));
      throw error;
    }

    const result = await writeOperation();
    console.log(JSON.stringify({
      case: "initial-directory-listing-handoff",
      ...await handoffDiagnostics(observedDirectory),
    }));
    expect(result.operation).toBe(operation);
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.acknowledgements).toHaveLength(3);
    expect(new Set(result.acknowledgements!.map(({ count }) => count)).size).toBe(3);
    for (const acknowledgement of result.acknowledgements!) {
      expect(acknowledgement.observedAt).toBeGreaterThanOrEqual(acknowledgement.startedAt);
      expect(acknowledgement.receivedAt).toBeGreaterThanOrEqual(acknowledgement.startedAt);
    }

    await waitForNavigation(navigationToken, observedDirectory);
    await waitForListingCompletions(2, "the pending writes did not cause one trailing listing");
    await browser.waitUntil(async () => {
      const names = await entryNames();
      return result.acknowledgements!.every(({ filename }) => names.includes(filename));
    }, {
      timeout: 20_000,
      timeoutMsg: "the trailing listing did not show every handoff marker",
    });

    // Stay on the observed target long enough for any rate-limited follow-up
    // watcher work to run; the three writes require one trailing scan only.
    await browser.pause(2_500);
    const settled = await listingProbe();
    expect(settled.calls).toBe(2);
    expect(settled.completed).toBe(2);
    for (const acknowledgement of result.acknowledgements!) {
      expect(acknowledgement.receivedAt).toBeLessThanOrEqual(settled.finishes[0]);
    }
    fs.mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
    await browser.saveScreenshot(
      "screenshots/refactor/repo-health-cleanup/native-directory-listing-handoff.png",
    );
  });

  it("uses one foreground scan when the first observed load stays quiet", async () => {
    await waitForHooks();
    await installListingProbe(quietDirectory);
    const navigationToken = await beginNavigation(quietDirectory);
    await waitForNavigation(navigationToken, quietDirectory);
    await waitForListingCompletions(1, "the quiet foreground listing did not complete");
    await waitForWatcherReady(quietDirectory);
    expect(await entryNames()).toContain("quiet.txt");

    // Any catch-up scheduled by the ordinary refresh policy runs within this
    // window. The fixture performs no mutation, so a second call is redundant.
    await browser.pause(2_500);
    const settled = await listingProbe();
    expect(settled.calls).toBe(1);
    expect(settled.completed).toBe(1);
  });
});
